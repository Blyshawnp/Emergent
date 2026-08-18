"""
Tests for verify_production_health and compare_shadow_provider
(shadow-read readiness verification).

Run from the backend/ directory:
    python -m unittest test_supabase_verify_shadow
"""
from __future__ import annotations

import datetime
import hashlib
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, call

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from tools.supabase_import.core import (
    verify_production_health,
    compare_shadow_provider,
    compare_shadow_resource,
    _fetch_with_retry,
    safe_upsert_lineage,
    REQUIRED_SHADOW_DOMAINS,
    SHADOW_DOMAIN_SPECS,
    APPROVED_HISTORICAL_HEADSET_REVIEW_EXCEPTIONS,
)
from data_providers.sheets import SheetsDataProvider, SNAPSHOT_TABS
from tools.supabase_import import cli as import_cli


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_provider(url="https://xyfhikikddcqcmzbdvbj.supabase.co"):
    """Return a MagicMock provider with a valid _url set."""
    p = MagicMock()
    p._url = url
    p._key = "test-service-role-key-longer-than-20-chars"
    p.lineage_write_mode = "rpc_only"
    # Default: every _request returns an empty list (table exists, no rows)
    p._request.return_value = []
    return p


def _healthy_provider():
    """Provider that passes all table/batch/count checks."""
    p = _make_provider()

    GOOD_BATCHES = [
        {"id": "9e830168-40c8-4e9a-9a38-2f907e45a29c", "status": "succeeded"},
        {"id": "da04bccb-982d-4a17-820a-4eaa06d23b8f", "status": "succeeded"},
        {"id": "99999999-9999-9999-9999-999999999999", "status": "rolled_back"},
    ]
    GOOD_RECON = [
        {
            "import_batch_id": "9e830168-40c8-4e9a-9a38-2f907e45a29c",
            "source_tab": "Candidate Sessions",
            "source_row_count": 358,
            "normalized_row_count": 220,
            "unresolved_row_count": 128,
            "duplicate_row_count": 4,
            "rejected_row_count": 6,
        }
    ]
    GOOD_HEADSET_REVIEWS = [
        {"id": f"r{i}", "session_id": None, "source_session_id": None}
        for i in range(10)
    ]  # 10 standalone historical

    def side_effect(path, *, query=None, **kwargs):
        if path == "import_batches":
            return GOOD_BATCHES
        if path == "reconciliation_results":
            return GOOD_RECON
        if path == "headset_reviews":
            return GOOD_HEADSET_REVIEWS
        # Everything else: return empty list (table exists)
        return []

    p._request.side_effect = side_effect
    return p


def _healthy_comparison():
    categories = {}
    for domain in REQUIRED_SHADOW_DOMAINS:
        categories[domain] = {
            "error_count": 0,
            "unexplained_difference_count": 0,
            "readiness": "ready",
        }
    return {
        "categories": categories,
        "not_implemented": [],
        "completed": True,
        "overall_readiness": "ready",
        "error_count": 0,
        "total_unexplained": 0,
        "sheets_snapshot_timestamp": "2026-08-04T00:00:00+00:00",
        "sheets_snapshot_checksum": "safe-checksum",
    }


def _domain_row(domain, suffix="1"):
    spec = SHADOW_DOMAIN_SPECS[domain]
    row = {}
    boolean_fields = {
        "enabled", "show_ticker", "show_popup", "show_banner", "persistent",
        "archived", "deleted", "withdrawn", "final_attempt", "counts_as_attempt",
    }
    integer_fields = {
        "attempt_number", "current_attempt_number", "allowed_attempt_count",
        "current_attempt", "resulting_attempt",
    }
    timestamp_fields = {
        "completed_at", "created_at", "occurred_at", "scheduled_at",
        "rescheduled_at", "original_scheduled_at", "decision_at",
        "starts_at", "ends_at",
    }
    for group in (spec.identity, spec.values, spec.statuses, spec.relationships, spec.attempts):
        for aliases in group:
            field = aliases[0]
            if field in row:
                continue
            if field in boolean_fields:
                row[field] = False
            elif field in integer_fields:
                row[field] = 1
            elif field in timestamp_fields:
                row[field] = "2026-08-03T12:00:00Z"
            elif field in {"status", "raw_status", "request_status", "completed_status"}:
                row[field] = "pending"
            else:
                row[field] = f"{field}-{suffix}"
    return row


# ---------------------------------------------------------------------------
# VerifyProductionHealthTests
# ---------------------------------------------------------------------------

class VerifyProductionHealthTests(unittest.TestCase):

    def test_correct_project_reference(self):
        """Correct project URL produces no project_ref error."""
        p = _healthy_provider()
        result = verify_production_health(p, comparison_result=_healthy_comparison())
        ref_check = next((c for c in result["checks"] if c["name"] == "project_ref"), None)
        self.assertIsNotNone(ref_check, "project_ref check must be present")
        self.assertTrue(ref_check["passed"], f"project_ref should pass; detail: {ref_check['detail']}")
        self.assertNotIn("project_ref", result["errors"])

    def test_wrong_project_reference(self):
        """Wrong project URL adds project_ref to errors, sets ok=False."""
        p = _make_provider(url="https://wrongproject.supabase.co")
        p._request.return_value = []
        result = verify_production_health(p, comparison_result=_healthy_comparison())
        self.assertFalse(result["ok"])
        self.assertIn("project_ref", result["errors"])

    def test_missing_required_table(self):
        """A required table that raises an error sets ok=False."""
        from data_providers.supabase import SupabaseProviderError

        p = _healthy_provider()
        original_side_effect = p._request.side_effect

        def side_effect_with_missing(path, *, query=None, **kwargs):
            if path == "candidates" and query and query.get("limit") == "1":
                raise SupabaseProviderError("relation does not exist")
            return original_side_effect(path, query=query)

        p._request.side_effect = side_effect_with_missing
        result = verify_production_health(p, comparison_result=_healthy_comparison())
        self.assertFalse(result["ok"])
        self.assertIn("table_candidates", result["errors"])

    def test_failed_batch_detected(self):
        """A batch with status='failed' sets ok=False."""
        p = _make_provider()

        def side_effect(path, *, query=None, **kwargs):
            if path == "import_batches":
                return [
                    {"id": "9e830168-40c8-4e9a-9a38-2f907e45a29c", "status": "succeeded"},
                    {"id": "da04bccb-982d-4a17-820a-4eaa06d23b8f", "status": "failed"},
                    {"id": "99999999-9999-9999-9999-999999999999", "status": "rolled_back"},
                ]
            if path == "reconciliation_results":
                return [{"source_row_count": 358, "normalized_row_count": 220,
                         "unresolved_row_count": 128, "duplicate_row_count": 4,
                         "rejected_row_count": 6}]
            return []

        p._request.side_effect = side_effect
        result = verify_production_health(p, comparison_result=_healthy_comparison())
        self.assertFalse(result["ok"])
        self.assertIn("no_failed_batches", result["errors"])

    def test_provider_not_sheets(self):
        """MTS_DATA_PROVIDER != 'sheets' is an ERROR."""
        p = _healthy_provider()
        with patch.dict(os.environ, {"MTS_DATA_PROVIDER": "supabase"}):
            result = verify_production_health(p, comparison_result=_healthy_comparison())
        self.assertFalse(result["ok"])
        self.assertIn("env_provider", result["errors"])

    def test_dual_writes_enabled(self):
        """MTS_DUAL_WRITE_ENABLED=true is an ERROR."""
        p = _healthy_provider()
        with patch.dict(os.environ, {"MTS_DUAL_WRITE_ENABLED": "true"}):
            result = verify_production_health(p, comparison_result=_healthy_comparison())
        self.assertFalse(result["ok"])
        self.assertIn("env_dual_write", result["errors"])

    def test_shadow_mode_enabled(self):
        p = _healthy_provider()
        with patch.dict(os.environ, {"MTS_SHADOW_COMPARE": "true"}):
            result = verify_production_health(p, comparison_result=_healthy_comparison())
        self.assertTrue(result["shadow_read_mapped_domains_ready"])
        self.assertNotIn("env_shadow_mode", result["errors"])

    def test_malformed_shadow_mode_value_fails_closed(self):
        p = _healthy_provider()
        with patch.dict(os.environ, {"MTS_SHADOW_COMPARE": "sometimes"}):
            result = verify_production_health(p, comparison_result=_healthy_comparison())
        self.assertFalse(result["shadow_read_mapped_domains_ready"])
        self.assertIn("env_shadow_mode", result["errors"])

    def test_rpc_method_without_rpc_only_provider_contract_is_rejected(self):
        p = _healthy_provider()
        p.lineage_write_mode = "table_upsert"
        result = verify_production_health(p, comparison_result=_healthy_comparison())
        self.assertFalse(result["shadow_read_mapped_domains_ready"])
        self.assertIn("lineage_rpc_provider_method", result["errors"])

    def test_source_accounting_mismatch(self):
        """Reconciliation parts don't sum to source count → ERROR."""
        p = _make_provider()

        def side_effect(path, *, query=None, **kwargs):
            if path == "import_batches":
                return [
                    {"id": "9e830168-40c8-4e9a-9a38-2f907e45a29c", "status": "succeeded"},
                    {"id": "da04bccb-982d-4a17-820a-4eaa06d23b8f", "status": "succeeded"},
                    {"id": "99999999-9999-9999-9999-999999999999", "status": "rolled_back"},
                ]
            if path == "reconciliation_results":
                # Parts sum to 300, not 358
                return [{"source_row_count": 358, "normalized_row_count": 200,
                         "unresolved_row_count": 50, "duplicate_row_count": 3,
                         "rejected_row_count": 5}]
            return []

        p._request.side_effect = side_effect
        result = verify_production_health(p, comparison_result=_healthy_comparison())
        self.assertFalse(result["ok"])
        self.assertIn("recon_totals", result["errors"])

    def test_warnings_only_still_ok(self):
        """Only warnings (unmapped tabs, unresolved headset) → ok still True."""
        p = _healthy_provider()
        # Add 1 unresolved headset link to trigger the WARNING
        headset_reviews_with_unresolved = [
            {"id": f"r{i}", "session_id": None, "source_session_id": None}
            for i in range(10)
        ] + [{"id": "r10", "session_id": None, "source_session_id": "session-abc"}]

        original = p._request.side_effect

        def side_effect_with_warning(path, *, query=None, **kwargs):
            if path == "headset_reviews":
                return headset_reviews_with_unresolved
            return original(path, query=query)

        p._request.side_effect = side_effect_with_warning
        result = verify_production_health(p, comparison_result=_healthy_comparison())
        # unmapped_tabs and sam_authorized_users_rejected are always warnings
        # headset_review_links is a warning
        # ok should still be True if only warnings
        self.assertTrue(result["ok"], f"Expected ok=True with only warnings; errors={result['errors']}")

    def test_full_cutover_always_false(self):
        """full_cutover_ready must always be False."""
        p = _healthy_provider()
        result = verify_production_health(p, comparison_result=_healthy_comparison())
        self.assertFalse(result["full_cutover_ready"])

    def test_shadow_read_ready_when_no_errors(self):
        """No errors → shadow_read_mapped_domains_ready=True."""
        p = _healthy_provider()
        result = verify_production_health(p, comparison_result=_healthy_comparison())
        if not result["errors"]:
            self.assertTrue(result["shadow_read_mapped_domains_ready"])

    def test_compare_not_run_cannot_claim_readiness(self):
        result = verify_production_health(_healthy_provider(), comparison_result=None)
        self.assertFalse(result["shadow_read_mapped_domains_ready"])
        self.assertFalse(result["ok"])
        self.assertIn("shadow_comparison_current", result["errors"])

    def test_one_missing_domain_cannot_claim_readiness(self):
        comparison = _healthy_comparison()
        comparison["categories"].pop("history")
        result = verify_production_health(_healthy_provider(), comparison_result=comparison)
        self.assertFalse(result["shadow_read_mapped_domains_ready"])
        self.assertIn("shadow_comparison_current", result["errors"])

    def test_unresolved_headset_link_is_warning(self):
        """1 review with source_session_id but no session_id → WARNING, ok still True."""
        p = _healthy_provider()
        mixed_reviews = (
            [{"id": f"r{i}", "session_id": None, "source_session_id": None} for i in range(10)]
            + [{"id": "r10", "session_id": None, "source_session_id": "sess-xyz"}]
        )
        original = p._request.side_effect

        def side_effect_with_unresolved(path, *, query=None, **kwargs):
            if path == "headset_reviews":
                return mixed_reviews
            return original(path, query=query)

        p._request.side_effect = side_effect_with_unresolved
        result = verify_production_health(p, comparison_result=_healthy_comparison())
        # headset_review_links should be in warnings
        self.assertIn("headset_review_links", result["warnings"])
        # Should not be an ERROR
        self.assertNotIn("headset_review_links", result["errors"])

    def test_no_errors_on_all_healthy(self):
        """Happy path: all tables, batches, accounting correct → ok=True."""
        p = _healthy_provider()
        result = verify_production_health(p, comparison_result=_healthy_comparison())
        self.assertIsInstance(result, dict)
        self.assertIn("ok", result)
        self.assertIn("checks", result)
        self.assertIn("errors", result)
        self.assertIn("warnings", result)
        # With healthy mocks there should be no errors
        self.assertEqual(result["errors"], [], f"Unexpected errors: {result['errors']}")
        self.assertTrue(result["ok"])

    def test_result_is_never_exception(self):
        """Even with repeated provider failures, function returns dict, not raises."""
        p = _make_provider()
        p._request.side_effect = RuntimeError("total connectivity failure")
        # Should not raise
        result = verify_production_health(p, comparison_result=_healthy_comparison())
        self.assertIsInstance(result, dict)
        self.assertIn("ok", result)


# ---------------------------------------------------------------------------
# CompareShadowProviderTests
# ---------------------------------------------------------------------------

class CompareShadowProviderTests(unittest.TestCase):

    def _make_sheets(self, rows_by_resource=None):
        sheets = MagicMock()
        sheets.snapshot_metadata = {
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "checksum": "a" * 64,
            "fetch_count": 1,
            "retry_count": 0,
            "errors": {},
        }
        rows_by_resource = rows_by_resource or {}
        sheets.list_resource.side_effect = lambda resource, limit=5000: rows_by_resource.get(resource, [])
        return sheets

    def _make_supabase(self, rows_by_resource=None):
        sup = MagicMock()
        sup._url = "https://xyfhikikddcqcmzbdvbj.supabase.co"
        sup.lineage_write_mode = "rpc_only"
        rows_by_resource = rows_by_resource or {}
        sup.list_resource.side_effect = lambda resource, limit=5000: rows_by_resource.get(resource, [])
        return sup

    def test_empty_both_is_zero_mismatch(self):
        """Both sheets and supabase return empty → mismatches = 0."""
        sheets = self._make_sheets()
        sup = self._make_supabase()
        result = compare_shadow_provider(sheets, sup)
        self.assertEqual(result["mismatch_count"], 0)
        self.assertIn("overall_readiness", result)

    def test_exact_match_one_domain(self):
        """Exact match on candidate_sessions → no mismatches for that domain."""
        rows = [{"session_id": "s-1"}, {"session_id": "s-2"}]
        sheets = self._make_sheets({"candidate_sessions": rows})
        sup = self._make_supabase({"candidate_sessions": rows})
        result = compare_shadow_provider(sheets, sup)
        cat = result["categories"]["candidate_sessions"]
        self.assertEqual(cat["missing_in_supabase_count"], 0)
        self.assertEqual(cat["missing_in_sheets_count"], 0)

    def test_missing_in_supabase(self):
        """Sheets has session X, supabase does not → missing_in_supabase_count > 0."""
        sheets_rows = [{"session_id": "s-1"}, {"session_id": "s-2"}]
        sup_rows = [{"session_id": "s-1"}]
        sheets = self._make_sheets({"candidate_sessions": sheets_rows})
        sup = self._make_supabase({"candidate_sessions": sup_rows})
        result = compare_shadow_provider(sheets, sup)
        cat = result["categories"]["candidate_sessions"]
        self.assertGreater(cat["missing_in_supabase_count"], 0)

    def test_missing_in_sheets(self):
        """Supabase has extra record not in sheets → missing_in_sheets_count > 0."""
        sheets_rows = [{"session_id": "s-1"}]
        sup_rows = [{"session_id": "s-1"}, {"session_id": "s-extra"}]
        sheets = self._make_sheets({"candidate_sessions": sheets_rows})
        sup = self._make_supabase({"candidate_sessions": sup_rows})
        result = compare_shadow_provider(sheets, sup)
        cat = result["categories"]["candidate_sessions"]
        self.assertGreater(cat["missing_in_sheets_count"], 0)

    def test_domain_exception_is_captured_not_swallowed(self):
        """When sheets raises for one domain, error_count is set, other domains continue."""
        sheets = MagicMock()
        sheets.list_resource.side_effect = lambda res, limit=5000: (
            []  # all other domains succeed
        )
        sheets.list_resource.side_effect = lambda res, limit=5000: (
            (_ for _ in ()).throw(RuntimeError("simulated sheets failure"))
            if res == "candidate_sessions" else []
        )
        sup = self._make_supabase()
        result = compare_shadow_provider(sheets, sup)
        cat = result["categories"]["candidate_sessions"]
        self.assertGreater(cat["error_count"], 0)
        # Other domains should still be present in categories
        self.assertIn("headset_catalog", result["categories"])

    def test_quota_error_captured(self):
        """A 429/quota error from sheets → domain errors contain quota message."""
        sheets = MagicMock()
        sheets.list_resource.side_effect = RuntimeError("429 Quota exceeded")
        sup = self._make_supabase()
        result = compare_shadow_provider(sheets, sup)
        # All domains fail with quota
        for domain_name, cat in result["categories"].items():
            self.assertGreater(cat["error_count"], 0)
        self.assertIn(result["overall_readiness"], ("blocked_by_quota", "error"))

    def test_all_required_domains_are_implemented(self):
        sheets = self._make_sheets()
        sup = self._make_supabase()
        result = compare_shadow_provider(sheets, sup)
        self.assertEqual(result["not_implemented"], [])
        self.assertEqual(set(result["categories"]), set(REQUIRED_SHADOW_DOMAINS))

    def test_runtime_resource_comparison_fetches_only_requested_domain(self):
        row = _domain_row("notifications")
        sheets = self._make_sheets({"notifications": [row]})
        supabase = self._make_supabase({"notifications": [row]})
        result = compare_shadow_resource(sheets, supabase, "notifications")
        self.assertEqual(set(result["categories"]), {"notifications"})
        self.assertEqual(result["overall_readiness"], "ready")
        sheets.list_resource.assert_called_once_with("notifications", limit=5000)
        supabase.list_resource.assert_called_once_with("notifications", limit=5000)

    def test_runtime_resource_comparison_rejects_unknown_domain(self):
        with self.assertRaisesRegex(ValueError, "Unsupported or empty shadow comparison domain set"):
            compare_shadow_resource(self._make_sheets(), self._make_supabase(), "auth")

    def test_runtime_resource_comparison_never_invokes_write_or_reconciliation_methods(self):
        row = _domain_row("notifications")
        sheets = self._make_sheets({"notifications": [row]})
        supabase = self._make_supabase({"notifications": [row]})
        for name in ("create_resource", "update_resource", "delete_resource"):
            setattr(sheets, name, MagicMock(side_effect=AssertionError(name)))
        for name in (
            "upsert_rows", "insert_lineage_if_absent", "begin_reconciliation_execution",
            "execute_reconciliation_insert", "rollback_reconciliation_batch",
        ):
            setattr(supabase, name, MagicMock(side_effect=AssertionError(name)))
        compare_shadow_resource(sheets, supabase, "notifications")
        for provider, names in (
            (sheets, ("create_resource", "update_resource", "delete_resource")),
            (supabase, (
                "upsert_rows", "insert_lineage_if_absent", "begin_reconciliation_execution",
                "execute_reconciliation_insert", "rollback_reconciliation_batch",
            )),
        ):
            for name in names:
                getattr(provider, name).assert_not_called()

    def test_aggregate_mismatch_count(self):
        """mismatch_count aggregates across all domains."""
        sheets_rows = [{"session_id": "s-1"}]
        sup_rows = [{"session_id": "s-2"}]
        sheets = self._make_sheets({"candidate_sessions": sheets_rows})
        sup = self._make_supabase({"candidate_sessions": sup_rows})
        result = compare_shadow_provider(sheets, sup)
        self.assertGreater(result["mismatch_count"], 0)

    def test_overall_readiness_ready(self):
        """All mapped domains exact match → overall_readiness == 'ready'."""
        rows = [{"session_id": "s-1"}]
        sheets = self._make_sheets({"candidate_sessions": rows, "candidates": [], "headset_catalog": [],
                                    "headset_reviews": [], "supervisor_transfers": [], "newbie_shift_requests": [],
                                    "candidate_corrections": [], "notifications": [], "pending_requests": [],
                                    "recent_activity": []})
        sup = self._make_supabase({"candidate_sessions": rows, "candidates": [], "headset_catalog": [],
                                    "headset_reviews": [], "supervisor_transfers": [], "newbie_shift_requests": [],
                                    "candidate_corrections": [], "notifications": [], "pending_requests": [],
                                    "recent_activity": []})
        result = compare_shadow_provider(sheets, sup)
        self.assertEqual(result["overall_readiness"], "ready")

    def test_rpc_method_without_rpc_only_contract_cannot_return_ready(self):
        sheets = self._make_sheets()
        sup = self._make_supabase()
        sup.lineage_write_mode = "table_upsert"
        result = compare_shadow_provider(sheets, sup)
        self.assertFalse(result["lineage_rpc_path_verified"])
        self.assertIn("lineage_rpc_path_inactive", result["invariant_errors"])
        self.assertNotEqual(result["overall_readiness"], "ready")

    def test_stale_snapshot_cannot_return_ready(self):
        sheets = self._make_sheets()
        sheets.snapshot_metadata["timestamp"] = "2020-01-01T00:00:00+00:00"
        result = compare_shadow_provider(sheets, self._make_supabase())
        self.assertIn("snapshot_contract_incomplete", result["invariant_errors"])
        self.assertFalse(result["completed"])
        self.assertNotEqual(result["overall_readiness"], "ready")

    def test_absent_lazy_boolean_matches_explicit_false(self):
        left = _domain_row("authoritative_candidate_status")
        right = dict(left)
        left.pop("archived")
        left.pop("final_attempt")
        right["archived"] = False
        right["final_attempt"] = False
        rows = {"authoritative_candidate_status": [left]}
        sup_rows = {"authoritative_candidate_status": [right]}
        result = compare_shadow_provider(self._make_sheets(rows), self._make_supabase(sup_rows))
        item = result["categories"]["authoritative_candidate_status"]
        self.assertEqual(item["status_mismatch_count"], 0)
        self.assertEqual(item["attempt_mismatch_count"], 0)

    def test_status_normalization_only_collapses_equivalent_business_labels(self):
        rows = {"authoritative_candidate_status": [{
            "session_id": "s-1", "authoritative_status": "Pass",
        }]}
        sup_rows = {"authoritative_candidate_status": [{
            "session_id": "s-1", "authoritative_status": "RESUMED-PASS",
        }]}
        result = compare_shadow_provider(self._make_sheets(rows), self._make_supabase(sup_rows))
        self.assertEqual(result["categories"]["authoritative_candidate_status"]["status_mismatch_count"], 0)

        sup_rows["authoritative_candidate_status"][0]["authoritative_status"] = "NC/NS"
        result = compare_shadow_provider(self._make_sheets(rows), self._make_supabase(sup_rows))
        self.assertEqual(result["categories"]["authoritative_candidate_status"]["status_mismatch_count"], 1)

    def test_overall_readiness_not_ready(self):
        """At least one unexplained difference → overall_readiness == 'not_ready'."""
        sheets_rows = [{"session_id": "s-1"}, {"session_id": "s-2"}]
        sup_rows = [{"session_id": "s-1"}]
        sheets = self._make_sheets({"candidate_sessions": sheets_rows})
        sup = self._make_supabase({"candidate_sessions": sup_rows})
        result = compare_shadow_provider(sheets, sup)
        self.assertEqual(result["overall_readiness"], "not_ready")

    def test_unapproved_standalone_headset_review_is_not_suppressed(self):
        sup_reviews = [
            {"review_id": "r-1", "normalization_status": "unresolved_legacy_brand",
             "session_id": None, "source_session_id": None},
        ]
        sheets_reviews = [{"review_id": "r-1"}]
        sheets = self._make_sheets({"headset_reviews": sheets_reviews})
        sup = self._make_supabase({"headset_reviews": sup_reviews})
        result = compare_shadow_provider(sheets, sup)
        cat = result["categories"]["headset_reviews"]
        self.assertEqual(cat["expected_difference_count"], 0)
        self.assertGreater(cat["unexplained_difference_count"], 0)

    def test_unapproved_standalone_headset_status_mismatch_is_unexplained(self):
        sheets_review = {
            "review_id": "r-standalone", "status": "pending",
            "session_id": None, "source_session_id": None,
        }
        supabase_review = {
            **sheets_review, "status": "approved",
        }
        result = compare_shadow_provider(
            self._make_sheets({"headset_reviews": [sheets_review]}),
            self._make_supabase({"headset_reviews": [supabase_review]}),
        )
        cat = result["categories"]["headset_reviews"]
        self.assertEqual(cat["status_mismatch_count"], 1)
        self.assertEqual(cat["expected_difference_count"], 0)
        self.assertGreater(cat["unexplained_difference_count"], 0)
        self.assertEqual(cat["readiness"], "not_ready")

    def test_unapproved_unresolved_headset_session_is_unexplained(self):
        review = {
            "review_id": "r-unresolved",
            "session_id": None,
            "source_session_id": "source-session-without-lineage",
        }
        result = compare_shadow_provider(
            self._make_sheets({"headset_reviews": [review]}),
            self._make_supabase({"headset_reviews": [review]}),
        )
        cat = result["categories"]["headset_reviews"]
        self.assertEqual(cat["relationship_mismatch_count"], 1)
        self.assertEqual(cat["expected_difference_count"], 0)
        self.assertGreater(cat["unexplained_difference_count"], 0)
        self.assertEqual(cat["readiness"], "not_ready")

    def test_allowlisted_headset_manifestations_are_expected(self):
        sheets_review = {
            "review_id": "r-approved", "status": "approved",
            "session_id": None, "source_session_id": "approved-source-session",
        }
        supabase_review = {**sheets_review, "status": "pending"}
        safe_hash = hashlib.sha256(b"headset_reviews:r-approved").hexdigest()
        with patch.dict(APPROVED_HISTORICAL_HEADSET_REVIEW_EXCEPTIONS, {
            safe_hash: {
                "source_status": "approved",
                "target_status": "pending",
                "allow_relationship": True,
            },
        }, clear=True):
            result = compare_shadow_provider(
                self._make_sheets({"headset_reviews": [sheets_review]}),
                self._make_supabase({"headset_reviews": [supabase_review]}),
            )
        cat = result["categories"]["headset_reviews"]
        self.assertEqual(cat["status_mismatch_count"], 1)
        self.assertEqual(cat["relationship_mismatch_count"], 1)
        self.assertEqual(cat["expected_difference_count"], 1)
        self.assertEqual(cat["unexplained_difference_count"], 0)
        self.assertEqual(cat["readiness"], "ready")

    def test_result_has_required_keys(self):
        """Result always contains required top-level keys."""
        sheets = self._make_sheets()
        sup = self._make_supabase()
        result = compare_shadow_provider(sheets, sup)
        for key in ("mismatch_count", "total_unexplained", "error_count",
                    "sheets_snapshot_timestamp", "categories", "not_implemented",
                    "overall_readiness"):
            self.assertIn(key, result, f"Missing key: {key}")

    def test_all_fourteen_domains_exact_match_and_contract_fields(self):
        rows = {domain: [_domain_row(domain)] for domain in REQUIRED_SHADOW_DOMAINS}
        result = compare_shadow_provider(self._make_sheets(rows), self._make_supabase(rows))
        self.assertEqual(result["overall_readiness"], "ready")
        for domain in REQUIRED_SHADOW_DOMAINS:
            with self.subTest(domain=domain):
                item = result["categories"][domain]
                self.assertEqual(item["exact_match_count"], 1)
                for field in (
                    "sheets_count", "supabase_count", "exact_match_count",
                    "missing_in_supabase_count", "missing_in_sheets_count",
                    "identity_mismatch_count", "value_mismatch_count",
                    "status_mismatch_count", "relationship_mismatch_count",
                    "attempt_mismatch_count", "duplicate_identity_count",
                    "expected_difference_count", "unexplained_difference_count",
                    "error_count", "readiness",
                ):
                    self.assertIn(field, item)

    def test_each_domain_missing_and_duplicate_fail_closed(self):
        for domain in REQUIRED_SHADOW_DOMAINS:
            with self.subTest(domain=domain):
                row = _domain_row(domain)
                sheets_rows = {name: [] for name in REQUIRED_SHADOW_DOMAINS}
                supabase_rows = {name: [] for name in REQUIRED_SHADOW_DOMAINS}
                sheets_rows[domain] = [row, dict(row)]
                result = compare_shadow_provider(self._make_sheets(sheets_rows), self._make_supabase(supabase_rows))
                item = result["categories"][domain]
                self.assertEqual(item["missing_in_supabase_count"], 1)
                self.assertEqual(item["duplicate_identity_count"], 1)
                if domain != "newbie_shift_requests":
                    self.assertEqual(item["readiness"], "not_ready")

    def test_each_applicable_mismatch_group_is_counted(self):
        group_expectations = (
            ("values", "value_mismatch_count"),
            ("statuses", "status_mismatch_count"),
            ("relationships", "relationship_mismatch_count"),
            ("attempts", "attempt_mismatch_count"),
        )
        for domain in REQUIRED_SHADOW_DOMAINS:
            spec = SHADOW_DOMAIN_SPECS[domain]
            for group_name, result_field in group_expectations:
                fields = getattr(spec, group_name)
                if not fields:
                    continue
                with self.subTest(domain=domain, group=group_name):
                    left = _domain_row(domain)
                    right = dict(left)
                    identity_aliases = {alias for aliases in spec.identity for alias in aliases}
                    comparable_group = next(
                        (aliases for aliases in fields if aliases[0] not in identity_aliases),
                        fields[0],
                    )
                    field = comparable_group[0]
                    if field in identity_aliases:
                        continue
                    right[field] = not right[field] if isinstance(right[field], bool) else f"different-{field}"
                    rows = {name: [] for name in REQUIRED_SHADOW_DOMAINS}
                    sup_rows = {name: [] for name in REQUIRED_SHADOW_DOMAINS}
                    rows[domain] = [left]
                    sup_rows[domain] = [right]
                    result = compare_shadow_provider(self._make_sheets(rows), self._make_supabase(sup_rows))
                    self.assertEqual(result["categories"][domain][result_field], 1)
                    self.assertEqual(result["categories"][domain]["readiness"], "not_ready")

    def test_each_domain_error_is_structured_and_nonready(self):
        for failing_domain in REQUIRED_SHADOW_DOMAINS:
            with self.subTest(domain=failing_domain):
                sheets = MagicMock()
                sheets.list_resource.side_effect = lambda resource, limit=5000: (
                    (_ for _ in ()).throw(RuntimeError("private failure detail"))
                    if resource == failing_domain else []
                )
                result = compare_shadow_provider(sheets, self._make_supabase())
                item = result["categories"][failing_domain]
                self.assertEqual(item["error_count"], 1)
                self.assertEqual(item["errors"], ["unexpected_exception"])
                self.assertEqual(item["readiness"], "error")
                self.assertNotEqual(result["overall_readiness"], "ready")


# ---------------------------------------------------------------------------
# SheetsRetryTests
# ---------------------------------------------------------------------------

class SheetsRetryTests(unittest.TestCase):

    def test_first_request_success(self):
        """No exception on first call → result returned, no retries."""
        call_count = [0]

        def fetch():
            call_count[0] += 1
            return ["row"]

        result, err = _fetch_with_retry(fetch, "test", max_retries=3, base_delay=0.0)
        self.assertEqual(result, ["row"])
        self.assertIsNone(err)
        self.assertEqual(call_count[0], 1)

    def test_transient_429_then_success(self):
        """First call raises 429-like error, second succeeds."""
        call_count = [0]

        def fetch():
            call_count[0] += 1
            if call_count[0] == 1:
                raise RuntimeError("HTTP 429 rate limit exceeded")
            return ["row"]

        result, err = _fetch_with_retry(fetch, "test", max_retries=3, base_delay=0.001)
        self.assertEqual(result, ["row"])
        self.assertIsNone(err)
        self.assertEqual(call_count[0], 2)

    def test_repeated_429_exhaustion(self):
        """All retries fail with 429 → returns None + error dict with code='quota_exhausted'."""
        def fetch():
            raise RuntimeError("429 Quota exceeded")

        result, err = _fetch_with_retry(fetch, "test", max_retries=2, base_delay=0.001)
        self.assertIsNone(result)
        self.assertIsNotNone(err)
        self.assertEqual(err["code"], "quota_exhausted")

    def test_non_quota_error_not_retried(self):
        """Non-quota error → returns error immediately without retry."""
        call_count = [0]

        def fetch():
            call_count[0] += 1
            raise ValueError("schema validation error")

        result, err = _fetch_with_retry(fetch, "test", max_retries=3, base_delay=0.001)
        self.assertIsNone(result)
        self.assertIsNotNone(err)
        self.assertEqual(call_count[0], 1, "Non-quota error must not be retried")

    def test_bounded_max_retries(self):
        """At most max_retries+1 calls are made."""
        call_count = [0]

        def fetch():
            call_count[0] += 1
            raise RuntimeError("429 quota exceeded always")

        _fetch_with_retry(fetch, "test", max_retries=3, base_delay=0.001)
        self.assertEqual(call_count[0], 4, f"Expected 4 calls (1 + 3 retries), got {call_count[0]}")


class SheetsSnapshotProviderTests(unittest.TestCase):

    @staticmethod
    def _payload(action):
        if action != "batchGetSheetRanges":
            raise AssertionError(f"unexpected snapshot action: {action}")
        return {"valueRanges": [
            {"range": f"'{title}'!A:ZZ", "values": []}
            for title in SNAPSHOT_TABS
        ]}

    def test_one_cached_fetch_sequence_serves_all_fourteen_domains(self):
        client = MagicMock()
        client.get.side_effect = lambda action, _params=None: self._payload(action)
        provider = SheetsDataProvider(client, base_delay=0)
        for domain in REQUIRED_SHADOW_DOMAINS:
            provider.list_resource(domain, limit=5000)
        self.assertEqual(client.get.call_count, 1)
        self.assertEqual(provider.snapshot_metadata["fetch_count"], 1)
        self.assertEqual(provider.snapshot_metadata["retry_count"], 0)
        self.assertRegex(provider.snapshot_metadata["checksum"], r"^[0-9a-f]{64}$")

    def test_transient_quota_retry_is_bounded_and_counted(self):
        client = MagicMock()
        attempts = {"batchGetSheetRanges": 0}
        def side_effect(action, _params=None):
            if action == "batchGetSheetRanges":
                attempts[action] += 1
                if attempts[action] == 1:
                    raise RuntimeError("429 quota exceeded")
            return self._payload(action)
        client.get.side_effect = side_effect
        provider = SheetsDataProvider(client, max_retries=2, base_delay=0)
        provider.list_resource("candidate_sessions", limit=5000)
        self.assertEqual(attempts["batchGetSheetRanges"], 2)
        self.assertEqual(provider.snapshot_metadata["retry_count"], 1)

    def test_quota_exhaustion_does_not_become_empty_success(self):
        client = MagicMock()
        client.get.side_effect = lambda action, _params=None: (
            (_ for _ in ()).throw(RuntimeError("429 quota exceeded"))
            if action == "batchGetSheetRanges" else self._payload(action)
        )
        provider = SheetsDataProvider(client, max_retries=1, base_delay=0)
        with self.assertRaisesRegex(RuntimeError, "sheets_quota_exhausted"):
            provider.list_resource("candidate_sessions", limit=5000)

    def test_correction_projection_does_not_derive_candidate_identity_from_name(self):
        provider = SheetsDataProvider(MagicMock())
        provider._snapshot = {}
        provider._tabs = {
            "Candidate Sessions": [{"session_id": "session-1", "candidate_name": "Candidate One"}],
            "newbie-shift-requests": [],
            "candidate-deletion-requests": [],
            "candidate-information-correction-requests": [
                {"request_id": "r-1", "source_session_id": "session-1", "candidate_name": "Candidate One"},
                {"request_id": "r-2", "source_session_id": "missing", "candidate_name": "Missing Candidate"},
            ],
        }
        rows = provider.list_resource("candidate_corrections", limit=5000)
        self.assertTrue(rows[0]["canonical_session_id"])
        self.assertEqual(rows[0]["candidate_id"], "")
        self.assertEqual(rows[1]["canonical_session_id"], "")
        self.assertEqual(rows[1]["candidate_id"], "")


class CliExitCodeTests(unittest.TestCase):

    @patch("builtins.print")
    def test_compare_shadow_nonready_is_nonzero(self, _print):
        with patch.object(import_cli, "_sheets_client", return_value=MagicMock()), \
             patch.object(import_cli, "_supabase_client", return_value=MagicMock()), \
             patch.object(import_cli, "compare_shadow_provider", return_value={"overall_readiness": "not_ready", "completed": True}):
            self.assertEqual(import_cli.compare_shadow_cmd(MagicMock(diagnostic=False)), 1)

    @patch("builtins.print")
    def test_verify_production_requires_honest_mapped_readiness(self, _print):
        provider = MagicMock()
        comparison = {"overall_readiness": "ready", "completed": True}
        with patch.object(import_cli, "_sheets_client", return_value=MagicMock()), \
             patch.object(import_cli, "_supabase_client", return_value=provider), \
             patch.object(import_cli, "compare_shadow_provider", return_value=comparison), \
             patch.object(import_cli, "verify_production_health", return_value={"ok": True, "shadow_read_mapped_domains_ready": False}):
            self.assertEqual(import_cli.verify_production_cmd(MagicMock()), 1)


# ---------------------------------------------------------------------------
# Lineage RPC outcome handling (mocked; not a hosted concurrency claim)
# ---------------------------------------------------------------------------

class LineageRpcOutcomeTests(unittest.TestCase):

    SAMPLE_ROW = {
        "entity_type": "candidates", "entity_id": "uuid-1111-1111-1111",
        "source_system": "google_sheets", "source_tab": "Candidate Sessions",
        "source_row_key": "candidate:example", "source_checksum": "abc123",
        "import_batch_id": "batch-abc", "metadata": {},
    }

    def test_mixed_batch_is_deterministically_accounted(self):
        provider = MagicMock()
        provider.insert_lineage_if_absent.side_effect = [
            {"result": "inserted"},
            {"result": "already_exists_same_mapping"},
            {"result": "conflict_source_maps_to_different_entity"},
            {"result": "conflict_entity_maps_to_different_source"},
        ]
        result = safe_upsert_lineage(provider, [dict(self.SAMPLE_ROW) for _ in range(4)])
        self.assertEqual(result["processed"], 4)
        self.assertEqual(result["inserted"], 1)
        self.assertEqual(result["already_exists_same_mapping"], 1)
        self.assertEqual(len(result["conflicts"]), 2)
        provider.upsert_rows.assert_not_called()

# ---------------------------------------------------------------------------
# Least-Privilege Shadow Access Tests
# ---------------------------------------------------------------------------

class LeastPrivilegeShadowAccessTests(unittest.TestCase):

    def test_provider_initialization_with_anon_key(self):
        from data_providers.supabase import SupabaseDataProvider
        p = SupabaseDataProvider("https://xyfhikikddcqcmzbdvbj.supabase.co", "anon-key-12345")
        self.assertEqual(repr(p), "SupabaseDataProvider(configured=True)")

    def test_health_check_falls_back_to_ping_rpc_when_table_access_denied(self):
        from data_providers.supabase import SupabaseDataProvider, SupabaseProviderError
        p = SupabaseDataProvider("https://xyfhikikddcqcmzbdvbj.supabase.co", "anon-key-12345")
        def mock_req(path, **kwargs):
            if path == "sync_state":
                raise SupabaseProviderError("permission denied for table sync_state")
            if path == "rpc/get_shadow_readiness_ping":
                return {"ok": True, "mode": "least_privilege_shadow", "status": "ready"}
            raise SupabaseProviderError("unexpected path")
        p._request = MagicMock(side_effect=mock_req)
        health = p.health()
        self.assertTrue(health.ok)
        self.assertIn("least_privilege_shadow", health.detail)

    def test_list_resource_uses_shadow_rpc(self):
        from data_providers.supabase import SupabaseDataProvider
        p = SupabaseDataProvider("https://xyfhikikddcqcmzbdvbj.supabase.co", "anon-key-12345")
        p._request = MagicMock(return_value=[{"id": "s1", "candidate_name": "Test Candidate"}])
        rows = p.list_resource("candidate_sessions", limit=50)
        self.assertEqual(len(rows), 1)
        p._request.assert_called_with(
            "rpc/get_shadow_domain_data",
            method="POST",
            body={"p_domain": "candidate_sessions", "p_limit": 50, "p_offset": 0}
        )

    def test_readonly_facade_uses_candidate_lineage_rpc_fallback(self):
        from data_providers.supabase import SupabaseDataProvider, SupabaseProviderError
        from data_providers.runtime_shadow import ReadOnlySupabaseShadowProvider
        p = SupabaseDataProvider("https://xyfhikikddcqcmzbdvbj.supabase.co", "anon-key-12345")
        def mock_req(path, **kwargs):
            if path == "data_source_lineage":
                raise SupabaseProviderError("permission denied for table data_source_lineage")
            if path == "rpc/get_shadow_domain_data":
                return [{"entity_type": "candidates", "entity_id": "c1", "source_row_key": "k1"}]
            raise SupabaseProviderError("unexpected path")
        p._request = MagicMock(side_effect=mock_req)
        facade = ReadOnlySupabaseShadowProvider(p)
        res = facade._request("data_source_lineage")
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0]["entity_id"], "c1")

    def test_build_runtime_shadow_providers_prefers_anon_key(self):
        from data_providers.runtime_shadow import build_runtime_shadow_providers, ShadowRuntimeConfig
        with patch("services.apps_script_api.load_apps_script_api_config", return_value=({"test": True}, {"status": "ok"})), \
             patch("services.apps_script_api.AppsScriptApiClient", return_value=MagicMock()):
            env = {
                "MTS_DATA_PROVIDER": "sheets",
                "MTS_SHADOW_COMPARE": "true",
                "MTS_DUAL_WRITE_ENABLED": "false",
                "SUPABASE_URL": "https://xyfhikikddcqcmzbdvbj.supabase.co",
                "SUPABASE_ANON_KEY": "anon-publishable-key",
                "SUPABASE_SERVICE_ROLE_KEY": "service-role-admin-key",
            }
            sheets, shadow_sup = build_runtime_shadow_providers(Path("backend"), "mts", ShadowRuntimeConfig(), env)
            self.assertEqual(shadow_sup._provider._key, "anon-publishable-key")

    def test_factory_supports_anon_key_fallback(self):
        from data_providers.factory import _supabase_provider
        env = {
            "SUPABASE_URL": "https://xyfhikikddcqcmzbdvbj.supabase.co",
            "SUPABASE_ANON_KEY": "anon-publishable-key",
        }
        prov = _supabase_provider(env)
        self.assertEqual(prov._key, "anon-publishable-key")


if __name__ == "__main__":
    unittest.main()

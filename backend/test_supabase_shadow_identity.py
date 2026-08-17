from __future__ import annotations

import datetime
import hashlib
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from data_providers.sheets import SheetsDataProvider
from tools.supabase_import.core import (
    REQUIRED_SHADOW_DOMAINS,
    SHADOW_DOMAIN_SPECS,
    ShadowDomainSpec,
    _comparison_index,
    compare_shadow_provider,
    APPROVED_HISTORICAL_HEADSET_REVIEW_EXCEPTIONS,
)
from tools.supabase_import.projection import (
    project_reconciliation_plan,
    projected_readiness_summary,
)
from tools.supabase_import.reconciliation import _canonical_uuid


def _snapshot_metadata():
    return {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "checksum": "a" * 64,
        "fetch_count": 1,
        "retry_count": 0,
        "errors": {},
    }


class StaticProvider:
    lineage_write_mode = "rpc_only"

    def __init__(self, resources=None, lineage=None):
        self._url = "https://xyfhikikddcqcmzbdvbj.supabase.co"
        self.resources = {name: [] for name in REQUIRED_SHADOW_DOMAINS}
        self.resources.update(resources or {})
        self.lineage = list(lineage or [])

    def insert_lineage_if_absent(self, _row):
        raise RuntimeError("read_only")

    def _request(self, path, *, query=None, **_kwargs):
        return list(self.lineage) if path == "data_source_lineage" else []

    def list_resource(self, resource, *, filters=None, limit=1000, offset=0):
        rows = [dict(row) for row in self.resources.get(resource, [])]
        return rows[offset:offset + limit]


def _sheets(candidate_rows):
    provider = SheetsDataProvider(object())
    provider._snapshot = {}
    provider._tabs = {
        "Candidate Sessions": [dict(row) for row in candidate_rows],
        "Pending Sup Transfers": [],
        "headsets": [],
        "headset-review-log": [],
        "newbie-shift-requests": [],
        "candidate-deletion-requests": [],
        "candidate-information-correction-requests": [],
        "sam-notifications": [],
    }
    provider.snapshot_metadata = _snapshot_metadata()
    return provider


def _target(candidate_rows, candidates):
    sessions = []
    for row in candidate_rows:
        session_id = row["session_id"]
        candidate_id = row["candidate_id"]
        sessions.append({
            **row,
            "id": _canonical_uuid("session", session_id),
            "raw_status": row.get("status"),
        })
    statuses = [{
        "session_id": row["session_id"],
        "determining_session_id": row["session_id"],
        "authoritative_status": row.get("authoritative_status") or row.get("status"),
        "final_attempt": bool(row.get("final_attempt")),
        "archived": bool(row.get("archived")),
    } for row in candidate_rows]
    history = [{
        **row,
        "raw_status": row.get("status"),
        "authoritative_status": row.get("authoritative_status") or row.get("status"),
        "category": row.get("category", "passed"),
    } for row in candidate_rows]
    projected_candidates = [{
        **row,
        "comparison_candidate_id": row["id"],
    } for row in candidates]
    return StaticProvider({
        "candidates": projected_candidates,
        "candidate_sessions": sessions,
        "authoritative_candidate_status": statuses,
        "candidate_tracking": history,
        "history": history,
    })


class StableIdentityComparisonTests(unittest.TestCase):
    def test_same_name_distinct_persisted_candidates_remain_distinct(self):
        candidate_ids = [str(uuid.uuid4()), str(uuid.uuid4())]
        rows = [{
            "session_id": str(uuid.uuid4()), "candidate_id": candidate_ids[index],
            "candidate_name": "Same Synthetic Name", "status": "Pass",
        } for index in range(2)]
        target = _target(rows, [
            {"id": candidate_ids[index], "display_name": "Same Synthetic Name", "latest_session_id": rows[index]["session_id"], "authoritative_status": "Pass"}
            for index in range(2)
        ])
        result = compare_shadow_provider(_sheets(rows), target)
        self.assertEqual(result["categories"]["candidates"]["sheets_count"], 2)
        self.assertEqual(result["categories"]["candidates"]["missing_in_supabase_count"], 0)

    def test_name_correction_is_value_change_not_identity_change(self):
        candidate_id, session_id = str(uuid.uuid4()), str(uuid.uuid4())
        source = [{"session_id": session_id, "candidate_id": candidate_id, "candidate_name": "Corrected Synthetic", "status": "Pass"}]
        target_rows = [{"session_id": session_id, "candidate_id": candidate_id, "candidate_name": "Old Synthetic", "status": "Pass"}]
        result = compare_shadow_provider(_sheets(source), _target(target_rows, [{
            "id": candidate_id, "display_name": "Old Synthetic", "latest_session_id": session_id, "authoritative_status": "Pass",
        }]))
        domain = result["categories"]["candidates"]
        self.assertEqual(domain["missing_in_supabase_count"], 0)
        self.assertEqual(domain["missing_in_sheets_count"], 0)
        self.assertEqual(domain["value_mismatch_count"], 1)

    def test_session_identity_survives_status_change(self):
        candidate_id, session_id = str(uuid.uuid4()), str(uuid.uuid4())
        source = [{"session_id": session_id, "candidate_id": candidate_id, "candidate_name": "Synthetic", "status": "Fail"}]
        target_rows = [{"session_id": session_id, "candidate_id": candidate_id, "candidate_name": "Synthetic", "status": "Pass"}]
        result = compare_shadow_provider(_sheets(source), _target(target_rows, [{"id": candidate_id}]))
        domain = result["categories"]["candidate_sessions"]
        self.assertEqual(domain["missing_in_supabase_count"], 0)
        self.assertEqual(domain["status_mismatch_count"], 1)

    def test_history_id_fallback_becomes_session_identity(self):
        candidate_id, history_id = str(uuid.uuid4()), str(uuid.uuid4())
        rows = [{"history_id": history_id, "candidate_id": candidate_id, "candidate_name": "Synthetic", "status": "Pass"}]
        projected = _sheets(rows).list_resource("candidate_sessions", limit=5000)
        self.assertEqual(projected[0]["session_id"], history_id)

    def test_resume_history_id_fallback_becomes_session_identity(self):
        candidate_id, history_id = str(uuid.uuid4()), str(uuid.uuid4())
        rows = [{"resume_source_history_id": history_id, "candidate_id": candidate_id, "candidate_name": "Synthetic", "status": "Pass"}]
        projected = _sheets(rows).list_resource("candidate_sessions", limit=5000)
        self.assertEqual(projected[0]["session_id"], history_id)

    def test_tracking_uses_stable_candidate_relationship(self):
        candidate_id, session_id = str(uuid.uuid4()), str(uuid.uuid4())
        rows = [{"session_id": session_id, "candidate_id": candidate_id, "candidate_name": "Synthetic", "status": "Pass"}]
        result = compare_shadow_provider(_sheets(rows), _target(rows, [{"id": candidate_id}]))
        self.assertEqual(result["categories"]["candidate_tracking"]["relationship_mismatch_count"], 0)

    def test_history_uses_stable_candidate_relationship(self):
        candidate_id, session_id = str(uuid.uuid4()), str(uuid.uuid4())
        rows = [{"session_id": session_id, "candidate_id": candidate_id, "candidate_name": "Synthetic", "status": "Pass"}]
        result = compare_shadow_provider(_sheets(rows), _target(rows, [{"id": candidate_id}]))
        self.assertEqual(result["categories"]["history"]["relationship_mismatch_count"], 0)

    def test_final_attempt_failed_calls_match_authoritative_rule(self):
        provider = _sheets([{
            "session_id": str(uuid.uuid4()), "candidate_id": str(uuid.uuid4()),
            "candidate_name": "Synthetic", "status": "WITHDREW FROM CERTIFICATION",
            "final_attempt": True, "call_1_result": "Fail", "call_2_result": "Fail",
        }])
        status = provider.list_resource("authoritative_candidate_status", limit=5000)[0]
        self.assertEqual(status["authoritative_status"], "FAIL-Final Attempt")

    def test_name_only_legacy_identity_fails_closed(self):
        result = compare_shadow_provider(
            _sheets([{"candidate_name": "Synthetic Only", "status": "Pass"}]),
            StaticProvider(),
        )
        self.assertEqual(result["overall_readiness"], "not_ready")
        self.assertGreater(result["categories"]["candidate_sessions"]["unresolved_identity_count"], 0)

    def test_missing_stable_identity_has_explicit_error_code(self):
        result = compare_shadow_provider(
            _sheets([{"candidate_name": "Synthetic Only"}]), StaticProvider(),
        )
        self.assertIn("legacy_identity_unresolved", result["categories"]["candidate_sessions"]["error_codes"])

    def test_prior_name_key_fixture_fails_under_legacy_spec(self):
        legacy = ShadowDomainSpec(identity=(("source_candidate_id", "display_name"),))
        sheets_index, _, _ = _comparison_index(legacy, [{"source_candidate_id": "Renamed Synthetic"}])
        target_index, _, _ = _comparison_index(legacy, [{"source_candidate_id": "legacy_session:opaque"}])
        self.assertEqual(len(set(sheets_index) - set(target_index)), 1)
        self.assertEqual(len(set(target_index) - set(sheets_index)), 1)

    def test_stable_candidate_key_repairs_prior_fixture(self):
        stable_id = str(uuid.uuid4())
        spec = SHADOW_DOMAIN_SPECS["candidates"]
        sheets_index, _, _ = _comparison_index(spec, [{"comparison_candidate_id": stable_id}])
        target_index, _, _ = _comparison_index(spec, [{"id": stable_id}])
        self.assertEqual(set(sheets_index), set(target_index))

    def test_name_derived_key_regression_stays_detectable(self):
        stable_id = str(uuid.uuid4())
        spec = SHADOW_DOMAIN_SPECS["candidates"]
        sheets_index, _, unresolved = _comparison_index(spec, [{"source_candidate_id": "Synthetic Name"}])
        target_index, _, _ = _comparison_index(spec, [{"id": stable_id}])
        self.assertEqual(unresolved, 1)
        self.assertNotEqual(set(sheets_index), set(target_index))

    def test_headset_historical_exception_remains_ready(self):
        rows = {"headset_reviews": [{"review_id": "legacy", "source_session_id": "missing", "session_id": None}]}
        sheets = StaticProvider(rows)
        sheets.snapshot_metadata = _snapshot_metadata()
        safe_hash = hashlib.sha256(b"headset_reviews:legacy").hexdigest()
        with patch.dict(APPROVED_HISTORICAL_HEADSET_REVIEW_EXCEPTIONS, {
            safe_hash: {
                "source_status": "approved",
                "target_status": "pending",
                "allow_relationship": True,
            },
        }, clear=True):
            result = compare_shadow_provider(sheets, StaticProvider(rows))
        self.assertEqual(result["categories"]["headset_reviews"]["readiness"], "ready")

    def test_unapproved_headset_missing_session_remains_not_ready(self):
        rows = {"headset_reviews": [{"review_id": "future", "source_session_id": "missing", "session_id": None}]}
        sheets = StaticProvider(rows)
        sheets.snapshot_metadata = _snapshot_metadata()
        result = compare_shadow_provider(sheets, StaticProvider(rows))
        self.assertEqual(result["categories"]["headset_reviews"]["readiness"], "not_ready")


class ProjectedReadinessTests(unittest.TestCase):
    @staticmethod
    def _plan_fixture():
        existing_candidate = str(uuid.uuid4())
        existing_source_session = str(uuid.uuid4())
        existing_session = _canonical_uuid("session", existing_source_session)
        base = StaticProvider({
            "candidates": [{"id": existing_candidate, "display_name": "Update Synthetic"}],
            "candidate_sessions": [{
                "id": existing_session, "session_id": existing_source_session,
                "candidate_id": existing_candidate, "candidate_name": "Update Synthetic",
                "raw_status": "Fail", "final_attempt": False, "archived": False,
            }],
        })
        items = []
        private = {}

        def add(entity, index, entity_id, raw, *, operation="insert", changed_fields=None):
            safe_hash = hashlib.sha256(f"{entity}:{index}".encode()).hexdigest()
            items.append({
                "entity_type": entity, "safe_identity_hash": safe_hash,
                "canonical_entity_id": entity_id, "operation": operation,
                "classification": "insert_new" if operation == "insert" else "update_existing",
                "source_checksum": "b" * 64, "source_tab": f"synthetic-{entity}",
                "source_row_key": f"synthetic:{entity}:{index}",
                "lineage_required": operation == "insert",
                "changed_fields": list(changed_fields or []),
            })
            private[safe_hash] = dict(raw)

        session_ids = [str(uuid.uuid4()) for _ in range(4)]
        candidate_ids = [str(uuid.uuid4()) for _ in range(4)]
        for index, (session_id, candidate_id) in enumerate(zip(session_ids, candidate_ids)):
            raw = {
                "session_id": session_id, "candidate_id": candidate_id,
                "candidate_name": f"Synthetic Candidate {index}", "status": "Pass",
                "final_attempt": False, "archived": False,
            }
            add("candidates", index, candidate_id, raw)
            add("candidate_sessions", index, _canonical_uuid("session", session_id), raw)
            for attempt in (1, 2):
                action = f"synthetic-attempt-{index}-{attempt}"
                add("session_attempts", index * 2 + attempt, str(uuid.uuid4()), {
                    "source_session_id": session_id, "attempt_number": attempt,
                    "attempt_type": "mock_call", "result": "Pass",
                    "source_action_id": action,
                })
        for index in range(2):
            add("headset_catalog", index, str(uuid.uuid4()), {
                "Brand": f"Synthetic Brand {index}", "Model": f"Model {index}",
                "Status": "approved",
            })
        add("headset_reviews", 0, str(uuid.uuid4()), {
            "review_id": "synthetic-review", "source_session_id": session_ids[0],
            "brand": "Synthetic Brand 0", "model": "Model 0", "status": "pending",
            "normalization_status": "canonical",
        })
        add("supervisor_transfers", 0, str(uuid.uuid4()), {
            "pending_id": "synthetic-transfer", "original_session_id": session_ids[0],
            "status": "pending", "final_attempt": False,
        })
        for index in range(5):
            add("newbie_shift_requests", index, str(uuid.uuid4()), {
                "request_id": f"synthetic-newbie-{index}",
                "source_session_id": session_ids[index % 4],
                "request_type": "initial_newbie_shift", "request_status": "pending",
            })
        for index in range(3):
            add("pending_requests", index, str(uuid.uuid4()), {
                "request_id": f"synthetic-deletion-{index}",
                "source_session_id": session_ids[index],
                "request_type": "candidate_deletion", "status": "pending",
            })
        add("candidate_sessions", "update", existing_session, {
            "session_id": existing_source_session, "candidate_id": existing_candidate,
            "candidate_name": "Update Synthetic", "status": "Pass",
        }, operation="update", changed_fields=["raw_status"])
        return base, {
            "items": items, "_private_source_rows": private,
            "canonical_operations": {"inserts": 28, "updates": 1},
            "source_snapshot_checksum": "a" * 64, "plan_checksum": "c" * 64,
        }

    def test_projected_ready_never_claims_full_cutover(self):
        categories = {name: {"readiness": "ready"} for name in REQUIRED_SHADOW_DOMAINS}
        result = projected_readiness_summary({"completed": True, "overall_readiness": "ready", "categories": categories})
        self.assertTrue(result["shadow_read_mapped_domains_ready"])
        self.assertFalse(result["full_cutover_ready"])
        self.assertFalse(result["production_verified"])

    def test_projected_difference_fails_mapped_readiness(self):
        categories = {name: {"readiness": "ready"} for name in REQUIRED_SHADOW_DOMAINS}
        categories["history"] = {"readiness": "not_ready"}
        result = projected_readiness_summary({"completed": True, "overall_readiness": "not_ready", "categories": categories})
        self.assertFalse(result["shadow_read_mapped_domains_ready"])

    def test_projected_evidence_is_labeled_simulation_only(self):
        result = projected_readiness_summary({"completed": False, "categories": {}})
        self.assertEqual(result["evidence_class"], "simulation_only")

    def test_projected_provider_rejects_lineage_write(self):
        projected = project_reconciliation_plan(_sheets([]), StaticProvider(), {
            "items": [], "_private_source_rows": {}, "canonical_operations": {},
        })
        with self.assertRaisesRegex(RuntimeError, "simulation_provider_is_read_only"):
            projected.insert_lineage_if_absent({})

    def test_empty_projection_does_not_mutate_source_provider(self):
        source = StaticProvider()
        project_reconciliation_plan(_sheets([]), source, {
            "items": [], "_private_source_rows": {}, "canonical_operations": {},
        })
        self.assertTrue(all(not rows for rows in source.resources.values()))

    def test_projected_28_plus_1_has_exact_canonical_shape(self):
        base, plan = self._plan_fixture()
        projected = project_reconciliation_plan(_sheets([]), base, plan)
        self.assertEqual(len(projected.list_resource("candidates", limit=5000)), 5)
        self.assertEqual(len(projected.list_resource("candidate_sessions", limit=5000)), 5)
        self.assertEqual(len(projected.list_resource("session_attempts", limit=5000)), 8)
        self.assertEqual(len(projected.list_resource("headset_catalog", limit=5000)), 2)
        self.assertEqual(len(projected.list_resource("headset_reviews", limit=5000)), 1)
        self.assertEqual(len(projected.list_resource("supervisor_transfers", limit=5000)), 1)
        self.assertEqual(len(projected.list_resource("newbie_shift_requests", limit=5000)), 5)

    def test_projected_four_candidates_and_sessions_have_stable_relationships(self):
        base, plan = self._plan_fixture()
        projected = project_reconciliation_plan(_sheets([]), base, plan)
        candidates = {row["id"] for row in projected.list_resource("candidates", limit=5000)}
        sessions = projected.list_resource("candidate_sessions", limit=5000)
        self.assertEqual(sum(row.get("created_by_reconciliation_batch_id") is None for row in sessions), 5)
        self.assertTrue(all(row.get("candidate_id") in candidates for row in sessions))

    def test_projected_eight_attempts_keep_exact_session_parents(self):
        base, plan = self._plan_fixture()
        projected = project_reconciliation_plan(_sheets([]), base, plan)
        session_ids = {row["id"] for row in projected.list_resource("candidate_sessions", limit=5000)}
        attempts = projected.list_resource("session_attempts", limit=5000)
        self.assertEqual(len(attempts), 8)
        self.assertTrue(all(row.get("session_id") in session_ids for row in attempts))

    def test_projected_request_and_activity_counts_are_recomputed(self):
        base, plan = self._plan_fixture()
        projected = project_reconciliation_plan(_sheets([]), base, plan)
        self.assertEqual(len(projected.list_resource("pending_requests", limit=5000)), 8)
        self.assertEqual(len(projected.list_resource("recent_activity", limit=5000)), 8)

    def test_projected_narrow_update_changes_only_approved_status(self):
        base, plan = self._plan_fixture()
        before = dict(base.resources["candidate_sessions"][0])
        projected = project_reconciliation_plan(_sheets([]), base, plan)
        after = next(row for row in projected.list_resource("candidate_sessions", limit=5000) if row["id"] == before["id"])
        self.assertEqual(after["raw_status"], "Pass")
        self.assertEqual(after["candidate_id"], before["candidate_id"])

    def test_projected_lineage_count_matches_28_new_rows(self):
        base, plan = self._plan_fixture()
        projected = project_reconciliation_plan(_sheets([]), base, plan)
        self.assertEqual(projected.simulation_metadata["projected_lineage_count"], 28)

    def test_projected_correction_update_changes_only_candidate_fk(self):
        correction_id = str(uuid.uuid4())
        candidate_id = str(uuid.uuid4())
        base = StaticProvider({
            "candidate_corrections": [{
                "id": correction_id, "request_id": "r-1", "source_session_id": "s-1",
                "session_id": str(uuid.uuid4()), "candidate_id": None, "status": "pending",
            }],
        })
        safe_hash = hashlib.sha256(b"correction-update").hexdigest()
        projected = project_reconciliation_plan(_sheets([]), base, {
            "items": [{
                "entity_type": "candidate_corrections", "operation": "update",
                "classification": "update_existing", "safe_identity_hash": safe_hash,
                "canonical_entity_id": correction_id, "changed_fields": ["candidate_id"],
            }],
            "_private_source_rows": {safe_hash: {"candidate_id": candidate_id}},
            "canonical_operations": {"inserts": 0, "updates": 1},
        })
        row = projected.list_resource("candidate_corrections", limit=5000)[0]
        self.assertEqual(row["candidate_id"], candidate_id)
        self.assertEqual(row["request_id"], "r-1")
        self.assertEqual(row["source_session_id"], "s-1")
        self.assertEqual(row["status"], "pending")

    def test_projected_session_completion_update_flows_to_history(self):
        candidate_id = str(uuid.uuid4())
        session_id = str(uuid.uuid4())
        canonical_id = _canonical_uuid("session", session_id)
        base = StaticProvider({
            "candidates": [{"id": candidate_id}],
            "candidate_sessions": [{
                "id": canonical_id, "session_id": session_id, "candidate_id": candidate_id,
                "session_type": "mock_session", "completed_at": "2026-08-01T04:00:00+00:00",
            }],
        })
        safe_hash = hashlib.sha256(b"session-completion-update").hexdigest()
        projected = project_reconciliation_plan(_sheets([]), base, {
            "items": [{
                "entity_type": "candidate_sessions", "operation": "update",
                "classification": "update_existing", "safe_identity_hash": safe_hash,
                "canonical_entity_id": canonical_id, "changed_fields": ["completed_at", "session_type"],
            }],
            "_private_source_rows": {safe_hash: {
                "completed_at": "2026-08-03T02:25:21.860957+00:00", "session_type": "sup_transfer_only",
            }},
            "canonical_operations": {"inserts": 0, "updates": 1},
        })
        session = projected.list_resource("candidate_sessions", limit=5000)[0]
        history = projected.list_resource("history", limit=5000)[0]
        self.assertEqual(session["session_type"], "sup_transfer_only")
        self.assertEqual(history["completed_at"], "2026-08-03T02:25:21.860957+00:00")

    def test_projected_readiness_reports_unapplied_reconciliation_migration(self):
        categories = {name: {"readiness": "ready"} for name in REQUIRED_SHADOW_DOMAINS}
        result = projected_readiness_summary(
            {"completed": True, "overall_readiness": "ready", "categories": categories},
            {"reconciliation_migration_required": True},
        )
        self.assertTrue(result["shadow_read_mapped_domains_ready"])
        self.assertIn("reconciliation_migration_not_applied", result["blockers"])

    def test_clean_projected_28_plus_1_fixture_uses_production_comparator(self):
        base, plan = self._plan_fixture()
        projected = project_reconciliation_plan(_sheets([]), base, plan)
        mirror = StaticProvider({
            domain: projected.list_resource(domain, limit=5000)
            for domain in REQUIRED_SHADOW_DOMAINS
        })
        mirror.snapshot_metadata = _snapshot_metadata()
        result = compare_shadow_provider(mirror, projected)
        self.assertEqual(result["overall_readiness"], "ready")
        self.assertEqual(result["total_unexplained"], 0)


if __name__ == "__main__":
    unittest.main()

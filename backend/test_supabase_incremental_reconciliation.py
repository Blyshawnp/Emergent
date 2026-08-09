import datetime
import sys
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from tools.supabase_import.reconciliation import (
    EXECUTION_ACK_ENV,
    EXECUTION_ACK_VALUE,
    EXECUTION_UNAVAILABLE_ERROR,
    EXPECTED_SUPABASE_PROJECT_REF,
    generate_reconciliation_plan,
    hosted_count_snapshot,
    public_plan,
    rollback_preview,
    validate_execution_request,
    validate_plan_freshness,
)


NOW = datetime.datetime(2026, 8, 7, 12, 0, tzinfo=datetime.timezone.utc)


class FakeSheets:
    def __init__(self, resources=None):
        self.resources = resources or {}
        self.snapshot_metadata = {
            "timestamp": NOW.isoformat(),
            "checksum": "a" * 64,
            "fetch_count": 1,
            "retry_count": 0,
            "errors": {},
        }

    def list_resource(self, resource, **_kwargs):
        return list(self.resources.get(resource, ()))


class FakeSupabase:
    _url = f"https://{EXPECTED_SUPABASE_PROJECT_REF}.supabase.co"
    lineage_write_mode = "rpc_only"

    def __init__(self, resources=None, lineage=None, count_rows=None, table_rows=None, infrastructure_ready=False):
        self.resources = resources or {}
        self.lineage = lineage or []
        self.count_rows = count_rows or {}
        self.table_rows = table_rows or {}
        self.infrastructure_ready = infrastructure_ready
        self.calls = []

    def list_resource(self, resource, **_kwargs):
        self.calls.append(("list", resource))
        return list(self.resources.get(resource, ()))

    def _request(self, table, *, query=None, **kwargs):
        self.calls.append(("request", table, query, kwargs))
        if kwargs:
            raise AssertionError("planner attempted a hosted write")
        if table == "data_source_lineage" and query and "entity_type" in str(query.get("select")):
            return list(self.lineage)
        if table in {"reconciliation_batches", "reconciliation_plan_items", "reconciliation_before_images"}:
            if not self.infrastructure_ready:
                raise RuntimeError("relation does not exist")
            return list(self.table_rows.get(table, ()))
        if table in self.table_rows:
            return list(self.table_rows[table])
        return [{"id": str(index)} for index in range(self.count_rows.get(table, 0))]


def resources(**overrides):
    result = {
        "candidates": [], "candidate_sessions": [], "session_attempts": [],
        "headset_catalog": [], "headset_reviews": [], "supervisor_transfers": [],
        "newbie_shift_requests": [], "candidate_corrections": [],
        "pending_requests": [], "notifications": [],
    }
    result.update(overrides)
    return result


def build_plan(source=None, target=None, lineage=None, table_rows=None, infrastructure_ready=False):
    return generate_reconciliation_plan(
        FakeSheets(source or resources()), FakeSupabase(
            target or resources(), lineage=lineage, table_rows=table_rows,
            infrastructure_ready=infrastructure_ready,
        ),
        comparison_result={"completed": True, "overall_readiness": "not_ready", "total_unexplained": 1},
        now=NOW,
    )


class ReconciliationPlannerTests(unittest.TestCase):
    def test_missing_session_is_insert_new(self):
        plan = build_plan(resources(candidate_sessions=[{"session_id": "s-1"}]))
        session = next(item for item in plan["items"] if item["entity_type"] == "candidate_sessions")
        self.assertEqual(session["classification"], "insert_new")
        self.assertEqual(session["blocking_reason"], "parent_candidate_identity_unresolved")

    def test_missing_candidate_never_uses_name_identity(self):
        plan = build_plan(resources(candidate_sessions=[{"session_id": "s-1", "candidate_name": "Private Name"}]))
        candidate = next(item for item in plan["items"] if item["entity_type"] == "candidates")
        self.assertEqual(candidate["classification"], "ambiguous")
        self.assertEqual(candidate["blocking_reason"], "durable_uuid_history_identity_unavailable")
        self.assertNotIn("Private Name", str(public_plan(plan, diagnostic=True)))

    def test_existing_canonical_candidate_identity_is_reused(self):
        source = resources(candidate_sessions=[{"session_id": "s-1"}])
        target = resources(candidates=[{"id": "candidate-1", "source_candidate_id": "opaque-1"}])
        target["candidate_sessions"] = [{"id": "session-1", "session_id": "s-1", "candidate_id": "candidate-1"}]
        plan = build_plan(source, target)
        candidate = next(item for item in plan["items"] if item["entity_type"] == "candidates")
        self.assertEqual(candidate["classification"], "already_current")

    def test_singleton_uuid_history_identity_is_safe_and_name_independent(self):
        session_id = "11111111-1111-4111-8111-111111111111"
        plan = build_plan(resources(candidate_sessions=[{
            "session_id": session_id, "candidate_name": "Private Name",
        }]))
        candidate = next(item for item in plan["items"] if item["entity_type"] == "candidates")
        session = next(item for item in plan["items"] if item["entity_type"] == "candidate_sessions")
        self.assertEqual(candidate["classification"], "insert_new")
        self.assertEqual(candidate["identity_resolution_method"], "deterministic_legacy_history_uuid")
        self.assertIsNone(candidate["blocking_reason"])
        self.assertIsNone(session["blocking_reason"])
        self.assertNotIn("Private Name", str(public_plan(plan, diagnostic=True)))

    def test_existing_candidate_lineage_mapping_is_preferred(self):
        session_id = "11111111-1111-4111-8111-111111111111"
        candidate_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        source = resources(candidate_sessions=[{"session_id": session_id}])
        target = resources(candidates=[{"id": candidate_id}])
        lineage = [{
            "entity_type": "candidates", "entity_id": candidate_id,
            "source_system": "google_sheets", "source_tab": "Candidate Sessions",
            "source_row_key": f"legacy_session_id:{session_id}", "source_checksum": "x",
        }]
        plan = build_plan(source, target, lineage=lineage)
        candidate = next(item for item in plan["items"] if item["entity_type"] == "candidates")
        self.assertEqual(candidate["identity_resolution_method"], "existing_candidate_lineage")
        self.assertEqual(candidate["classification"], "already_current")

    def test_persisted_candidate_uuid_is_reused(self):
        candidate_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        source = resources(candidate_sessions=[{
            "session_id": "11111111-1111-4111-8111-111111111111",
            "persisted_candidate_id": candidate_id,
        }])
        target = resources(candidates=[{"id": candidate_id}])
        candidate = next(item for item in build_plan(source, target)["items"] if item["entity_type"] == "candidates")
        self.assertEqual(candidate["identity_resolution_method"], "persisted_candidate_uuid")
        self.assertEqual(candidate["classification"], "already_current")

    def test_changed_display_name_preserves_legacy_history_identity(self):
        session_id = "11111111-1111-4111-8111-111111111111"
        first = build_plan(resources(candidate_sessions=[{"session_id": session_id, "candidate_name": "Old Private"}]))
        second = build_plan(resources(candidate_sessions=[{"session_id": session_id, "candidate_name": "New Private"}]))
        first_item = next(item for item in first["items"] if item["entity_type"] == "candidates")
        second_item = next(item for item in second["items"] if item["entity_type"] == "candidates")
        self.assertEqual(first_item["safe_identity_hash"], second_item["safe_identity_hash"])

    def test_multiple_linked_sessions_resolve_to_one_candidate(self):
        source = resources(candidate_sessions=[{"session_id": "s-1"}, {"session_id": "s-2"}])
        target = resources(
            candidates=[{"id": "candidate-1"}],
            candidate_sessions=[
                {"id": "one", "session_id": "s-1", "candidate_id": "candidate-1"},
                {"id": "two", "session_id": "s-2", "candidate_id": "candidate-1"},
            ],
        )
        candidates = [item for item in build_plan(source, target)["items"] if item["entity_type"] == "candidates"]
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0]["classification"], "already_current")

    def test_legacy_history_uuid_collision_behavior_is_deterministic(self):
        source = resources(candidate_sessions=[
            {"session_id": "11111111-1111-4111-8111-111111111111", "candidate_name": "Same Private"},
            {"session_id": "22222222-2222-4222-8222-222222222222", "candidate_name": "Same Private"},
        ])
        plan = build_plan(source)
        candidates = [item for item in plan["items"] if item["entity_type"] == "candidates"]
        self.assertEqual(len(candidates), 2)
        self.assertTrue(all(item["classification"] == "ambiguous" for item in candidates))
        self.assertTrue(all(item["blocking_reason"] == "legacy_session_identity_candidate_group_ambiguous" for item in candidates))

    def test_status_only_change_produces_narrow_update_and_before_image(self):
        source = resources(candidate_sessions=[{"session_id": "s-1", "raw_status": "Pass", "candidate_id": "c-1"}])
        target = resources(
            candidates=[{"id": "c-1", "source_candidate_id": "opaque"}],
            candidate_sessions=[{"id": "session-uuid", "session_id": "s-1", "raw_status": "Fail", "candidate_id": "c-1"}],
        )
        plan = build_plan(source, target)
        item = next(item for item in plan["items"] if item["entity_type"] == "candidate_sessions")
        self.assertEqual(item["classification"], "update_existing")
        self.assertEqual(item["changed_fields"], ["raw_status"])
        self.assertEqual(plan["before_image_count"], 1)
        self.assertEqual(set(plan["_private_before_images"][0]["fields"]), {"raw_status"})

    def test_new_blank_lazy_headers_do_not_replay_historical_sessions(self):
        source = resources(candidate_sessions=[{
            "session_id": "s-1", "candidate_id": "c-1", "status": "Pass",
            "extra_attempt_granted_at": "", "readiness_override_by": "",
        }])
        target = resources(
            candidates=[{"id": "c-1"}],
            candidate_sessions=[{
                "id": "x", "session_id": "s-1", "candidate_id": "c-1", "raw_status": "Pass",
                "source_payload": {"session_id": "s-1", "status": "Pass"},
            }],
        )
        plan = build_plan(source, target)
        item = next(item for item in plan["items"] if item["entity_type"] == "candidate_sessions")
        self.assertEqual(item["classification"], "already_current")

    def test_unrelated_field_change_is_not_an_update(self):
        source = resources(candidate_sessions=[{"session_id": "s-1", "candidate_name": "A", "candidate_id": "c-1"}])
        target = resources(
            candidates=[{"id": "c-1", "source_candidate_id": "opaque"}],
            candidate_sessions=[{"id": "x", "session_id": "s-1", "candidate_name": "B", "candidate_id": "c-1"}],
        )
        plan = build_plan(source, target)
        item = next(item for item in plan["items"] if item["entity_type"] == "candidate_sessions")
        self.assertEqual(item["classification"], "conflict")
        self.assertIn("non_allowlisted_change", item["blocking_reason"])

    def test_unchanged_row_is_already_current(self):
        row = {"id": "x", "session_id": "s-1", "raw_status": "Pass", "candidate_id": "c-1"}
        source = resources(candidate_sessions=[dict(row)])
        target = resources(candidates=[{"id": "c-1"}], candidate_sessions=[dict(row)])
        plan = build_plan(source, target)
        item = next(item for item in plan["items"] if item["entity_type"] == "candidate_sessions")
        self.assertEqual(item["classification"], "already_current")

    def test_source_row_movement_does_not_change_identity(self):
        source = resources(newbie_shift_requests=[{"request_id": "r-1", "source_session_id": "s-1", "row_number": 99}])
        target = resources(newbie_shift_requests=[{"id": "x", "request_id": "r-1", "source_session_id": "s-1", "row_number": 2}])
        plan = build_plan(source, target)
        item = next(item for item in plan["items"] if item["entity_type"] == "newbie_shift_requests")
        self.assertEqual(item["classification"], "already_current")

    def test_repeated_session_newbie_requests_remain_distinct(self):
        source = resources(newbie_shift_requests=[
            {"request_id": "r-1", "source_session_id": "s-1"},
            {"request_id": "r-2", "source_session_id": "s-1"},
        ])
        plan = build_plan(source)
        requests = [item for item in plan["items"] if item["entity_type"] == "newbie_shift_requests"]
        self.assertEqual(len(requests), 2)
        self.assertTrue(all(item["classification"] == "insert_new" for item in requests))

    def test_cross_tab_same_request_id_is_distinct(self):
        source = resources(
            newbie_shift_requests=[{"request_id": "shared", "source_session_id": "s-1"}],
            pending_requests=[{
                "request_id": "shared", "source_session_id": "s-1",
                "source_tab": "candidate-deletion-requests",
            }],
        )
        plan = build_plan(source)
        inserts = [item for item in plan["items"] if item["classification"] == "insert_new"]
        self.assertEqual({item["entity_type"] for item in inserts}, {"newbie_shift_requests", "pending_requests"})

    def test_pending_projection_does_not_double_count_newbie(self):
        source = resources(
            newbie_shift_requests=[{"request_id": "r-1", "source_session_id": "s-1"}],
            pending_requests=[{
                "request_id": "r-1", "source_session_id": "s-1",
                "source_tab": "newbie-shift-requests",
            }],
        )
        plan = build_plan(source)
        self.assertEqual(plan["entity_counts"]["newbie_shift_requests"]["inserts"], 1)
        self.assertNotIn("pending_requests", plan["entity_counts"])
        self.assertEqual(plan["derived_domain_effects"]["pending_requests"], 1)

    def test_attempt_identity_uses_actual_slot(self):
        source = resources(session_attempts=[{
            "source_action_id": "google_sheets:attempt:s-1:2", "source_session_id": "s-1",
            "attempt_number": 2, "attempt_type": "mock_call", "result": "Pass",
        }])
        plan = build_plan(source)
        item = next(item for item in plan["items"] if item["entity_type"] == "session_attempts")
        self.assertEqual(item["classification"], "insert_new")
        self.assertEqual(item["dependencies"][0]["entity_type"], "candidate_sessions")

    def test_ambiguous_candidate_blocks_session_and_attempt(self):
        source = resources(
            candidate_sessions=[{"session_id": "not-a-durable-uuid"}],
            session_attempts=[{
                "source_action_id": "google_sheets:attempt:not-a-durable-uuid:1",
                "source_session_id": "not-a-durable-uuid", "attempt_number": 1,
            }],
        )
        plan = build_plan(source)
        session = next(item for item in plan["items"] if item["entity_type"] == "candidate_sessions")
        attempt = next(item for item in plan["items"] if item["entity_type"] == "session_attempts")
        self.assertEqual(session["blocking_reason"], "parent_candidate_identity_unresolved")
        self.assertEqual(attempt["blocking_reason"], "parent_session_identity_unresolved")
        self.assertEqual(attempt["classification"], "ambiguous")

    def test_ambiguous_timestamp_less_headset_is_blocked(self):
        plan = build_plan(resources(headset_catalog=[{"Brand": "Brand", "Model": "Model", "Status": "approved"}]))
        item = next(item for item in plan["items"] if item["entity_type"] == "headset_catalog")
        self.assertEqual(item["classification"], "ambiguous")
        self.assertEqual(item["blocking_reason"], "catalog_provenance_and_recency_unavailable")

    def test_unique_timestamped_headset_can_be_planned(self):
        plan = build_plan(resources(headset_catalog=[{
            "Brand": "Brand", "Model": "Model", "Status": "approved", "updated_at": "2026-08-07T00:00:00Z",
        }]))
        item = next(item for item in plan["items"] if item["entity_type"] == "headset_catalog")
        self.assertEqual(item["classification"], "insert_new")

    def test_two_successful_snapshots_and_exact_prefix_prove_new_headset_suffix(self):
        old = {"Brand": "Old", "Model": "One", "Status": "approved"}
        new = {"Brand": "New", "Model": "Two", "Status": "approved"}
        table_rows = {
            "import_batches": [
                {"id": "batch-1", "started_at": "2026-08-01"},
                {"id": "batch-2", "started_at": "2026-08-02"},
            ],
            "import_staging_rows": [
                {"import_batch_id": "batch-1", "source_row_number": 2, "raw_row": old},
                {"import_batch_id": "batch-2", "source_row_number": 2, "raw_row": old},
            ],
        }
        plan = build_plan(resources(headset_catalog=[old, new]), table_rows=table_rows)
        item = next(item for item in plan["items"] if item["entity_type"] == "headset_catalog" and item["classification"] == "insert_new")
        self.assertEqual(item["provenance_classification"], "safe_new_insert")
        self.assertTrue(item["historical_sequence_is_exact_prefix"])

    def test_historical_headset_missing_canonical_is_explicitly_legacy_unmapped(self):
        old = {"Brand": "Old", "Model": "One", "Status": "approved"}
        table_rows = {
            "import_batches": [
                {"id": "batch-1", "started_at": "2026-08-01"},
                {"id": "batch-2", "started_at": "2026-08-02"},
            ],
            "import_staging_rows": [
                {"import_batch_id": "batch-1", "source_row_number": 2, "raw_row": old},
                {"import_batch_id": "batch-2", "source_row_number": 2, "raw_row": old},
            ],
        }
        item = next(item for item in build_plan(resources(headset_catalog=[old]), table_rows=table_rows)["items"] if item["entity_type"] == "headset_catalog")
        self.assertEqual(item["provenance_classification"], "expected_legacy_unmapped")
        self.assertEqual(item["classification"], "ambiguous")

    def test_normalized_canonical_headset_is_a_duplicate_not_an_insert(self):
        source = resources(headset_catalog=[{"Brand": " Brand ", "Model": "MODEL", "Status": "approved"}])
        target = resources(headset_catalog=[{"id": "one", "brand": "brand", "model": "model", "status": "approved"}])
        item = next(item for item in build_plan(source, target)["items"] if item["entity_type"] == "headset_catalog")
        self.assertEqual(item["provenance_classification"], "normalized_duplicate")
        self.assertEqual(item["classification"], "already_current")

    def test_duplicate_headset_identity_blocks(self):
        row = {"Brand": "Brand", "Model": "Model", "updated_at": "2026-08-07"}
        plan = build_plan(resources(headset_catalog=[row, dict(row)]))
        item = next(item for item in plan["items"] if item["entity_type"] == "headset_catalog")
        self.assertEqual(item["classification"], "conflict")

    def test_missing_review_with_stable_id_is_planned(self):
        plan = build_plan(resources(headset_reviews=[{"review_id": "review-1", "source_session_id": "s-1"}]))
        item = next(item for item in plan["items"] if item["entity_type"] == "headset_reviews")
        self.assertEqual(item["classification"], "insert_new")

    def test_historical_standalone_review_is_preserved(self):
        target = resources(headset_reviews=[{"id": "x", "review_id": "old-review", "source_session_id": None, "session_id": None}])
        plan = build_plan(target=target)
        item = next(item for item in plan["items"] if item["entity_type"] == "headset_reviews")
        self.assertEqual(item["classification"], "expected_historical")

    def test_orphan_transfer_has_dependency_and_cannot_be_silently_inserted(self):
        source = resources(supervisor_transfers=[{"pending_id": "t-1", "original_session_id": "missing"}])
        plan = build_plan(source)
        item = next(item for item in plan["items"] if item["entity_type"] == "supervisor_transfers")
        self.assertEqual(item["dependencies"][0]["entity_type"], "candidate_sessions")

    def test_same_lineage_mapping_is_reused(self):
        source = resources(newbie_shift_requests=[{"request_id": "r-1"}])
        lineage = [{
            "entity_type": "newbie_shift_requests",
            "entity_id": "a0e87326-2b0b-5c24-b9c7-54a05db1db66",
            "source_system": "google_sheets", "source_tab": "newbie-shift-requests",
            "source_row_key": "request_id:r-1", "source_checksum": "x",
        }]
        plan = build_plan(source, lineage=lineage)
        # The exact UUID need not be guessed by callers; a mismatched entity-side
        # mapping is correctly treated as a potential conflict.
        self.assertIn(
            next(item for item in plan["items"] if item["entity_type"] == "newbie_shift_requests")["lineage_outcome"],
            {"already_exists_same_mapping", "conflict_source_maps_to_different_entity"},
        )

    def test_conflicting_lineage_blocks_plan(self):
        source = resources(newbie_shift_requests=[{"request_id": "r-1"}])
        lineage = [{
            "entity_type": "newbie_shift_requests", "entity_id": "different",
            "source_system": "google_sheets", "source_tab": "newbie-shift-requests",
            "source_row_key": "request_id:r-1", "source_checksum": "x",
        }]
        plan = build_plan(source, lineage=lineage)
        item = next(item for item in plan["items"] if item["entity_type"] == "newbie_shift_requests")
        self.assertEqual(item["classification"], "conflict")

    def test_old_broad_false_plan_cannot_recur(self):
        source_sessions = []
        target_sessions = []
        target_candidates = []
        for index in range(367):
            candidate_id = f"candidate-{index}"
            row = {"id": f"session-{index}", "session_id": f"s-{index}", "candidate_id": candidate_id, "raw_status": "Pass"}
            source_sessions.append(dict(row))
            target_sessions.append(dict(row))
            target_candidates.append({"id": candidate_id, "source_candidate_id": f"opaque-{index}"})
        plan = build_plan(
            resources(candidate_sessions=source_sessions),
            resources(candidates=target_candidates, candidate_sessions=target_sessions),
        )
        self.assertEqual(plan["canonical_operations"], {"inserts": 0, "updates": 0})
        self.assertEqual(plan["classification_counts"]["already_current"], 734)

    def test_public_plan_never_contains_before_values(self):
        source = resources(candidate_sessions=[{"session_id": "s-1", "raw_status": "Pass", "candidate_id": "c-1"}])
        target = resources(candidates=[{"id": "c-1"}], candidate_sessions=[{"id": "x", "session_id": "s-1", "raw_status": "Fail", "candidate_id": "c-1"}])
        public = public_plan(build_plan(source, target), diagnostic=True)
        self.assertNotIn("_private_before_images", public)
        self.assertNotIn("before_values", str(public))

    def test_default_public_plan_is_aggregate_only(self):
        plan = build_plan(resources(candidate_sessions=[{"session_id": "s-1"}]))
        public = public_plan(plan)
        self.assertNotIn("items", public)
        self.assertNotIn("blockers", public)
        self.assertEqual(public["blocker_counts"]["candidates:durable_uuid_history_identity_unavailable"], 1)

    def test_hosted_count_snapshot_is_read_only(self):
        provider = FakeSupabase(count_rows={"candidates": 2, "import_batches": 3})
        counts = hosted_count_snapshot(provider)
        self.assertEqual(counts["candidates"], 2)
        self.assertEqual(counts["import_batches"], 3)
        self.assertTrue(all(not call[-1] for call in provider.calls if call[0] == "request"))

    def test_applied_reconciliation_infrastructure_clears_migration_guard(self):
        plan = build_plan(infrastructure_ready=True)
        self.assertFalse(plan["rollback"]["migration_required"])
        self.assertEqual(plan["status"], "blocked")
        self.assertEqual(
            plan["blockers"][-1]["reason"], EXECUTION_UNAVAILABLE_ERROR,
        )


class ExecutionGuardTests(unittest.TestCase):
    def ready_plan(self):
        plan = {
            "version": 1,
            "project_ref": EXPECTED_SUPABASE_PROJECT_REF,
            "source_snapshot_checksum": "a" * 64,
            "items": [],
            "expires_at": (NOW + datetime.timedelta(minutes=10)).isoformat(),
            "status": "ready", "blockers": [],
            "lineage_operations": {"potential_source_conflict": 0, "potential_entity_conflict": 0},
            "rollback": {"migration_required": True},
        }
        from tools.supabase_import.core import stable_checksum
        plan["plan_checksum"] = stable_checksum({
            "version": 1, "project_ref": EXPECTED_SUPABASE_PROJECT_REF,
            "source_snapshot_checksum": "a" * 64, "items": [],
        })
        return plan

    def valid_args(self, plan, env=None):
        return validate_execution_request(
            plan, project_ref=EXPECTED_SUPABASE_PROJECT_REF,
            plan_checksum=plan["plan_checksum"],
            confirmation=f"EXECUTE:{EXPECTED_SUPABASE_PROJECT_REF}:{plan['plan_checksum']}",
            environ=env or {EXECUTION_ACK_ENV: EXECUTION_ACK_VALUE, "MTS_DATA_PROVIDER": "sheets"},
            now=NOW,
        )

    def test_execution_is_blocked_until_forward_migration_is_applied(self):
        self.assertEqual(self.valid_args(self.ready_plan()), [
            "reconciliation_migration_not_applied",
            EXECUTION_UNAVAILABLE_ERROR,
        ])

    def test_execution_remains_blocked_after_forward_migration_is_applied(self):
        plan = self.ready_plan()
        plan["rollback"]["migration_required"] = False
        self.assertEqual(self.valid_args(plan), [EXECUTION_UNAVAILABLE_ERROR])

    def test_expired_plan_is_rejected(self):
        plan = self.ready_plan()
        plan["expires_at"] = (NOW - datetime.timedelta(seconds=1)).isoformat()
        self.assertIn("plan_expired", self.valid_args(plan))

    def test_changed_plan_checksum_is_rejected(self):
        plan = self.ready_plan()
        errors = validate_execution_request(
            plan, project_ref=EXPECTED_SUPABASE_PROJECT_REF, plan_checksum="wrong",
            confirmation="wrong", environ={}, now=NOW,
        )
        self.assertIn("plan_checksum_mismatch", errors)

    def test_task_environment_without_ack_is_rejected(self):
        plan = self.ready_plan()
        self.assertIn("task_level_execution_ack_missing", self.valid_args(plan, {"MTS_DATA_PROVIDER": "sheets"}))

    def test_wrong_project_is_rejected(self):
        plan = self.ready_plan()
        errors = validate_execution_request(
            plan, project_ref="wrong", plan_checksum=plan["plan_checksum"], confirmation="wrong",
            environ={EXECUTION_ACK_ENV: EXECUTION_ACK_VALUE}, now=NOW,
        )
        self.assertIn("project_ref_mismatch", errors)

    def test_shadow_enabled_blocks_execution(self):
        env = {EXECUTION_ACK_ENV: EXECUTION_ACK_VALUE, "MTS_DATA_PROVIDER": "sheets", "MTS_SHADOW_COMPARE": "true"}
        self.assertIn("shadow_compare_enabled", self.valid_args(self.ready_plan(), env))

    def test_dual_write_enabled_blocks_execution(self):
        env = {EXECUTION_ACK_ENV: EXECUTION_ACK_VALUE, "MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "true"}
        self.assertIn("dual_write_enabled", self.valid_args(self.ready_plan(), env))

    def test_provider_must_remain_sheets(self):
        env = {EXECUTION_ACK_ENV: EXECUTION_ACK_VALUE, "MTS_DATA_PROVIDER": "supabase"}
        self.assertIn("provider_not_sheets", self.valid_args(self.ready_plan(), env))

    def test_changed_source_snapshot_invalidates_plan(self):
        plan = self.ready_plan()
        self.assertIn("source_snapshot_changed", validate_plan_freshness(
            plan, current_snapshot_checksum="changed", current_source_checksums={}, current_target_checksums={},
        ))

    def test_changed_target_checksum_invalidates_plan(self):
        plan = self.ready_plan()
        plan["items"] = [{
            "safe_identity_hash": "safe", "source_checksum": "source", "target_checksum": "before",
        }]
        errors = validate_plan_freshness(
            plan, current_snapshot_checksum=plan["source_snapshot_checksum"],
            current_source_checksums={"safe": "source"}, current_target_checksums={"safe": "newer"},
        )
        self.assertIn("target_checksum_changed:safe", errors)


class RollbackContractTests(unittest.TestCase):
    def batch(self):
        return {
            "batch_id": "batch-1", "status": "succeeded",
            "created_items": [{"safe_identity_hash": "one", "post_sync_checksum": "after"}],
            "before_images": [{"fields": {"status": "before"}}],
            "rollback": {"delete_order": ["session_attempts", "candidate_sessions"]},
        }

    def test_rollback_preview_is_exact_and_dependency_ordered(self):
        preview = rollback_preview(self.batch(), current_checksums={"one": "after"})
        self.assertTrue(preview["eligible"])
        self.assertEqual(preview["restore_updates"], 1)
        self.assertEqual(preview["delete_order"], ["session_attempts", "candidate_sessions"])

    def test_rollback_rejects_newer_checksum(self):
        preview = rollback_preview(self.batch(), current_checksums={"one": "newer"})
        self.assertFalse(preview["eligible"])
        self.assertIn("post_sync_checksum_changed:one", preview["guards"])

    def test_rollback_rejects_later_dependency(self):
        preview = rollback_preview(self.batch(), current_checksums={"one": "after"}, later_dependencies=["batch-2"])
        self.assertIn("later_batch_dependency_exists", preview["guards"])

    def test_repeated_rollback_is_not_eligible(self):
        batch = self.batch()
        batch["status"] = "rolled_back"
        self.assertIn("batch_not_rollback_eligible", rollback_preview(batch, current_checksums={"one": "after"})["guards"])

    def test_rollback_preserves_audit_evidence(self):
        self.assertTrue(rollback_preview(self.batch(), current_checksums={"one": "after"})["preserve_audit_evidence"])

    def test_missing_batch_fails_closed(self):
        self.assertIn("batch_not_found", rollback_preview(None, current_checksums={})["guards"])


class MigrationContractTests(unittest.TestCase):
    def test_forward_migration_is_private_and_batch_exact(self):
        path = Path(__file__).resolve().parents[1] / "supabase" / "migrations" / "20260807000000_mts_sam_incremental_reconciliation.sql"
        sql = path.read_text(encoding="utf-8").casefold()
        self.assertIn("reconciliation_batches", sql)
        self.assertIn("reconciliation_before_images", sql)
        self.assertIn("force row level security", sql)
        self.assertIn("revoke all", sql)
        self.assertIn("security invoker", sql)
        self.assertIn("set search_path = ''", sql)
        self.assertIn("guard_reconciliation_batch_change", sql)
        self.assertIn("guard_reconciliation_plan_item_change", sql)
        self.assertIn("guard_reconciliation_before_image_change", sql)
        self.assertIn("plan items cannot be inserted after execution starts", sql)
        self.assertIn("before-images are immutable audit evidence", sql)
        self.assertIn("invalid reconciliation batch status transition", sql)
        self.assertIn("created-by-batch accounting requires a proven successful insert", sql)
        self.assertIn("rollback requires prior eligibility", sql)
        self.assertNotIn("grant select on mts_sam.reconciliation_before_images to authenticated", sql)
        self.assertNotIn("security definer", sql)
        self.assertNotIn("execute format", sql)
        self.assertNotIn("set_config", sql)
        self.assertNotIn("delete from", sql)


if __name__ == "__main__":
    unittest.main()

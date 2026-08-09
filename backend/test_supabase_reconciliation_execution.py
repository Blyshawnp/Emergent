import sys
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from tools.supabase_import.execution import (  # noqa: E402
    APPROVED_INSERT_COUNTS, APPROVED_UPDATE_COUNTS, _payload, approved_plan_errors, execute_plan,
)
from data_providers.supabase import SupabaseDataProvider  # noqa: E402


class PayloadHandlerTests(unittest.TestCase):
    def item(self, entity):
        return {"canonical_entity_id": "11111111-1111-4111-8111-111111111111", "source_checksum": "a" * 64,
                "source_row_key": "opaque:key", "source_tab": "tab", "entity_type": entity}

    def test_all_eight_handlers_bind_canonical_id(self):
        rows = {
            "candidates": {"session_id": "22222222-2222-4222-8222-222222222222", "candidate_name": "Private"},
            "candidate_sessions": {"session_id": "s", "candidate_id": "22222222-2222-4222-8222-222222222222"},
            "session_attempts": {"source_session_id": "s", "attempt_number": 1, "source_action_id": "a"},
            "headset_catalog": {"Brand": "B", "Model": "M"},
            "headset_reviews": {"review_id": "r"}, "supervisor_transfers": {"pending_id": "t", "original_session_id": "s"},
            "newbie_shift_requests": {"request_id": "n", "source_session_id": "s"},
            "pending_requests": {"request_id": "p", "source_tab": "candidate-deletion-requests"},
        }
        self.assertEqual(set(rows), set(APPROVED_INSERT_COUNTS))
        for entity, row in rows.items():
            with self.subTest(entity=entity):
                self.assertEqual(_payload(entity, self.item(entity), row)["id"], self.item(entity)["canonical_entity_id"])

    def test_approved_shape_is_exact(self):
        items = []
        for entity, count in APPROVED_INSERT_COUNTS.items():
            items += [{"entity_type": entity, "classification": "insert_new"}] * count
        for entity, count in APPROVED_UPDATE_COUNTS.items():
            items += [{"entity_type": entity, "classification": "update_existing"}] * count
        for index, item in enumerate(items):
            item.update({"canonical_entity_id": f"00000000-0000-4000-8000-{index:012d}", "source_tab": "tab",
                         "source_row_key": f"key:{index}", "source_checksum": "a" * 64})
        plan = {"items": items, "lineage_operations": {"expected_new": 28},
                "canonical_operations": {"inserts": 28, "updates": 1}, "created_entity_count": 28, "before_image_count": 1}
        self.assertEqual(approved_plan_errors(plan), [])
        self.assertIn("approved_insert_shape_mismatch", approved_plan_errors({"items": [], "lineage_operations": {}}))


class FakeExecutionProvider:
    def __init__(self):
        self.calls = []

    def begin_reconciliation_execution(self, _plan, items):
        self.calls.append("begin")
        return {"result": "started", "batch_id": "batch", "items": [
            {"id": f"item-{i}", "safe_identity_hash": item["safe_identity_hash"]} for i, item in enumerate(items)
        ]}

    def execute_reconciliation_insert(self, *_args): self.calls.append("insert"); return {"result": "inserted"}
    def execute_reconciliation_candidate_session_update(self, *_args): self.calls.append("update"); return {"result": "updated"}
    def finalize_reconciliation_batch(self, _batch): self.calls.append("finalize"); return {"result": "succeeded"}
    def fail_reconciliation_batch(self, *_args): self.calls.append("fail"); return {"result": "failed"}


class FailingExecutionProvider(FakeExecutionProvider):
    def execute_reconciliation_insert(self, *_args):
        self.calls.append("insert")
        raise RuntimeError("synthetic_write_failure")


class OrchestrationTests(unittest.TestCase):
    def test_insert_then_update_then_finalize(self):
        insert = {"entity_type": "candidates", "classification": "insert_new", "operation": "insert",
                  "safe_identity_hash": "insert", "canonical_entity_id": "11111111-1111-4111-8111-111111111111",
                  "source_checksum": "a" * 64, "source_tab": "Candidate Sessions", "source_row_key": "legacy_session_id:x",
                  "changed_fields": [], "dependencies": [], "lineage_outcome": "inserted", "lineage_required": True}
        update = {"entity_type": "candidate_sessions", "classification": "update_existing", "operation": "update",
                  "safe_identity_hash": "update", "canonical_entity_id": "22222222-2222-4222-8222-222222222222",
                  "source_checksum": "b" * 64, "source_tab": "Candidate Sessions", "source_row_key": "session_id:s",
                  "changed_fields": ["raw_status"], "dependencies": [], "lineage_outcome": "not_required", "lineage_required": False}
        plan = {"items": [update, insert], "_private_source_rows": {
            "insert": {"session_id": "x", "candidate_name": "Private"}, "update": {"raw_status": "Pass"}},
            "_private_before_images": [{"safe_identity_hash": "update", "fields": {"raw_status": "Fail"}}]}
        plan["_private_target_preconditions"] = {"update": {"id": update["canonical_entity_id"], "raw_status": "Fail"}}
        provider = FakeExecutionProvider()
        result = execute_plan(provider, plan)
        self.assertEqual(result["completed"], 2)
        self.assertEqual(provider.calls, ["begin", "insert", "update", "finalize"])

    @staticmethod
    def approved_synthetic_plan():
        raw_by_entity = {
            "candidates": {"session_id": "22222222-2222-4222-8222-222222222222", "candidate_name": "Synthetic"},
            "candidate_sessions": {"session_id": "synthetic-session", "candidate_id": "22222222-2222-4222-8222-222222222222"},
            "session_attempts": {"source_session_id": "synthetic-session", "attempt_number": 1, "source_action_id": "synthetic-action"},
            "headset_catalog": {"Brand": "Synthetic", "Model": "Model"},
            "headset_reviews": {"review_id": "synthetic-review"},
            "supervisor_transfers": {"pending_id": "synthetic-transfer", "original_session_id": "synthetic-session"},
            "newbie_shift_requests": {"request_id": "synthetic-shift", "source_session_id": "synthetic-session"},
            "pending_requests": {"request_id": "synthetic-delete", "source_tab": "candidate-deletion-requests"},
        }
        items = []
        sources = {}
        sequence = 0
        for entity, count in APPROVED_INSERT_COUNTS.items():
            for _ in range(count):
                sequence += 1
                safe_hash = f"{sequence:064x}"
                item = {"entity_type": entity, "classification": "insert_new", "operation": "insert",
                        "safe_identity_hash": safe_hash, "canonical_entity_id": f"00000000-0000-4000-8000-{sequence:012d}",
                        "source_checksum": "a" * 64, "source_tab": "synthetic", "source_row_key": f"synthetic:{sequence}",
                        "changed_fields": [], "dependencies": [], "lineage_outcome": "inserted", "lineage_required": True}
                items.append(item); sources[safe_hash] = dict(raw_by_entity[entity])
        sequence += 1
        update_hash = f"{sequence:064x}"
        update = {"entity_type": "candidate_sessions", "classification": "update_existing", "operation": "update",
                  "safe_identity_hash": update_hash, "canonical_entity_id": f"00000000-0000-4000-8000-{sequence:012d}",
                  "source_checksum": "b" * 64, "source_tab": "synthetic", "source_row_key": "synthetic:update",
                  "changed_fields": ["raw_status"], "dependencies": [], "lineage_outcome": "not_required", "lineage_required": False}
        items.append(update); sources[update_hash] = {"status": "Pass"}
        return {"items": items, "_private_source_rows": sources,
                "_private_before_images": [{"safe_identity_hash": update_hash, "fields": {"raw_status": "Fail"}}],
                "_private_target_preconditions": {update_hash: {"id": update["canonical_entity_id"], "raw_status": "Fail"}}}

    def test_complete_28_plus_1_synthetic_scenario(self):
        provider = FakeExecutionProvider()
        result = execute_plan(provider, self.approved_synthetic_plan())
        self.assertEqual(result["completed"], 29)
        self.assertEqual(provider.calls.count("insert"), 28)
        self.assertEqual(provider.calls.count("update"), 1)
        self.assertEqual(provider.calls[-1], "finalize")

    def test_partial_failure_is_accounted_and_never_finalized(self):
        provider = FailingExecutionProvider()
        with self.assertRaisesRegex(RuntimeError, "synthetic_write_failure"):
            execute_plan(provider, self.approved_synthetic_plan())
        self.assertIn("fail", provider.calls)
        self.assertNotIn("finalize", provider.calls)


class ProviderSafetyTests(unittest.TestCase):
    def test_arbitrary_reconciliation_rpc_name_is_rejected_before_transport(self):
        provider = SupabaseDataProvider("https://example.supabase.co", "synthetic-key")
        with self.assertRaisesRegex(ValueError, "Unsupported reconciliation RPC"):
            provider._reconciliation_rpc("caller_controlled_rpc", {})

    def test_rollback_preview_accepts_eligibility_contract_without_result_field(self):
        provider = SupabaseDataProvider("https://example.supabase.co", "synthetic-key")
        provider._request = lambda *_args, **_kwargs: {"eligible": True, "blockers": []}
        self.assertEqual(provider.preview_reconciliation_rollback("synthetic-batch"), {
            "eligible": True, "blockers": [],
        })

    def test_rollback_preview_rejects_malformed_contract(self):
        provider = SupabaseDataProvider("https://example.supabase.co", "synthetic-key")
        provider._request = lambda *_args, **_kwargs: {"result": "not-a-preview"}
        with self.assertRaisesRegex(RuntimeError, "rollback preview RPC returned a malformed response"):
            provider.preview_reconciliation_rollback("synthetic-batch")


class ForwardMigrationContractTests(unittest.TestCase):
    def test_execution_migration_is_narrow_locked_and_private(self):
        path = Path(__file__).resolve().parents[1] / "supabase" / "migrations" / "20260809025333_reconciliation_execution_engine.sql"
        sql = path.read_text(encoding="utf-8").casefold()
        for token in ("pg_advisory_xact_lock", "execute_reconciliation_insert", "execute_reconciliation_candidate_session_update",
                      "preview_reconciliation_rollback", "rollback_reconciliation_batch", "created_by_reconciliation_batch_id",
                      "ending_count_mismatch", "planned_lineage_count", "already_started", "already_committed",
                      "rollback_batch_artifacts_remain", "rollback_ending_count_mismatch"):
            self.assertIn(token, sql)
        for entity in APPROVED_INSERT_COUNTS:
            self.assertIn(f"when '{entity}'", sql)
        self.assertIn("set search_path = ''", sql)
        self.assertIn("from public,anon,authenticated", sql)
        self.assertNotIn("execute format", sql)
        self.assertGreaterEqual(sql.count("assert_reconciliation_json_keys"), 10)
        self.assertIn("array['raw_status','calculated_result','final_result','archived','withdrawn','final_attempt'", sql)
        self.assertNotIn("delete from mts_sam.candidates where created_at", sql)
        delete_positions = [sql.index(f"delete from mts_sam.{entity}") for entity in (
            "pending_requests", "newbie_shift_requests", "supervisor_transfers", "headset_reviews",
            "session_attempts", "candidate_sessions", "headset_catalog", "candidates",
        )]
        self.assertEqual(delete_positions, sorted(delete_positions))


if __name__ == "__main__":
    unittest.main()

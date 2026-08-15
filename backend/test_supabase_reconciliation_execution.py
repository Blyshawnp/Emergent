import datetime
import sys
import unittest
from copy import deepcopy
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from tools.supabase_import.execution import (  # noqa: E402
    APPROVED_BEFORE_IMAGE_COUNT, APPROVED_CANONICAL_OPERATIONS, APPROVED_INSERT_COUNTS,
    APPROVED_NEW_LINEAGE_COUNT, APPROVED_UPDATE_COUNTS, APPROVED_UPDATE_FIELDS, INSERT_ORDER,
    _payload, approved_plan_errors, execute_plan,
)
from tools.supabase_import.reconciliation import rollback_preview  # noqa: E402
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
        plan = OrchestrationTests.approved_synthetic_plan()
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
    def execute_reconciliation_candidate_correction_update(self, *_args): self.calls.append("correction_update"); return {"result": "updated"}
    def finalize_reconciliation_batch(self, _batch): self.calls.append("finalize"); return {"result": "succeeded"}
    def fail_reconciliation_batch(self, *_args): self.calls.append("fail"); return {"result": "failed"}


class CapturingExecutionProvider(FakeExecutionProvider):
    def execute_reconciliation_candidate_session_update(self, *args):
        self.calls.append("update")
        self.session_update_args = args
        return {"result": "updated"}


class FailingExecutionProvider(FakeExecutionProvider):
    def execute_reconciliation_insert(self, *_args):
        self.calls.append("insert")
        raise RuntimeError("synthetic_write_failure")


class OrchestrationTests(unittest.TestCase):
    def test_parent_session_is_ordered_before_headset_review_child(self):
        self.assertLess(INSERT_ORDER["candidate_sessions"], INSERT_ORDER["headset_reviews"])

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
        before_images = []
        target_preconditions = {}
        sequence += 1
        update_hash = f"{sequence:064x}"
        update = {"entity_type": "candidate_sessions", "classification": "update_existing", "operation": "update",
                  "safe_identity_hash": update_hash, "canonical_entity_id": f"00000000-0000-4000-8000-{sequence:012d}",
                  "source_checksum": "b" * 64, "source_tab": "synthetic", "source_row_key": "synthetic:session-update",
                  "changed_fields": list(APPROVED_UPDATE_FIELDS["candidate_sessions"]), "dependencies": [],
                  "lineage_outcome": "not_required", "lineage_required": False}
        items.append(update)
        sources[update_hash] = {
            "session_id": "synthetic-session", "status": "RESUMED-PASS",
            "calculated_result": "RESUMED-PASS", "final_result": "RESUMED-PASS",
            "needs_sup_transfer": False, "pending_sup_transfer_id": "",
            "session_type": "sup_transfer_only", "completed_at": "2026-08-14T00:00:00Z",
            "call_1_result": "Pass", "call_2_result": "Fail", "call_3_result": "Pass",
            "sup_transfer_1_result": "Pass", "sup_transfer_2_result": "",
            "final_attempt": False, "readiness_override_applied": False,
        }
        session_before = {
            "raw_status": "INCOMPLETE", "calculated_result": "Incomplete", "final_result": "Incomplete",
            "needs_sup_transfer": True, "pending_sup_transfer_id": "pending-reviewed",
            "session_type": "mock_session", "completed_at": "2026-08-12T00:00:00Z",
        }
        before_images.append({"safe_identity_hash": update_hash, "fields": dict(session_before)})
        target_preconditions[update_hash] = {
            "id": update["canonical_entity_id"], "session_id": "synthetic-session",
            "candidate_id": "22222222-2222-4222-8222-222222222222", **session_before,
        }
        sequence += 1
        transfer_hash = f"{sequence:064x}"
        items.append({
            "entity_type": "supervisor_transfers", "classification": "already_current", "operation": "none",
            "safe_identity_hash": transfer_hash, "canonical_entity_id": "30000000-0000-4000-8000-000000000001",
            "source_checksum": "d" * 64, "source_tab": "Pending Sup Transfers",
            "source_row_key": "pending_id:pending-reviewed", "changed_fields": [], "dependencies": [],
            "lineage_outcome": "already_exists_same_mapping", "lineage_required": False,
        })
        sources[transfer_hash] = {
            "pending_id": "pending-reviewed", "original_session_id": "synthetic-session", "status": "pending",
        }
        for correction_index in range(5):
            sequence += 1
            correction_hash = f"{sequence:064x}"
            correction = {
                "entity_type": "candidate_corrections", "classification": "update_existing", "operation": "update",
                "safe_identity_hash": correction_hash,
                "canonical_entity_id": f"10000000-0000-4000-8000-{correction_index:012d}",
                "source_checksum": "c" * 64, "source_tab": "candidate-information-correction-requests",
                "source_row_key": f"request_id:synthetic-{correction_index}", "changed_fields": ["candidate_id"],
                "dependencies": [], "lineage_outcome": "not_required", "lineage_required": False,
            }
            items.append(correction)
            sources[correction_hash] = {"candidate_id": f"20000000-0000-4000-8000-{correction_index:012d}"}
            before_images.append({"safe_identity_hash": correction_hash, "fields": {"candidate_id": None}})
            target_preconditions[correction_hash] = {
                "id": correction["canonical_entity_id"], "request_id": f"synthetic-{correction_index}",
                "source_session_id": f"session-{correction_index}", "candidate_id": None, "status": "pending",
            }
        return {
            "status": "ready", "blockers": [],
            "items": items, "_private_source_rows": sources, "_private_before_images": before_images,
            "_private_target_preconditions": target_preconditions,
            "canonical_operations": dict(APPROVED_CANONICAL_OPERATIONS),
            "created_entity_count": APPROVED_CANONICAL_OPERATIONS["inserts"],
            "before_image_count": APPROVED_BEFORE_IMAGE_COUNT,
            "lineage_operations": {
                "expected_new": APPROVED_NEW_LINEAGE_COUNT, "expected_same_mapping": 155,
                "potential_source_conflict": 0, "potential_entity_conflict": 0, "unresolved": 0,
            },
        }

    def test_complete_28_plus_6_synthetic_scenario(self):
        provider = FakeExecutionProvider()
        result = execute_plan(provider, self.approved_synthetic_plan())
        self.assertEqual(result["completed"], 34)
        self.assertEqual(provider.calls.count("insert"), 28)
        self.assertEqual(provider.calls.count("update"), 1)
        self.assertEqual(provider.calls.count("correction_update"), 5)
        self.assertEqual(provider.calls[-1], "finalize")

    def test_reviewed_session_payload_preserves_strict_types_and_offset_timestamp(self):
        plan = self.approved_synthetic_plan()
        session_item = next(
            item for item in plan["items"]
            if item["entity_type"] == "candidate_sessions" and item["operation"] == "update"
        )
        source = plan["_private_source_rows"][session_item["safe_identity_hash"]]
        source["completed_at"] = "2026-08-02T22:25:21.860957-04:00"
        provider = CapturingExecutionProvider()
        execute_plan(provider, plan)
        _batch_id, _item_id, _precondition, changes, expected = provider.session_update_args
        self.assertEqual(changes, expected)
        self.assertIs(changes["needs_sup_transfer"], False)
        self.assertEqual(changes["pending_sup_transfer_id"], "")
        self.assertEqual(changes["completed_at"], "2026-08-02T22:25:21.860957-04:00")
        self.assertEqual(set(changes), set(APPROVED_UPDATE_FIELDS["candidate_sessions"]))

    def test_scope_guard_rejects_invalid_boolean_and_status_values(self):
        plan = self.approved_synthetic_plan()
        session_item = next(
            item for item in plan["items"]
            if item["entity_type"] == "candidate_sessions" and item["operation"] == "update"
        )
        source = plan["_private_source_rows"][session_item["safe_identity_hash"]]
        source["final_result"] = "RESUMED_PAS"
        self.assertIn("approved_session_result_transition_mismatch", approved_plan_errors(plan))
        source["final_result"] = "RESUMED-PASS"
        source["needs_sup_transfer"] = "not-a-boolean"
        with self.assertRaisesRegex(ValueError, "unrecognized_boolean"):
            approved_plan_errors(plan)

    def test_partial_failure_is_accounted_and_never_finalized(self):
        provider = FailingExecutionProvider()
        with self.assertRaisesRegex(RuntimeError, "synthetic_write_failure"):
            execute_plan(provider, self.approved_synthetic_plan())
        self.assertIn("fail", provider.calls)
        self.assertNotIn("finalize", provider.calls)

    def test_candidate_correction_update_dispatches_exact_narrow_handler(self):
        update = {
            "entity_type": "candidate_corrections", "classification": "update_existing", "operation": "update",
            "safe_identity_hash": "c" * 64, "canonical_entity_id": "11111111-1111-4111-8111-111111111111",
            "source_checksum": "b" * 64, "source_tab": "candidate-information-correction-requests",
            "source_row_key": "request_id:r-1", "changed_fields": ["candidate_id"],
            "dependencies": [], "lineage_outcome": "not_required", "lineage_required": False,
        }
        plan = {
            "items": [update],
            "_private_source_rows": {"c" * 64: {"candidate_id": "22222222-2222-4222-8222-222222222222"}},
            "_private_before_images": [{"safe_identity_hash": "c" * 64, "fields": {"candidate_id": None}}],
            "_private_target_preconditions": {"c" * 64: {
                "id": update["canonical_entity_id"], "request_id": "r-1", "source_session_id": "s-1",
                "session_id": "33333333-3333-4333-8333-333333333333", "candidate_id": None, "status": "pending",
            }},
        }
        provider = FakeExecutionProvider()
        result = execute_plan(provider, plan)
        self.assertEqual(result["completed"], 1)
        self.assertEqual(provider.calls, ["begin", "correction_update", "finalize"])

    def test_candidate_correction_update_rejects_every_field_except_candidate_id(self):
        update = {
            "entity_type": "candidate_corrections", "classification": "update_existing", "operation": "update",
            "safe_identity_hash": "c" * 64, "canonical_entity_id": "11111111-1111-4111-8111-111111111111",
            "source_checksum": "b" * 64, "source_tab": "candidate-information-correction-requests",
            "source_row_key": "request_id:r-1", "changed_fields": ["candidate_id", "status"],
        }
        plan = {
            "items": [update], "_private_source_rows": {"c" * 64: {"candidate_id": "x", "status": "approved"}},
            "_private_before_images": [{"safe_identity_hash": "c" * 64, "fields": {}}],
            "_private_target_preconditions": {"c" * 64: {"id": update["canonical_entity_id"]}},
        }
        with self.assertRaisesRegex(ValueError, "candidate_correction_update_fields_not_allowed"):
            execute_plan(FakeExecutionProvider(), plan)

    def test_exact_28_plus_6_shape_is_authorized(self):
        self.assertEqual(approved_plan_errors(self.approved_synthetic_plan()), [])

    def test_obsolete_28_plus_1_shape_is_rejected(self):
        plan = self.approved_synthetic_plan()
        correction_hashes = {
            item["safe_identity_hash"] for item in plan["items"]
            if item["entity_type"] == "candidate_corrections"
        }
        plan["items"] = [item for item in plan["items"] if item["safe_identity_hash"] not in correction_hashes]
        plan["_private_before_images"] = [
            image for image in plan["_private_before_images"] if image["safe_identity_hash"] not in correction_hashes
        ]
        plan["canonical_operations"]["updates"] = 1
        plan["before_image_count"] = 1
        self.assertIn("approved_update_shape_mismatch", approved_plan_errors(plan))

    def test_scope_guard_rejects_wrong_counts_distributions_and_operations(self):
        mutations = {
            "27 inserts": lambda p: p["items"].pop(0),
            "29 inserts": lambda p: p["items"].append(deepcopy(p["items"][0])),
            "missing correction": lambda p: p["items"].pop(next(
                i for i, item in enumerate(p["items"]) if item["entity_type"] == "candidate_corrections"
            )),
            "extra correction": lambda p: p["items"].append(deepcopy(next(
                item for item in p["items"] if item["entity_type"] == "candidate_corrections"
            ))),
            "missing session update": lambda p: p["items"].pop(next(
                i for i, item in enumerate(p["items"])
                if item["entity_type"] == "candidate_sessions" and item["operation"] == "update"
            )),
            "extra session update": lambda p: p["items"].append(deepcopy(next(
                item for item in p["items"]
                if item["entity_type"] == "candidate_sessions" and item["operation"] == "update"
            ))),
            "unsupported operation": lambda p: p["items"].append({"classification": "already_current", "operation": "delete"}),
            "ambiguous item": lambda p: p["items"].append({"classification": "ambiguous"}),
            "unresolved item": lambda p: p["items"].append({"classification": "unresolved"}),
            "unsupported item": lambda p: p["items"].append({"classification": "unsupported"}),
            "conflict item": lambda p: p["items"].append({"classification": "conflict"}),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                plan = self.approved_synthetic_plan()
                mutate(plan)
                self.assertTrue(approved_plan_errors(plan))

    def test_nonexecuting_plan_items_use_explicit_none_operation(self):
        plan = self.approved_synthetic_plan()
        plan["items"].append({"classification": "already_current", "operation": "none"})
        self.assertEqual(approved_plan_errors(plan), [])

    def test_scope_guard_rejects_nonapproved_update_fields(self):
        invalid_fields = {
            "candidate_sessions": (
                [*APPROVED_UPDATE_FIELDS["candidate_sessions"], "candidate_id"],
                [field for field in APPROVED_UPDATE_FIELDS["candidate_sessions"] if field != "raw_status"],
                ["candidate_id"], ["session_id"], ["history_id"], ["source_session_id"],
                ["resume_source_history_id"], ["created_at"],
            ),
            "candidate_corrections": (["candidate_id", "status"], ["source_session_id"], ["request_id"]),
        }
        for entity, cases in invalid_fields.items():
            for fields in cases:
                with self.subTest(entity=entity, fields=fields):
                    plan = self.approved_synthetic_plan()
                    item = next(row for row in plan["items"] if row["entity_type"] == entity and row["operation"] == "update")
                    item["changed_fields"] = list(fields)
                    self.assertIn("approved_update_field_set_mismatch", approved_plan_errors(plan))

    def test_scope_guard_requires_exact_before_image_mapping(self):
        mutations = {
            "five images": lambda p: p["_private_before_images"].pop(),
            "seven images": lambda p: p["_private_before_images"].append(deepcopy(p["_private_before_images"][0])),
            "duplicate mapping": lambda p: p["_private_before_images"].__setitem__(
                1, deepcopy(p["_private_before_images"][0])
            ),
            "missing relationship": lambda p: p["_private_before_images"][0].__setitem__("safe_identity_hash", "missing"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                plan = self.approved_synthetic_plan()
                mutate(plan)
                self.assertIn("before_image_mapping_mismatch", approved_plan_errors(plan))

    def test_scope_guard_rejects_accounting_and_lineage_changes(self):
        changes = (
            ("before_image_count", 5, "rollback_evidence_shape_mismatch"),
            ("before_image_count", 7, "rollback_evidence_shape_mismatch"),
            ("created_entity_count", 27, "created_entity_count_mismatch"),
        )
        for key, value, expected in changes:
            with self.subTest(key=key, value=value):
                plan = self.approved_synthetic_plan(); plan[key] = value
                self.assertIn(expected, approved_plan_errors(plan))
        for key in ("potential_source_conflict", "potential_entity_conflict", "unresolved"):
            with self.subTest(lineage=key):
                plan = self.approved_synthetic_plan(); plan["lineage_operations"][key] = 1
                self.assertIn("approved_lineage_integrity_mismatch", approved_plan_errors(plan))

    def test_scope_guard_rejects_blockers_and_nonready_status(self):
        plan = self.approved_synthetic_plan()
        plan["status"] = "blocked"
        self.assertIn("approved_plan_not_ready", approved_plan_errors(plan))
        plan = self.approved_synthetic_plan()
        plan["blockers"] = [{"reason": "synthetic_blocker"}]
        self.assertIn("approved_plan_not_ready", approved_plan_errors(plan))

    def test_scope_guard_requires_unique_identity_source_and_precondition_bindings(self):
        mutations = {
            "duplicate executable identity": lambda p: p["items"][1].__setitem__(
                "safe_identity_hash", p["items"][0]["safe_identity_hash"]
            ),
            "missing private source": lambda p: p["_private_source_rows"].pop(p["items"][0]["safe_identity_hash"]),
            "missing update precondition": lambda p: p["_private_target_preconditions"].pop(next(
                item["safe_identity_hash"] for item in p["items"] if item["operation"] == "update"
            )),
        }
        expected = {
            "duplicate executable identity": "executable_identity_binding_mismatch",
            "missing private source": "executable_source_binding_missing",
            "missing update precondition": "update_target_precondition_missing",
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                plan = self.approved_synthetic_plan()
                mutate(plan)
                self.assertIn(expected[name], approved_plan_errors(plan))

    def test_scope_guard_requires_exact_34_operation_accounting(self):
        for updates in (5, 7):
            with self.subTest(updates=updates):
                plan = self.approved_synthetic_plan(); plan["canonical_operations"]["updates"] = updates
                self.assertIn("canonical_operation_count_mismatch", approved_plan_errors(plan))
        plan = self.approved_synthetic_plan()
        session_update = next(
            item for item in plan["items"]
            if item["entity_type"] == "candidate_sessions" and item["operation"] == "update"
        )
        session_update["entity_type"] = "notifications"
        self.assertIn("approved_update_shape_mismatch", approved_plan_errors(plan))

    def test_scope_guard_rejects_same_total_with_wrong_insert_distribution(self):
        plan = self.approved_synthetic_plan()
        candidate = next(item for item in plan["items"] if item["entity_type"] == "candidates")
        candidate["entity_type"] = "candidate_sessions"
        self.assertIn("approved_insert_shape_mismatch", approved_plan_errors(plan))

    def test_authorized_update_field_contract_is_exact(self):
        self.assertEqual(APPROVED_UPDATE_FIELDS, {
            "candidate_sessions": (
                "raw_status", "calculated_result", "final_result", "needs_sup_transfer",
                "pending_sup_transfer_id", "session_type", "completed_at",
            ),
            "candidate_corrections": ("candidate_id",),
        })

    def test_scope_guard_rejects_altered_session_state_or_relationship_evidence(self):
        mutations = {
            "contradictory result": lambda p, item: p["_private_source_rows"][item["safe_identity_hash"]].__setitem__("final_result", "Fail"),
            "still needs transfer": lambda p, item: p["_private_source_rows"][item["safe_identity_hash"]].__setitem__("needs_sup_transfer", True),
            "dangling proposed transfer": lambda p, item: p["_private_source_rows"][item["safe_identity_hash"]].__setitem__("pending_sup_transfer_id", "missing"),
            "wrong prior relationship": lambda p, item: p["_private_target_preconditions"][item["safe_identity_hash"]].__setitem__("pending_sup_transfer_id", "wrong"),
            "wrong prior status": lambda p, item: p["_private_target_preconditions"][item["safe_identity_hash"]].__setitem__("raw_status", "Pass"),
            "missing transfer relationship": lambda p, item: p["items"].__setitem__(slice(None), [
                row for row in p["items"] if row["entity_type"] != "supervisor_transfers" or row["classification"] != "already_current"
            ]),
            "wrong transfer session": lambda p, item: next(
                p["_private_source_rows"][row["safe_identity_hash"]]
                for row in p["items"] if row["entity_type"] == "supervisor_transfers" and row["classification"] == "already_current"
            ).__setitem__("original_session_id", "different-session"),
            "unexpected insert dependency": lambda p, item: item.__setitem__("dependencies", [{"entity_type": "supervisor_transfers", "safe_identity_hash": "x"}]),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                plan = self.approved_synthetic_plan()
                session_item = next(
                    item for item in plan["items"]
                    if item["entity_type"] == "candidate_sessions" and item["operation"] == "update"
                )
                mutate(plan, session_item)
                self.assertTrue(any(
                    error.startswith("approved_session_") for error in approved_plan_errors(plan)
                ))

    def test_all_inserts_execute_before_the_reviewed_session_update(self):
        provider = FakeExecutionProvider()
        execute_plan(provider, self.approved_synthetic_plan())
        session_update_index = provider.calls.index("update")
        self.assertEqual(provider.calls[1:session_update_index].count("insert"), 28)
        self.assertNotIn("insert", provider.calls[session_update_index + 1:])

    def test_28_plus_6_rollback_preview_accounts_for_only_batch_owned_changes(self):
        plan = self.approved_synthetic_plan()
        inserted = [item for item in plan["items"] if item["operation"] == "insert"]
        updates = [item for item in plan["items"] if item["operation"] == "update"]
        batch = {
            "batch_id": "synthetic-28-plus-6", "status": "succeeded",
            "created_items": [
                {"safe_identity_hash": item["safe_identity_hash"], "post_sync_checksum": "after"}
                for item in inserted
            ],
            "before_images": deepcopy(plan["_private_before_images"]),
            "rollback": {"delete_order": [
                "newbie_shift_reschedules", "session_attempts", "supervisor_transfers",
                "headset_reviews", "newbie_shift_requests", "candidate_corrections",
                "pending_requests", "candidate_sessions", "headset_catalog", "candidates",
            ]},
        }
        current = {item["safe_identity_hash"]: "after" for item in inserted}
        preview = rollback_preview(batch, current_checksums=current)
        self.assertTrue(preview["eligible"])
        self.assertEqual(preview["delete_created"], 28)
        self.assertEqual(preview["restore_updates"], 6)
        self.assertEqual(len(plan["_private_before_images"]), len(updates))
        session_images = [
            image for image in plan["_private_before_images"]
            if image.get("safe_identity_hash") == next(
                item["safe_identity_hash"] for item in updates if item["entity_type"] == "candidate_sessions"
            )
        ]
        correction_hashes = {
            item["safe_identity_hash"] for item in updates if item["entity_type"] == "candidate_corrections"
        }
        correction_images = [
            image for image in plan["_private_before_images"]
            if image.get("safe_identity_hash") in correction_hashes
        ]
        self.assertEqual(len(session_images), 1)
        self.assertEqual(set(session_images[0]["fields"]), set(APPROVED_UPDATE_FIELDS["candidate_sessions"]))
        self.assertEqual(len(correction_images), 5)
        self.assertTrue(all(set(image["fields"]) == {"candidate_id"} for image in correction_images))
        self.assertEqual(sum(item["entity_type"] == "candidate_sessions" for item in updates), 1)
        self.assertEqual(sum(item["entity_type"] == "candidate_corrections" for item in updates), 5)
        self.assertEqual(plan["lineage_operations"]["expected_new"], 28)
        self.assertEqual(plan["lineage_operations"]["expected_same_mapping"], 155)
        self.assertTrue(preview["preserve_audit_evidence"])
        self.assertLess(
            preview["delete_order"].index("session_attempts"),
            preview["delete_order"].index("candidate_sessions"),
        )


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

    def test_remaining_drift_migration_is_candidate_id_only_and_rollback_complete(self):
        path = Path(__file__).resolve().parents[1] / "supabase" / "migrations" / "20260811022016_reconcile_remaining_projected_drift.sql"
        sql = path.read_text(encoding="utf-8").casefold()
        for token in (
            "execute_reconciliation_candidate_correction_update", "array['candidate_id']",
            "stable_parent_session_not_exact", "correction_session_fk_mismatch",
            "candidate_not_proven_by_stable_session", "update_row_count_mismatch",
            "reconciliation_before_images", "post_write_value_mismatch",
            "rollback_restore_checksum_mismatch", "candidate_corrections set candidate_id=v_correction.candidate_id",
            "session_type=v_after.session_type", "completed_at=v_after.completed_at",
            "reconciliation_runtime_capabilities", "candidate_correction_update",
            "grant select on mts_sam.reconciliation_runtime_capabilities to service_role",
            "unsupported_session_type_change", "completed_at_clear_not_allowed",
            "perform (p_changes->>'completed_at')::timestamptz", "candidate_id_required",
        ):
            self.assertIn(token, sql)
        self.assertIn("from public,anon,authenticated", sql)
        self.assertIn("to service_role", sql)
        self.assertNotIn("execute format", sql)
        correction_update = sql.split("create function mts_sam.execute_reconciliation_candidate_correction_update", 1)[1]
        correction_update = correction_update.split("create or replace function mts_sam.rollback_reconciliation_batch", 1)[0]
        self.assertNotIn("candidate_name", correction_update)
        self.assertNotIn("source_session_id=", correction_update)
        self.assertNotIn("request_id=", correction_update)

    def test_timestamp_normalization_migration_is_exact_narrow_and_private(self):
        path = Path(__file__).resolve().parents[1] / "supabase" / "migrations" / "20260815204523_normalize_reconciliation_session_timestamps.sql"
        sql = path.read_text(encoding="utf-8").casefold()
        for token in (
            "execute_reconciliation_candidate_session_update", "expected_fields_do_not_match_plan",
            "completed_at_expected_invalid", "(v_expected_values->>'completed_at')::timestamptz",
            "to_jsonb(v_after) @> v_expected_values", "post_write_value_mismatch",
            "reconciliation_entity_checksum", "reconciliation_before_images",
            "changed_fields_do_not_match_plan", "set search_path = ''",
            "from public,anon,authenticated", "to service_role",
        ):
            self.assertIn(token, sql)
        self.assertEqual(sql.count("jsonb_set("), 1)
        self.assertIn("'{completed_at}'", sql)
        self.assertNotIn("2026-08-02t22:25:21", sql)
        self.assertNotIn("execute format", sql)
        self.assertNotIn("delete from mts_sam.candidate_sessions", sql)
        self.assertNotIn("reconciliation_entity_checksum('candidate_sessions',v_item.canonical_entity_id) is distinct", sql)

    def test_timestamp_regression_requires_same_instant_not_same_string(self):
        source = datetime.datetime.fromisoformat("2026-08-02T22:25:21.860957-04:00")
        hosted = datetime.datetime.fromisoformat("2026-08-03T02:25:21.860957+00:00")
        different = datetime.datetime.fromisoformat("2026-08-03T02:25:21.860958+00:00")
        self.assertNotEqual(source.isoformat(), hosted.isoformat())
        self.assertEqual(source, hosted)
        self.assertNotEqual(source, different)

    def test_null_empty_and_non_timestamp_values_remain_exact(self):
        self.assertNotEqual("", None)
        self.assertNotEqual(False, "false")
        self.assertNotEqual("RESUMED-PASS", "RESUMED_PASS")


if __name__ == "__main__":
    unittest.main()

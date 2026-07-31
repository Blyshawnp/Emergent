import asyncio
import copy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402


class CandidateCorrectionRequestTests(unittest.TestCase):
    def test_normalization_allows_only_bounded_changed_fields(self):
        changes = server._normalize_correction_changes([
            {"field": "candidate_name", "previous_value": "Taylr Example", "requested_value": "Taylor Example"},
            {"field": "headset_model", "previous_value": "Jabra Evovle", "requested_value": "Jabra Evolve"},
        ])
        self.assertEqual([item["field"] for item in changes], ["candidate_name", "headset_model"])
        self.assertEqual(changes[0]["label"], "Candidate Name")
        capitalization = server._normalize_correction_changes([
            {"field": "candidate_name", "previous_value": "taylor example", "requested_value": "Taylor Example"},
        ])
        self.assertEqual(capitalization[0]["requested_value"], "Taylor Example")
        with self.assertRaisesRegex(ValueError, "correction_unsupported_field"):
            server._normalize_correction_changes([{"field": "attempt_number", "previous_value": "1", "requested_value": "2"}])
        with self.assertRaisesRegex(ValueError, "correction_no_changes"):
            server._normalize_correction_changes([{"field": "candidate_name", "previous_value": "Same", "requested_value": " Same "}])

    def test_separate_brand_and_model_build_one_deduplicated_display_label(self):
        self.assertEqual(server._headset_display_label("Logitech", "H390"), "Logitech H390")
        self.assertEqual(server._headset_display_label("Logitech", "Logitech H390"), "Logitech H390")
        legacy = server._apply_headset_correction_values(
            {"headset_brand": "Logitec H390"},
            [{"field": "headset_model", "previous_value": "Logitec H390", "requested_value": "Logitech H390"}],
        )
        self.assertEqual(legacy, {"brand": "", "model": "", "label": "Logitech H390", "separate": False})

    def test_pending_counts_exclude_resolved_corrections(self):
        requests = [
            {"category": "candidate_correction", "raw_status": "pending"},
            {"category": "candidate_correction", "raw_status": "approved"},
            {"category": "candidate_deletion", "raw_status": "denied"},
        ]
        counts = server._request_category_counts(requests)
        self.assertEqual(counts["workflowRequests"], 1)
        self.assertEqual(counts["candidateCorrections"], 1)
        self.assertEqual(counts["candidateDeletions"], 0)

    @mock.patch("server._shared_update_existing_row")
    @mock.patch("server._shared_read_rows")
    def test_direct_correction_uses_exact_session_and_is_idempotent(self, read_rows, update_row):
        candidate = {"session_id": "session-1", "candidate_name": "Taylr Example", "headset_brand": "Jabra Evolve 40", "_row_number": 2}
        read_rows.side_effect = [[candidate], []]
        result = server._apply_candidate_correction_direct(
            mock.MagicMock(), "sheet-id", "session-1",
            [{"field": "candidate_name", "previous_value": "Taylr Example", "requested_value": "Taylor Example"}],
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["updated"], 1)
        update_row.assert_called_once()

        update_row.reset_mock()
        candidate["candidate_name"] = "Taylor Example"
        read_rows.side_effect = [[candidate]]
        repeated = server._apply_candidate_correction_direct(
            mock.MagicMock(), "sheet-id", "session-1",
            [{"field": "candidate_name", "previous_value": "Taylr Example", "requested_value": "Taylor Example"}],
        )
        self.assertTrue(repeated["already_applied"])
        update_row.assert_not_called()

    @mock.patch("server._shared_update_existing_row")
    @mock.patch("server._shared_read_rows")
    def test_headset_typo_correction_never_starts_headset_review(self, read_rows, update_row):
        candidate = {"session_id": "session-1", "candidate_name": "Taylor Example", "headset_brand": "Logitec Zone 300", "_row_number": 2}
        read_rows.side_effect = [[candidate], []]
        result = server._apply_candidate_correction_direct(
            mock.MagicMock(), "sheet-id", "session-1",
            [{"field": "headset_model", "previous_value": "Logitec Zone 300", "requested_value": "Logitech Zone 300"}],
        )
        self.assertTrue(result["ok"])
        self.assertNotIn("headset_review_required", result)
        update_row.assert_called_once()

    @mock.patch("server._append_headset_review_log")
    @mock.patch("server._shared_update_existing_row")
    @mock.patch("server._shared_read_rows")
    def test_brand_only_correction_updates_candidate_session_without_catalog_or_review(self, read_rows, update_row, append_review):
        candidate = {"session_id": "session-brand", "candidate_name": "Taylor", "headset_brand": "Logitec H390", "_row_number": 2}
        read_rows.side_effect = [[candidate], []]
        approved_before = copy.deepcopy(server.EXTERNAL_CONTENT.get("approved_headsets"))
        result = server._apply_candidate_correction_direct(
            mock.MagicMock(), "sheet-id", "session-brand",
            [{"field": "headset_brand", "previous_value": "Logitec", "requested_value": "Logitech"}],
        )
        self.assertTrue(result["ok"])
        self.assertEqual(candidate["headset_brand"], "Logitech H390")
        self.assertEqual(server.EXTERNAL_CONTENT.get("approved_headsets"), approved_before)
        self.assertEqual(read_rows.call_args_list[0].args[2], server.SHARED_CANDIDATE_SESSIONS_TAB)
        update_row.assert_called_once()
        append_review.assert_not_called()

    @mock.patch("server._append_headset_review_log")
    @mock.patch("server._shared_update_existing_row")
    @mock.patch("server._shared_read_rows")
    def test_model_only_correction_updates_combined_candidate_label_without_review(self, read_rows, update_row, append_review):
        candidate = {"session_id": "session-model", "candidate_name": "Taylor", "headset_brand": "Logitech H390x", "_row_number": 2}
        read_rows.return_value = [candidate]
        result = server._apply_candidate_correction_direct(
            mock.MagicMock(), "sheet-id", "session-model",
            [{"field": "headset_model", "previous_value": "H390x", "requested_value": "H390"}],
        )
        self.assertTrue(result["ok"])
        self.assertEqual(candidate["headset_brand"], "Logitech H390")
        update_row.assert_called_once()
        append_review.assert_not_called()

    def test_sam_direct_edit_requires_audit_reason_before_transport(self):
        result = server._shared_admin_candidate_action({
            "action": "edit_candidate_information", "candidate_name": "Taylor Example",
            "session_id": "session-1", "reason": "",
            "changes": [{"field": "candidate_name", "previous_value": "Taylr Example", "requested_value": "Taylor Example"}],
        })
        self.assertFalse(result["ok"])
        self.assertEqual(result["error_code"], "correction_reason_required")

    @mock.patch("server._shared_read_rows", return_value=[])
    def test_direct_correction_does_not_match_candidate_name(self, _read_rows):
        result = server._apply_candidate_correction_direct(
            mock.MagicMock(), "sheet-id", "missing-session",
            [{"field": "candidate_name", "previous_value": "Taylor", "requested_value": "Taylor Example"}],
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error_code"], "correction_target_not_found")

    @mock.patch("server._shared_update_existing_row")
    @mock.patch("server._shared_read_rows")
    def test_terminal_deletion_reconciliation_is_idempotent(self, read_rows, update_row):
        read_rows.side_effect = [
            [{"session_id": "session-1", "archived": True, "status": "REMOVED", "_row_number": 2}],
            [{"original_session_id": "session-1", "status": "cancelled", "_row_number": 2}],
            [],
            [],
        ]
        result = server._apply_candidate_deletion_terminal_direct(mock.MagicMock(), "sheet-id", "session-1", "delete-1")
        self.assertTrue(result["already_applied"])
        self.assertEqual(result["updated"], 0)
        self.assertEqual(result["pendingUpdated"], 0)
        update_row.assert_not_called()

    def test_approved_correction_reconciles_local_history_once_without_changing_attempts(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = server.SQLiteDocumentStore(Path(temp_dir) / "correction.sqlite3")
            asyncio.run(store.history.insert_one({
                "history_id": "session-1", "candidate": "Taylr Example", "candidate_name": "Taylr Example",
                "headset_brand": "Jabra Evolve 40", "attempt_number": 2, "status": "PASS",
                "candidate_correction_request_id": "correction-1", "candidate_correction_status": "pending",
                "candidate_correction_pending": True,
            }))
            remote = [{
                "request_id": "correction-1", "session_id": "session-1", "raw_status": "approved",
                "admin_decision_at": "2026-07-26T12:00:00Z", "admin_decision_by": "SAM Admin",
                "changes": [{"field": "candidate_name", "label": "Candidate Name", "previous_value": "Taylr Example", "requested_value": "Taylor Example"}],
            }]
            with mock.patch.object(server, "db", store), mock.patch.object(server, "_fetch_remote_correction_requests", return_value=remote):
                first = server._reconcile_remote_corrections_into_local_history()
                second = server._reconcile_remote_corrections_into_local_history()
            record = store.history._read_history_docs()[0]
            self.assertEqual(first["historyUpdated"], 1)
            self.assertEqual(second["historyUpdated"], 0)
            self.assertEqual(record["candidate_name"], "Taylor Example")
            self.assertEqual(record["attempt_number"], 2)
            self.assertEqual(record["status"], "PASS")
            self.assertFalse(record["candidate_correction_pending"])
            store.conn.close()

    def test_denied_correction_preserves_authoritative_values(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = server.SQLiteDocumentStore(Path(temp_dir) / "correction.sqlite3")
            asyncio.run(store.history.insert_one({
                "history_id": "session-1", "candidate_name": "Taylor Example", "headset_brand": "Jabra Evolve 40",
                "candidate_correction_request_id": "correction-1", "candidate_correction_status": "pending", "candidate_correction_pending": True,
            }))
            remote = [{
                "request_id": "correction-1", "session_id": "session-1", "raw_status": "denied",
                "denial_reason": "Authoritative entry was correct.",
                "changes": [{"field": "headset_model", "label": "Headset Model", "previous_value": "Jabra Evolve 40", "requested_value": "Other Model"}],
            }]
            with mock.patch.object(server, "db", store), mock.patch.object(server, "_fetch_remote_correction_requests", return_value=remote):
                server._reconcile_remote_corrections_into_local_history()
            record = store.history._read_history_docs()[0]
            self.assertEqual(record["headset_brand"], "Jabra Evolve 40")
            self.assertEqual(record["candidate_correction_denial_reason"], "Authoritative entry was correct.")
            self.assertFalse(record["candidate_correction_pending"])
            store.conn.close()

    def test_authoritative_candidate_sync_uses_exact_session_and_preserves_workflow_fields(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = server.SQLiteDocumentStore(Path(temp_dir) / "correction.sqlite3")
            protected = {
                "status": "PASS", "final_status": "Pass", "attempt_number": 2,
                "form_fill_status": "filled", "review_summary": "Preserve this",
            }
            asyncio.run(store.history.insert_one({
                "history_id": "session-1", "candidate": "taylor example", "candidate_name": "taylor example",
                "headset_brand": "Old Headset", **protected,
            }))
            asyncio.run(store.history.insert_one({
                "history_id": "session-2", "candidate": "taylor example", "candidate_name": "taylor example",
                "headset_brand": "Other Headset", **protected,
            }))
            remote = [{
                "session_id": "session-1", "candidate_name": "Taylor Example", "headset_brand": "New Headset",
            }]
            with mock.patch.object(server, "db", store):
                result = server._reconcile_authoritative_candidate_information(remote)
            records = {row["history_id"]: row for row in store.history._read_history_docs()}
            self.assertEqual(result["historyUpdated"], 1)
            self.assertEqual(len(records), 2)
            self.assertEqual(records["session-1"]["candidate_name"], "Taylor Example")
            self.assertEqual(records["session-1"]["headset_brand"], "New Headset")
            self.assertEqual(records["session-2"]["headset_brand"], "Other Headset")
            for key, value in protected.items():
                self.assertEqual(records["session-1"][key], value)
            store.conn.close()

    def test_authoritative_separate_headset_fields_update_combined_history_display(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = server.SQLiteDocumentStore(Path(temp_dir) / "correction.sqlite3")
            asyncio.run(store.history.insert_one({
                "history_id": "session-1", "candidate_name": "Taylor",
                "headset_brand": "Old Combined", "status": "PASS",
            }))
            with mock.patch.object(server, "db", store):
                result = server._reconcile_authoritative_candidate_information([{
                    "session_id": "session-1", "candidate_name": "Taylor",
                    "headset_brand": "Logitech", "headset_model": "H390",
                }])
            record = store.history._read_history_docs()[0]
            self.assertEqual(result["historyUpdated"], 1)
            self.assertEqual(record["headset_brand"], "Logitech")
            self.assertEqual(record["headset_model"], "H390")
            self.assertEqual(record["headset_label"], "Logitech H390")
            self.assertEqual(record["status"], "PASS")
            store.conn.close()

    def test_authoritative_candidate_sync_rejects_ambiguous_or_mismatched_identity(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = server.SQLiteDocumentStore(Path(temp_dir) / "correction.sqlite3")
            asyncio.run(store.history.insert_one({
                "history_id": "session-1", "candidate_id": "candidate-1",
                "candidate_name": "Original", "headset_brand": "Original Headset",
            }))
            with mock.patch.object(server, "db", store):
                ambiguous = server._reconcile_authoritative_candidate_information([
                    {"session_id": "session-1", "candidate_name": "First"},
                    {"session_id": "session-1", "candidate_name": "Second"},
                ])
                mismatched = server._reconcile_authoritative_candidate_information([
                    {"session_id": "session-1", "candidate_id": "candidate-2", "candidate_name": "Wrong"},
                ])
            record = store.history._read_history_docs()[0]
            self.assertEqual(ambiguous["ambiguousSessionIds"], 1)
            self.assertEqual(ambiguous["historyUpdated"], 0)
            self.assertEqual(mismatched["historyUpdated"], 0)
            self.assertEqual(record["candidate_name"], "Original")
            store.conn.close()

    def test_local_history_read_does_not_wait_for_remote_reconciliation(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = server.SQLiteDocumentStore(Path(temp_dir) / "correction.sqlite3")
            asyncio.run(store.history.insert_one({"history_id": "session-local", "candidate_name": "Synthetic"}))
            with (
                mock.patch.object(server, "db", store),
                mock.patch.object(server, "_reconcile_remote_newbie_requests_into_local_state") as newbie,
                mock.patch.object(server, "_reconcile_remote_corrections_into_local_history") as corrections,
                mock.patch.object(server, "_reconcile_remote_candidate_information_into_local_history") as candidates,
            ):
                result = asyncio.run(server.get_history())
            self.assertEqual(len(result), 1)
            newbie.assert_not_called()
            corrections.assert_not_called()
            candidates.assert_not_called()
            store.conn.close()


if __name__ == "__main__":
    unittest.main()

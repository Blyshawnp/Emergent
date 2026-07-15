import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402


def local_record(**overrides):
    record = {
        "history_id": "session-1",
        "newbie_shift_request_id": "request-1",
        "newbie_shift_request_status": "pending",
        "newbie_shift_admin_decision_at": "",
        "newbie_shift_admin_decision_by": "",
        "newbie_shift_denial_reason": "",
        "form_fill_status": "filled",
        "call_1": {"result": "Pass"},
        "trainer_notes": "Keep this note",
        "candidate_name": "Taylor Example",
    }
    record.update(overrides)
    return record


def remote_request(**overrides):
    request = {
        "request_id": "request-1",
        "source_session_id": "session-1",
        "request_type": "newbie_shift_reschedule",
        "status": "approved",
        "decision_at": "2026-07-14T16:00:00+00:00",
        "decision_by": "SAM Admin",
        "denial_reason": "",
        "requested_scheduled_at": "2026-07-16T14:00:00-04:00",
        "timezone": "EST (Eastern)",
        "updated_at": "2026-07-14T16:00:00+00:00",
    }
    request.update(overrides)
    return request


class PendingRequestReconciliationTests(unittest.TestCase):
    def reconcile(self, local, remote):
        return server._reconcile_local_newbie_request_record(local, remote)

    def test_local_pending_remote_approved_updates_only_request_fields(self):
        before = local_record()
        reconciled, changed, match = self.reconcile(before, remote_request())

        self.assertTrue(changed)
        self.assertEqual(match, "request_id")
        self.assertEqual(reconciled["newbie_shift_request_status"], "approved")
        self.assertEqual(reconciled["newbie_shift_scheduled_at"], "2026-07-16T14:00:00-04:00")
        self.assertEqual(reconciled["newbie_shift_timezone"], "EST (Eastern)")
        self.assertEqual(reconciled["call_1"], before["call_1"])
        self.assertEqual(reconciled["trainer_notes"], before["trainer_notes"])
        self.assertEqual(reconciled["candidate_name"], before["candidate_name"])
        self.assertEqual(reconciled["form_fill_status"], "filled")

    def test_local_pending_remote_denied_persists_reason_admin_and_time(self):
        reconciled, changed, _match = self.reconcile(
            local_record(),
            remote_request(status="denied", denial_reason="Schedule unavailable"),
        )

        self.assertTrue(changed)
        self.assertEqual(reconciled["newbie_shift_request_status"], "denied")
        self.assertEqual(reconciled["newbie_shift_denial_reason"], "Schedule unavailable")
        self.assertEqual(reconciled["newbie_shift_admin_decision_by"], "SAM Admin")
        self.assertEqual(reconciled["newbie_shift_admin_decision_at"], "2026-07-14T16:00:00+00:00")

    def test_remote_pending_cannot_downgrade_local_approved(self):
        local = local_record(
            newbie_shift_request_status="approved",
            newbie_shift_admin_decision_at="2026-07-14T16:00:00+00:00",
        )
        reconciled, changed, reason = self.reconcile(local, remote_request(status="pending"))
        self.assertFalse(changed)
        self.assertEqual(reason, "remote_pending")
        self.assertEqual(reconciled, local)

    def test_remote_pending_cannot_downgrade_local_denied(self):
        local = local_record(
            newbie_shift_request_status="denied",
            newbie_shift_denial_reason="No availability",
            newbie_shift_admin_decision_at="2026-07-14T16:00:00+00:00",
        )
        reconciled, changed, _reason = self.reconcile(local, remote_request(status="pending"))
        self.assertFalse(changed)
        self.assertEqual(reconciled["newbie_shift_request_status"], "denied")
        self.assertEqual(reconciled["newbie_shift_denial_reason"], "No availability")

    def test_newer_resolved_timestamp_wins(self):
        local = local_record(
            newbie_shift_request_status="approved",
            newbie_shift_admin_decision_at="2026-07-14T15:00:00+00:00",
        )
        reconciled, changed, _reason = self.reconcile(
            local,
            remote_request(status="denied", denial_reason="Updated decision"),
        )
        self.assertTrue(changed)
        self.assertEqual(reconciled["newbie_shift_request_status"], "denied")

    def test_older_or_untimestamped_resolved_state_is_conservative(self):
        local = local_record(
            newbie_shift_request_status="denied",
            newbie_shift_denial_reason="Current decision",
            newbie_shift_admin_decision_at="2026-07-14T17:00:00+00:00",
        )
        older, older_changed, _reason = self.reconcile(
            local,
            remote_request(status="approved", decision_at="2026-07-14T16:00:00+00:00"),
        )
        missing, missing_changed, _reason = self.reconcile(
            local,
            remote_request(status="approved", decision_at=""),
        )
        self.assertFalse(older_changed)
        self.assertFalse(missing_changed)
        self.assertEqual(older["newbie_shift_request_status"], "denied")
        self.assertEqual(missing["newbie_shift_request_status"], "denied")

    def test_wrong_request_id_is_ignored_even_when_session_id_matches(self):
        reconciled, changed, reason = self.reconcile(
            local_record(),
            remote_request(request_id="different-request"),
        )
        self.assertFalse(changed)
        self.assertEqual(reason, "request_id_mismatch")
        self.assertEqual(reconciled["newbie_shift_request_status"], "pending")

    def test_wrong_source_session_id_is_ignored(self):
        reconciled, changed, reason = self.reconcile(
            local_record(newbie_shift_request_id=""),
            remote_request(source_session_id="different-session"),
        )
        self.assertFalse(changed)
        self.assertEqual(reason, "missing_or_mismatched_identifiers")
        self.assertEqual(reconciled["newbie_shift_request_status"], "pending")

    def test_source_session_id_is_valid_fallback_when_local_request_id_missing(self):
        reconciled, changed, match = self.reconcile(
            local_record(newbie_shift_request_id=""),
            remote_request(status="approved"),
        )
        self.assertTrue(changed)
        self.assertEqual(match, "source_session_id")
        self.assertEqual(reconciled["newbie_shift_request_id"], "request-1")
        self.assertEqual(reconciled["newbie_shift_request_status"], "approved")

    def test_old_record_missing_both_identifiers_is_not_guessed_by_name(self):
        old = local_record(history_id="", session_id="", resume_source_history_id="", newbie_shift_request_id="")
        reconciled, changed, reason = self.reconcile(old, remote_request())
        self.assertFalse(changed)
        self.assertEqual(reason, "missing_or_mismatched_identifiers")
        self.assertEqual(reconciled["candidate_name"], "Taylor Example")

    def test_reconciliation_is_idempotent(self):
        first, first_changed, _reason = self.reconcile(local_record(), remote_request())
        second, second_changed, _reason = self.reconcile(first, remote_request())
        self.assertTrue(first_changed)
        self.assertFalse(second_changed)
        self.assertEqual(second, first)

    def test_matching_request_id_with_conflicting_source_session_is_ignored(self):
        reconciled, changed, reason = self.reconcile(
            local_record(),
            remote_request(source_session_id="another-session"),
        )
        self.assertFalse(changed)
        self.assertEqual(reason, "source_session_conflict")
        self.assertEqual(reconciled["newbie_shift_request_status"], "pending")

    def test_direct_request_sync_preserves_remote_resolution(self):
        existing = {
            "request_id": "request-1",
            "session_id": "session-1",
            "request_status": "approved",
            "admin_decision_at": "2026-07-14T16:00:00+00:00",
            "admin_decision_by": "SAM Admin",
            "scheduled_at": "2026-07-16T14:00:00-04:00",
        }
        with mock.patch.object(server, "_shared_update_or_append_row", return_value="updated") as update_row:
            result = server._sync_newbie_shift_request(
                local_record(),
                mock.MagicMock(),
                "test-sheet",
                existing_rows=[existing],
            )

        values = update_row.call_args.args[-1]
        status_index = server.SHARED_NEWBIE_SHIFT_REQUEST_HEADERS.index("request_status")
        self.assertEqual(result, "updated")
        self.assertEqual(values[status_index], "approved")

    def test_reconciled_status_persists_after_sqlite_reopen(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            database_path = Path(temp_dir) / "reconciliation.sqlite3"
            local_store = server.SQLiteDocumentStore(database_path)
            asyncio.run(local_store.history.insert_one(local_record()))
            snapshot = {"ok": True, "requests": [remote_request(status="denied", denial_reason="No capacity")], "source": "test"}

            with mock.patch.object(server, "db", local_store), \
                 mock.patch.object(server, "_remote_newbie_request_snapshot", return_value=snapshot):
                result = server._reconcile_remote_newbie_requests_into_local_state(force=True)

            reopened_store = server.SQLiteDocumentStore(database_path)
            reopened = reopened_store.history._read_history_docs()[0]
            self.assertTrue(result["ok"])
            self.assertEqual(result["historyUpdated"], 1)
            self.assertEqual(reopened["newbie_shift_request_status"], "denied")
            self.assertEqual(reopened["newbie_shift_denial_reason"], "No capacity")
            self.assertEqual(reopened["form_fill_status"], "filled")
            local_store.conn.close()
            reopened_store.conn.close()


if __name__ == "__main__":
    unittest.main()

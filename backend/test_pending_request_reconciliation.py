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

    def test_sam_candidate_snapshot_uses_resolved_request_state(self):
        candidate = local_record(session_id="session-1")
        snapshot = {
            "ok": True,
            "candidates": [candidate],
            "views": {"allActive": [candidate], "passedCertifications": [candidate]},
        }
        requests = {
            "ok": True,
            "requests": [{
                "request_id": "request-1",
                "session_id": "session-1",
                "category": "newbie_reschedule",
                "raw_status": "approved",
                "admin_decision_at": "2026-07-14T16:00:00+00:00",
                "admin_decision_by": "SAM Admin",
            }],
        }

        reconciled = server._reconcile_candidate_tracking_with_requests(snapshot, requests)

        self.assertEqual(reconciled["candidates"][0]["newbie_shift_request_status"], "approved")
        self.assertEqual(reconciled["views"]["allActive"][0]["newbie_shift_request_status"], "approved")
        self.assertEqual(reconciled["candidates"][0]["form_fill_status"], "filled")

    def test_sam_candidate_snapshot_does_not_apply_remote_pending_over_resolution(self):
        candidate = local_record(
            session_id="session-1",
            newbie_shift_request_status="denied",
            newbie_shift_admin_decision_at="2026-07-14T16:00:00+00:00",
            newbie_shift_denial_reason="No availability",
        )
        snapshot = {"ok": True, "candidates": [candidate], "views": {"allActive": [candidate]}}
        requests = {
            "ok": True,
            "requests": [{"request_id": "request-1", "session_id": "session-1", "raw_status": "pending"}],
        }

        reconciled = server._reconcile_candidate_tracking_with_requests(snapshot, requests)

        self.assertEqual(reconciled["candidates"][0]["newbie_shift_request_status"], "denied")
        self.assertEqual(reconciled["candidates"][0]["newbie_shift_denial_reason"], "No availability")

    def test_matching_request_id_with_conflicting_source_session_is_ignored(self):
        reconciled, changed, reason = self.reconcile(
            local_record(),
            remote_request(source_session_id="another-session"),
        )
        self.assertFalse(changed)
        self.assertEqual(reason, "source_session_conflict")
        self.assertEqual(reconciled["newbie_shift_request_status"], "pending")

    def test_direct_request_sync_refuses_to_reuse_remote_resolution(self):
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

        self.assertEqual(result, "already_resolved")
        update_row.assert_not_called()

    def test_request_only_sync_uses_apps_script_upsert_without_candidate_tracking_write(self):
        client = mock.MagicMock()
        client.post.return_value = {"action": "updated"}
        context = {"ok": True, "appsScriptClient": client}
        session = local_record(
            session_id="session-1",
            newbie_shift_request_type="reschedule",
            newbie_shift_request_created_at="2026-07-18T12:00:00Z",
            newbie_shift_original_scheduled_at="2026-07-20T10:00:00-05:00",
            newbie_shift_request_reason="Scheduling conflict",
            newbie_shift_requested_by="tester",
            newbie_shift_rescheduled_at="2026-07-20T10:00:00-05:00",
        )

        with mock.patch.object(server, "_shared_sheet_context", return_value=context):
            result = server._sync_newbie_shift_request_only(session)

        self.assertTrue(result["ok"])
        client.post.assert_called_once()
        action, payload = client.post.call_args.args
        self.assertEqual(action, "upsertPendingRequest")
        self.assertEqual(payload["request"]["request_type"], "newbie_shift_reschedule")
        self.assertEqual(payload["request"]["requested_by"], "tester")
        self.assertEqual(payload["request"]["original_scheduled_at"], "2026-07-20T10:00:00-05:00")
        self.assertEqual(payload["request"]["rescheduled_at"], "2026-07-20T10:00:00-05:00")

    def test_public_sam_request_accepts_canonical_previous_and_requested_schedule_names(self):
        request = server._public_newbie_request({
            "request_id": "request-1",
            "request_type": "reschedule",
            "original_schedule": "2026-07-20T10:00:00-05:00",
            "requested_scheduled_at": "2026-07-22T11:30:00-05:00",
        })

        self.assertEqual(request["original_schedule"], "2026-07-20T10:00:00-05:00")
        self.assertEqual(request["requested_schedule"], "2026-07-22T11:30:00-05:00")

    def test_request_only_sync_preserves_direct_sheets_path(self):
        spreadsheets = mock.MagicMock()
        context = {"ok": True, "service": mock.MagicMock(), "sheet_id": "test-sheet"}
        context["service"].spreadsheets.return_value = spreadsheets
        with mock.patch.object(server, "_shared_sheet_context", return_value=context), \
             mock.patch.object(server, "_sync_newbie_shift_request", return_value="updated") as sync_request:
            source = local_record(
                session_id="session-1",
                newbie_shift_request_type="reschedule",
                newbie_shift_request_created_at="2026-07-18T12:00:00Z",
                newbie_shift_original_scheduled_at="2026-07-20T10:00:00-05:00",
                newbie_shift_rescheduled_at="2026-07-21T10:00:00-05:00",
                newbie_shift_scheduled_at="2026-07-21T10:00:00-05:00",
                newbie_shift_requested_by="tester",
                newbie_shift_request_reason="Scheduling conflict",
            )
            result = server._sync_newbie_shift_request_only(source)

        self.assertTrue(result["ok"])
        self.assertEqual(result["action"], "updated")
        sync_request.assert_called_once()

    def test_history_reconcile_bypasses_fresh_cross_process_request_cache(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            database_path = Path(temp_dir) / "history-refresh.sqlite3"
            local_store = server.SQLiteDocumentStore(database_path)
            asyncio.run(local_store.history.insert_one(local_record()))
            original_cache = server.SQLiteCollection.clone(server._remote_newbie_request_cache)
            with server._remote_newbie_request_cache_lock:
                server._remote_newbie_request_cache.update({
                    "requests": [remote_request(status="pending")],
                    "last_success": server.time.monotonic(),
                    "last_failure": 0.0,
                    "in_flight": False,
                })
            try:
                with mock.patch.object(server, "db", local_store), \
                     mock.patch.object(server, "_fetch_remote_newbie_requests", return_value=[
                         remote_request(status="approved", newbie_shift_number="2")
                     ]) as fetch_requests, \
                     mock.patch.object(server, "_reconcile_remote_corrections_into_local_history", return_value={
                         "ok": True, "historyUpdated": 0,
                     }), \
                     mock.patch.object(server, "_reconcile_remote_candidate_information_into_local_history", return_value={
                         "ok": True, "historyUpdated": 0, "ambiguousSessionIds": 0,
                     }):
                    result = asyncio.run(server.reconcile_history())
            finally:
                with server._remote_newbie_request_cache_lock:
                    server._remote_newbie_request_cache.clear()
                    server._remote_newbie_request_cache.update(original_cache)
                local_store.close()

        fetch_requests.assert_called_once_with()
        self.assertEqual(result["history"][0]["history_id"], "session-1")
        self.assertEqual(result["history"][0]["newbie_shift_request_id"], "request-1")
        self.assertEqual(result["history"][0]["newbie_shift_request_status"], "approved")
        self.assertEqual(result["history"][0]["newbie_shift_number"], "2")
        self.assertEqual(result["history"][0]["newbie_shift_scheduled_at"], "2026-07-16T14:00:00-04:00")
        self.assertEqual(result["warnings"], [])

    def test_optional_newbie_history_failure_preserves_candidate_and_returns_warning(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            database_path = Path(temp_dir) / "history-warning.sqlite3"
            local_store = server.SQLiteDocumentStore(database_path)
            asyncio.run(local_store.history.insert_one(local_record()))
            with mock.patch.object(server, "db", local_store), \
                 mock.patch.object(
                     server,
                     "_reconcile_remote_newbie_requests_into_local_state",
                     side_effect=ValueError("synthetic malformed optional request"),
                 ), \
                 mock.patch.object(server, "_reconcile_remote_corrections_into_local_history", return_value={
                     "ok": False, "historyUpdated": 0, "error_code": "correction_transport_unavailable",
                 }), \
                 mock.patch.object(server, "_reconcile_remote_candidate_information_into_local_history", return_value={
                     "ok": False, "historyUpdated": 0, "error_code": "candidate_information_transport_unavailable",
                 }):
                result = asyncio.run(server.reconcile_history())
            local_store.close()

        self.assertFalse(result["ok"])
        self.assertEqual(result["history"][0]["history_id"], "session-1")
        self.assertEqual(result["history"][0]["candidate_name"], "Taylor Example")
        self.assertIn("newbie_shift_history_entry_unavailable", result["warnings"])
        self.assertEqual(
            result["reconciliation"]["newbieRequests"]["error_code"],
            "newbie_shift_history_entry_unavailable",
        )

    def test_terminal_candidate_suppresses_only_obsolete_pending_newbie_work(self):
        pending = server._public_newbie_request({
            "request_id": "request-1", "session_id": "session-1", "request_status": "pending",
            "request_type": "reschedule", "request_created_at": "2026-07-18T12:00:00Z",
        })
        resolved = dict(pending, request_id="request-2", raw_status="denied", status="Denied")
        tracking = {"ok": True, "candidates": [{"session_id": "session-1", "latest_status": "Pass"}]}

        filtered = server._filter_obsolete_pending_newbie_requests([pending, resolved], tracking)

        self.assertEqual([item["request_id"] for item in filtered], ["request-2"])

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

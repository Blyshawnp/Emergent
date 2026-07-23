import unittest
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server


def reschedule(**overrides):
    source = {
        "newbie_shift_request_type": "reschedule",
        "newbie_shift_requested_by": "candidate",
        "newbie_shift_request_created_at": "2026-07-20T10:00:00-04:00",
        "newbie_shift_original_scheduled_at": "2026-07-21T10:00:00-04:00",
        "newbie_shift_current_attempt": 1,
        "final_attempt": False,
    }
    source.update(overrides)
    return source


class NewbieRescheduleAttemptTests(unittest.TestCase):
    def test_candidate_more_than_24_hours_does_not_count(self):
        result = server.calculate_newbie_reschedule_attempt(reschedule(
            newbie_shift_original_scheduled_at="2026-07-21T10:00:01-04:00",
        ))
        self.assertFalse(result["counts_as_attempt"])
        self.assertEqual(result["lead_time_category"], "24_hours_or_more")
        self.assertEqual(result["resulting_attempt"], 1)

    def test_candidate_exactly_24_hours_does_not_count(self):
        result = server.calculate_newbie_reschedule_attempt(reschedule())
        self.assertFalse(result["counts_as_attempt"])
        self.assertEqual(result["lead_time_seconds"], 86400)

    def test_candidate_one_second_under_24_hours_counts_and_becomes_final(self):
        result = server.calculate_newbie_reschedule_attempt(reschedule(
            newbie_shift_original_scheduled_at="2026-07-21T09:59:59-04:00",
        ))
        self.assertTrue(result["counts_as_attempt"])
        self.assertEqual(result["resulting_attempt"], 2)
        self.assertTrue(result["becomes_final_attempt"])
        self.assertTrue(result["final_attempt"])

    def test_request_after_start_counts_for_candidate(self):
        result = server.calculate_newbie_reschedule_attempt(reschedule(
            newbie_shift_original_scheduled_at="2026-07-20T09:59:59-04:00",
        ))
        self.assertTrue(result["counts_as_attempt"])
        self.assertLess(result["lead_time_seconds"], 0)

    def test_tester_and_other_never_consume_candidate_attempt(self):
        for requester, rule in (("tester", "tester_no_count"), ("other", "other_no_count_owner_confirmation")):
            with self.subTest(requester=requester):
                result = server.calculate_newbie_reschedule_attempt(reschedule(
                    newbie_shift_requested_by=requester,
                    newbie_shift_original_scheduled_at="2026-07-20T10:30:00-04:00",
                ))
                self.assertFalse(result["counts_as_attempt"])
                self.assertEqual(result["current_attempt"], result["resulting_attempt"])
                self.assertEqual(result["rule_code"], rule)

    def test_late_request_after_final_attempt_is_terminal_without_attempt_three(self):
        source = reschedule(
            newbie_shift_current_attempt=2,
            final_attempt=True,
            newbie_shift_original_scheduled_at="2026-07-20T11:00:00-04:00",
        )
        result = server.calculate_newbie_reschedule_attempt(source)
        self.assertEqual(result["current_attempt"], 2)
        self.assertEqual(result["resulting_attempt"], 2)
        self.assertEqual(result["terminal_outcome"], "FAIL-Final Attempt")
        self.assertEqual(server.compute_final_status(server._apply_newbie_reschedule_attempt(source)), "FAIL-Final Attempt")

    def test_dst_aware_exact_boundary_uses_absolute_instants(self):
        result = server.calculate_newbie_reschedule_attempt(reschedule(
            newbie_shift_request_created_at="2026-03-08T10:00:00-04:00",
            newbie_shift_original_scheduled_at="2026-03-09T10:00:00-04:00",
        ))
        self.assertEqual(result["lead_time_seconds"], 86400)
        self.assertFalse(result["counts_as_attempt"])

    def test_naive_or_missing_schedule_is_rejected(self):
        result = server.calculate_newbie_reschedule_attempt(reschedule(
            newbie_shift_original_scheduled_at="2026-07-21T10:00:00",
        ))
        self.assertEqual(result["validation_error"], "invalid_schedule")
        self.assertFalse(result["counts_as_attempt"])

    def test_apps_script_pending_update_is_safe_success(self):
        client = mock.MagicMock()
        client.post.return_value = {"request_id": "request-1", "action": "updated", "status": "pending"}
        source = reschedule(
            newbie_shift_request_id="request-1",
            session_id="session-1",
            newbie_shift_request_reason="Scheduling conflict",
            newbie_shift_rescheduled_at="2026-07-22T10:00:00-04:00",
            newbie_shift_scheduled_at="2026-07-22T10:00:00-04:00",
        )
        with mock.patch.object(server, "_shared_sheet_context", return_value={"ok": True, "appsScriptClient": client}):
            result = server._sync_newbie_shift_request_only(source)
        self.assertTrue(result["ok"])
        self.assertTrue(result["alreadyPending"])

    def test_apps_script_response_shape_mismatch_is_actionable_failure(self):
        client = mock.MagicMock()
        client.post.return_value = {"unexpected": True}
        source = reschedule(
            newbie_shift_request_id="request-1",
            session_id="session-1",
            newbie_shift_request_reason="Scheduling conflict",
            newbie_shift_rescheduled_at="2026-07-22T10:00:00-04:00",
            newbie_shift_scheduled_at="2026-07-22T10:00:00-04:00",
        )
        with mock.patch.object(server, "_shared_sheet_context", return_value={"ok": True, "appsScriptClient": client}):
            result = server._sync_newbie_shift_request_only(source)
        self.assertFalse(result["ok"])
        self.assertEqual(result["errorCode"], "response_shape_error")

    def test_confirmed_identical_payload_skips_remote_resubmission(self):
        source = reschedule(
            newbie_shift_request_id="request-1",
            session_id="session-1",
            newbie_shift_request_reason="Scheduling conflict",
            newbie_shift_rescheduled_at="2026-07-22T10:00:00-04:00",
            newbie_shift_scheduled_at="2026-07-22T10:00:00-04:00",
        )
        source = server._apply_newbie_reschedule_attempt(source)
        source["newbie_shift_request_confirmed_at"] = "2026-07-20T10:01:00-04:00"
        source["newbie_shift_request_submission_fingerprint"] = server._newbie_request_submission_fingerprint(source)
        with mock.patch.object(server, "_shared_sheet_context") as context:
            result = server._sync_newbie_shift_request_only(source)
        self.assertTrue(result["ok"])
        self.assertEqual(result["action"], "already_confirmed")
        context.assert_not_called()

    def test_submission_validation_distinguishes_identity_and_schedule_failures(self):
        valid = reschedule(
            newbie_shift_request_id="request-1",
            session_id="session-1",
            newbie_shift_request_reason="Scheduling conflict",
            newbie_shift_rescheduled_at="2026-07-22T10:00:00-04:00",
        )
        self.assertEqual(
            server._validate_newbie_reschedule_submission({**valid, "newbie_shift_request_id": ""}),
            "missing_session_identity",
        )
        self.assertEqual(
            server._validate_newbie_reschedule_submission({**valid, "newbie_shift_original_scheduled_at": ""}),
            "invalid_schedule",
        )
        self.assertEqual(
            server._validate_newbie_reschedule_submission({**valid, "newbie_shift_rescheduled_at": "not-a-date"}),
            "invalid_schedule",
        )

    def test_role_rejection_is_classified_without_exposing_transport_details(self):
        client = mock.MagicMock()
        client.post.side_effect = RuntimeError("Forbidden 403 for credential secret-value")
        source = reschedule(
            newbie_shift_request_id="request-1",
            session_id="session-1",
            newbie_shift_request_reason="Scheduling conflict",
            newbie_shift_rescheduled_at="2026-07-22T10:00:00-04:00",
        )
        with mock.patch.object(server, "_shared_sheet_context", return_value={"ok": True, "appsScriptClient": client}):
            result = server._sync_newbie_shift_request_only(source)
        self.assertFalse(result["ok"])
        self.assertEqual(result["errorCode"], "forbidden_action")
        self.assertNotIn("secret-value", result["error"])

    def test_timeout_retry_reuses_fields_and_then_succeeds(self):
        client = mock.MagicMock()
        client.post.side_effect = [
            TimeoutError("transport timed out"),
            {"request_id": "request-1", "action": "created", "status": "pending"},
        ]
        source = reschedule(
            newbie_shift_request_id="request-1",
            session_id="session-1",
            newbie_shift_request_reason="Scheduling conflict",
            newbie_shift_request_details="Keep these details",
            newbie_shift_rescheduled_at="2026-07-22T10:00:00-04:00",
        )
        with mock.patch.object(server, "_shared_sheet_context", return_value={"ok": True, "appsScriptClient": client}):
            first = server._sync_newbie_shift_request_only(source)
            second = server._sync_newbie_shift_request_only(source)
        self.assertEqual(first["errorCode"], "transport_timeout")
        self.assertTrue(second["ok"])
        submitted_requests = [call.args[1]["request"] for call in client.post.call_args_list]
        self.assertEqual(submitted_requests[0], submitted_requests[1])

    def test_repeated_attempt_application_never_increments_twice(self):
        source = reschedule(newbie_shift_original_scheduled_at="2026-07-21T09:59:59-04:00")
        first = server._apply_newbie_reschedule_attempt(source)
        second = server._apply_newbie_reschedule_attempt(first)
        self.assertEqual(first["newbie_shift_current_attempt"], 1)
        self.assertEqual(first["newbie_shift_resulting_attempt"], 2)
        self.assertEqual(second["newbie_shift_current_attempt"], 1)
        self.assertEqual(second["newbie_shift_resulting_attempt"], 2)


if __name__ == "__main__":
    unittest.main()

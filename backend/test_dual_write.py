from __future__ import annotations

import os
import unittest
from unittest.mock import MagicMock, Mock, patch

from data_providers.dual_write import (
    DUAL_WRITE_ELIGIBLE_DOMAINS,
    DUAL_WRITE_EXCLUDED_DOMAINS,
    DomainDualWriteAdapter,
    DualWriteDivergenceTracker,
    DualWriteFailureClass,
    DualWriteManager,
    DualWriteResult,
    NotificationsAdapter,
    HeadsetReviewsAdapter,
    CandidateSessionsAdapter,
    CandidatesAdapter,
    SessionAttemptsAdapter,
    CandidateCorrectionsAdapter,
    NewbieShiftRequestsAdapter,
    SupervisorTransfersAdapter,
    ExtraAttemptGrantsAdapter,
    CandidateStatusActionsAdapter,
    active_dual_write_domains,
    build_operation_id,
    compute_payload_digest,
    is_domain_dual_write_enabled,
    is_dual_write_enabled,
)
from data_providers.supabase import SupabaseProviderError


class DualWriteFrameworkTests(unittest.TestCase):
    def setUp(self):
        self.mock_supabase = MagicMock()
        self.tracker = DualWriteDivergenceTracker()
        self.manager = DualWriteManager(
            supabase_provider_factory=lambda: self.mock_supabase,
            divergence_tracker=self.tracker,
        )

    # 1. Feature Flag OFF Gate (Section 26 & 40)
    def test_flag_off_performs_authoritative_write_with_zero_supabase_writes(self):
        auth_write_mock = Mock(return_value={"ok": True, "id": "notif-1"})
        environ = {"MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "false"}

        auth_res, dw_res = self.manager.execute_dual_write(
            domain="notifications",
            mutation_type="insert",
            authoritative_payload={"ID": "notif-1", "Title": "Test", "Message": "Msg"},
            authoritative_write_fn=auth_write_mock,
            environ=environ,
        )

        auth_write_mock.assert_called_once()
        self.mock_supabase.upsert_rows.assert_not_called()
        self.mock_supabase.delete_rows.assert_not_called()
        self.assertTrue(dw_res.authoritative_success)
        self.assertFalse(dw_res.mirror_attempted)
        self.assertEqual(dw_res.mirror_status, "skipped_domain_not_allowlisted")
        self.assertEqual(self.tracker.pending_count(), 0)

    # 2. Per-Domain Runtime Activation Gate (Section 6 & 7)
    def test_per_domain_gate_semantics(self):
        # Global OFF -> 0 active domains
        self.assertEqual(active_dual_write_domains({"MTS_DUAL_WRITE_ENABLED": "false", "MTS_DUAL_WRITE_DOMAINS": "notifications"}), frozenset())

        # Global ON, but empty domains -> fails closed (0 active domains)
        self.assertEqual(active_dual_write_domains({"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": ""}), frozenset())

        # Global ON, notifications only
        env = {"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "notifications"}
        self.assertEqual(active_dual_write_domains(env), frozenset({"notifications"}))
        self.assertTrue(is_domain_dual_write_enabled("notifications", env))
        self.assertFalse(is_domain_dual_write_enabled("headset_reviews", env))
        self.assertFalse(is_domain_dual_write_enabled("candidate_sessions", env))

    def test_other_domain_write_blocked_when_only_notifications_allowlisted(self):
        auth_write_mock = Mock(return_value={"ok": True, "id": "hr-1"})
        env = {"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "notifications"}

        auth_res, dw_res = self.manager.execute_dual_write(
            domain="headset_reviews",
            mutation_type="action",
            authoritative_payload={"id": "hr-1", "status": "approved"},
            authoritative_write_fn=auth_write_mock,
            environ=env,
        )

        auth_write_mock.assert_called_once()
        self.mock_supabase.upsert_rows.assert_not_called()
        self.assertTrue(dw_res.authoritative_success)
        self.assertFalse(dw_res.mirror_attempted)
        self.assertEqual(dw_res.mirror_status, "skipped_domain_not_allowlisted")

    # 3. Authoritative Failure Rule (Section 9 & 35)
    def test_authoritative_failure_prevents_supabase_mirror(self):
        auth_write_mock = Mock(return_value={"ok": False, "error": "Sheets quota exceeded"})
        environ = {"MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "notifications"}

        auth_res, dw_res = self.manager.execute_dual_write(
            domain="notifications",
            mutation_type="insert",
            authoritative_payload={"ID": "notif-1", "Title": "Test", "Message": "Msg"},
            authoritative_write_fn=auth_write_mock,
            environ=environ,
        )

        auth_write_mock.assert_called_once()
        self.mock_supabase.upsert_rows.assert_not_called()
        self.assertFalse(dw_res.authoritative_success)
        self.assertFalse(dw_res.mirror_attempted)
        self.assertEqual(dw_res.mirror_status, "skipped_authoritative_failure")
        self.assertEqual(self.tracker.pending_count(), 0)

    def test_authoritative_exception_prevents_supabase_mirror_and_raises(self):
        auth_write_mock = Mock(side_effect=RuntimeError("Network disconnect"))
        environ = {"MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "notifications"}

        with self.assertRaises(RuntimeError):
            self.manager.execute_dual_write(
                domain="notifications",
                mutation_type="insert",
                authoritative_payload={"ID": "notif-1", "Title": "Test", "Message": "Msg"},
                authoritative_write_fn=auth_write_mock,
                environ=environ,
            )

        self.mock_supabase.upsert_rows.assert_not_called()
        self.assertEqual(self.tracker.pending_count(), 0)

    # 4. Controlled Flag ON - Success Path (Section 27 & 41)
    def test_controlled_flag_on_executes_and_verifies_supabase_mirror(self):
        auth_write_mock = Mock(return_value={"ok": True, "id": "notif-1"})
        environ = {"MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "notifications"}

        # Mock successful list_resource read-back
        self.mock_supabase.list_resource.return_value = [{
            "notification_id": "notif-1",
            "enabled": True,
            "title": "Test Title",
            "message": "Test Message",
            "end_date": None,
        }]

        auth_res, dw_res = self.manager.execute_dual_write(
            domain="notifications",
            mutation_type="insert",
            authoritative_payload={
                "ID": "notif-1",
                "Enabled": True,
                "Title": "Test Title",
                "Message": "Test Message",
                "StartDate": "2026-08-22",
                "StartTime": "9:00 AM",
                "EndDate": "",
                "EndTime": "",
            },
            authoritative_write_fn=auth_write_mock,
            environ=environ,
        )

        auth_write_mock.assert_called_once()
        self.mock_supabase.upsert_rows.assert_called_once()
        self.assertTrue(dw_res.authoritative_success)
        self.assertTrue(dw_res.mirror_attempted)
        self.assertTrue(dw_res.mirror_success)
        self.assertTrue(dw_res.verification_success)
        self.assertEqual(dw_res.failure_class, DualWriteFailureClass.SUCCESS)
        self.assertEqual(self.tracker.pending_count(), 0)

    # 5. Mirror Failure Rule - Sheets Up / Supabase Down (Section 10 & 36)
    def test_supabase_mirror_failure_records_divergence_without_failing_authoritative_action(self):
        auth_write_mock = Mock(return_value={"ok": True, "id": "notif-1"})
        environ = {"MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "notifications"}

        # Supabase raises connection error
        self.mock_supabase.upsert_rows.side_effect = SupabaseProviderError("Supabase connection refused 503")

        auth_res, dw_res = self.manager.execute_dual_write(
            domain="notifications",
            mutation_type="insert",
            authoritative_payload={"ID": "notif-1", "Title": "Test", "Message": "Msg"},
            authoritative_write_fn=auth_write_mock,
            environ=environ,
        )

        # Authoritative action still succeeds
        self.assertEqual(auth_res.get("ok"), True)
        self.assertTrue(dw_res.authoritative_success)
        self.assertTrue(dw_res.mirror_attempted)
        self.assertFalse(dw_res.mirror_success)
        self.assertEqual(dw_res.failure_class, DualWriteFailureClass.TRANSIENT_FAILURE)
        self.assertTrue(dw_res.divergence_recorded)
        self.assertEqual(self.tracker.pending_count(), 1)

        divergences = self.tracker.list_divergences()
        self.assertEqual(len(divergences), 1)
        self.assertEqual(divergences[0]["domain"], "notifications")
        self.assertEqual(divergences[0]["failure_class"], "TRANSIENT_FAILURE")

    # 6. Post-Write Mismatch Test (Section 11 & 37)
    def test_post_write_mismatch_fails_verification_and_records_divergence(self):
        auth_write_mock = Mock(return_value={"ok": True, "id": "notif-1"})
        environ = {"MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "notifications"}

        # Supabase returns mismatched state upon read-back
        self.mock_supabase.list_resource.return_value = [{
            "notification_id": "notif-1",
            "enabled": False,  # mismatch!
            "title": "Different Title",
            "message": "Test Message",
        }]

        auth_res, dw_res = self.manager.execute_dual_write(
            domain="notifications",
            mutation_type="insert",
            authoritative_payload={"ID": "notif-1", "Enabled": True, "Title": "Expected Title", "Message": "Test Message"},
            authoritative_write_fn=auth_write_mock,
            environ=environ,
        )

        self.assertTrue(dw_res.authoritative_success)
        self.assertTrue(dw_res.mirror_attempted)
        self.assertFalse(dw_res.mirror_success)
        self.assertFalse(dw_res.verification_success)
        self.assertEqual(dw_res.failure_class, DualWriteFailureClass.POST_WRITE_MISMATCH)
        self.assertEqual(self.tracker.pending_count(), 1)

    # 7. Retry Idempotency & Duplicate Protection (Section 13 & 38)
    def test_retry_same_operation_uses_identical_operation_id_and_updates_divergence(self):
        payload = {"ID": "notif-idemp", "Title": "Title", "Message": "Msg"}
        digest1 = compute_payload_digest(payload)
        digest2 = compute_payload_digest(payload)
        self.assertEqual(digest1, digest2)

        op_id_1 = build_operation_id("notifications", "insert", "notif-idemp", digest1)
        op_id_2 = build_operation_id("notifications", "insert", "notif-idemp", digest2)
        self.assertEqual(op_id_1, op_id_2)

        environ = {"MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "notifications"}

        # First attempt fails
        self.mock_supabase.upsert_rows.side_effect = SupabaseProviderError("Timeout")
        self.manager.execute_dual_write(
            domain="notifications",
            mutation_type="insert",
            authoritative_payload=payload,
            authoritative_write_fn=lambda: {"ok": True},
            environ=environ,
        )
        self.assertEqual(self.tracker.pending_count(), 1)
        self.assertEqual(self.tracker.list_divergences()[0]["retry_count"], 0)

        # Second attempt (retry) also fails -> updates retry count rather than duplicating record
        self.manager.execute_dual_write(
            domain="notifications",
            mutation_type="insert",
            authoritative_payload=payload,
            authoritative_write_fn=lambda: {"ok": True},
            environ=environ,
        )
        self.assertEqual(self.tracker.pending_count(), 1)
        self.assertEqual(self.tracker.list_divergences()[0]["retry_count"], 1)

    # 8. Notification Null Expiration Semantics (Section 18)
    def test_notifications_adapter_preserves_null_expiration(self):
        adapter = NotificationsAdapter()
        payload = {
            "ID": "notif-no-exp",
            "Title": "No Exp Notice",
            "Message": "Indefinite",
            "StartDate": "2026-08-22",
            "StartTime": "10:00 AM",
            "EndDate": "",
            "EndTime": "",
        }
        transformed = adapter.transform_payload(payload)
        self.assertEqual(transformed["notification_id"], "notif-no-exp")
        self.assertEqual(transformed["starts_at"], "2026-08-22T10:00:00+00:00")
        self.assertIsNone(transformed["ends_at"])

    # 9. Domain Allowlist & Excluded Domains (Section 14 & 46)
    def test_unsupported_domain_skips_mirror_cleanly(self):
        auth_write_mock = Mock(return_value={"ok": True})
        environ = {"MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "notifications"}

        auth_res, dw_res = self.manager.execute_dual_write(
            domain="callers",  # callers is config-only, excluded from runtime dual-write
            mutation_type="update",
            authoritative_payload={"id": "c1"},
            authoritative_write_fn=auth_write_mock,
            environ=environ,
        )

        auth_write_mock.assert_called_once()
        self.mock_supabase.upsert_rows.assert_not_called()
        self.assertFalse(dw_res.mirror_attempted)
        self.assertEqual(dw_res.failure_class, DualWriteFailureClass.UNSUPPORTED_DOMAIN)

    # 10. Headset Reviews Adapter
    def test_headset_reviews_adapter_transformation(self):
        adapter = HeadsetReviewsAdapter()
        payload = {
            "review_id": "hr-1",
            "brand": "Logitech",
            "model": "H390",
            "status": "Approved",
            "notes": "Good audio",
            "tester": "Tester 1",
            "session_id": "sess-123",
        }
        transformed = adapter.transform_payload(payload)
        self.assertEqual(transformed["review_id"], "hr-1")
        self.assertEqual(transformed["brand"], "Logitech")
        self.assertEqual(transformed["model"], "H390")
        self.assertEqual(transformed["status"], "approved")
        self.assertEqual(transformed["source_session_id"], "sess-123")
        self.assertIsNotNone(transformed["source_checksum"])

    # 11. Section 13 Gate Test Cases (A through E)
    def test_section_13_gate_cases(self):
        auth_mock = Mock(return_value={"ok": True, "id": "test-1"})

        # Case A: MTS_DUAL_WRITE_ENABLED=false -> headset review mirror NO
        _, res_a = self.manager.execute_dual_write(
            domain="headset_reviews",
            mutation_type="action",
            authoritative_payload={"review_id": "hr-1", "brand": "B", "model": "M"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "false", "MTS_DUAL_WRITE_DOMAINS": "headset_reviews"},
        )
        self.assertFalse(res_a.mirror_attempted)

        # Case B: MTS_DUAL_WRITE_ENABLED=true, MTS_DUAL_WRITE_DOMAINS=notifications -> headset review mirror NO
        _, res_b = self.manager.execute_dual_write(
            domain="headset_reviews",
            mutation_type="action",
            authoritative_payload={"review_id": "hr-1", "brand": "B", "model": "M"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "notifications"},
        )
        self.assertFalse(res_b.mirror_attempted)

        # Case C: MTS_DUAL_WRITE_ENABLED=true, MTS_DUAL_WRITE_DOMAINS=headset_reviews -> headset review mirror YES
        self.mock_supabase.list_resource.return_value = [{"review_id": "hr-1", "brand": "B", "model": "M", "status": "pending"}]
        _, res_c = self.manager.execute_dual_write(
            domain="headset_reviews",
            mutation_type="action",
            authoritative_payload={"review_id": "hr-1", "brand": "B", "model": "M"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "headset_reviews"},
        )
        self.assertTrue(res_c.mirror_attempted)
        self.assertTrue(res_c.mirror_success)

        # Case D: MTS_DUAL_WRITE_ENABLED=true, MTS_DUAL_WRITE_DOMAINS=headset_reviews -> notification mirror NO
        _, res_d = self.manager.execute_dual_write(
            domain="notifications",
            mutation_type="update",
            authoritative_payload={"ID": "notif-1", "Title": "T"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "headset_reviews"},
        )
        self.assertFalse(res_d.mirror_attempted)

        # Case E: candidate/session mutation under headset_reviews gate -> mirror NO
        _, res_e1 = self.manager.execute_dual_write(
            domain="candidates",
            mutation_type="update",
            authoritative_payload={"source_candidate_id": "c-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "headset_reviews"},
        )
        self.assertFalse(res_e1.mirror_attempted)

        _, res_e2 = self.manager.execute_dual_write(
            domain="candidate_sessions",
            mutation_type="update",
            authoritative_payload={"session_id": "s-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "headset_reviews"},
        )
        self.assertFalse(res_e2.mirror_attempted)

    # 11. Candidate Sessions Adapter
    def test_candidate_sessions_adapter_transformation(self):
        adapter = CandidateSessionsAdapter()
        payload = {
            "session_id": "sess-abc",
            "candidate_name": "John Doe",
            "status": "Pass",
            "calculated_result": "Pass",
            "final_result": "Pass",
            "final_attempt": True,
        }
        transformed = adapter.transform_payload(payload)
        self.assertEqual(transformed["session_id"], "sess-abc")
        self.assertEqual(transformed["candidate_name"], "John Doe")
        self.assertEqual(transformed["raw_status"], "Pass")
        self.assertTrue(transformed["final_attempt"])

    # 12. Candidate Corrections Adapter
    def test_candidate_corrections_adapter_transformation(self):
        adapter = CandidateCorrectionsAdapter()
        payload = {
            "request_id": "corr-123",
            "source_session_id": "sess-abc",
            "status": "pending",
            "reason": "Name correction",
            "changes": {"candidate_name": "Jane Doe"},
            "requested_by": "Tester 1",
        }
        transformed = adapter.transform_payload(payload)
        self.assertEqual(transformed["request_id"], "corr-123")
        self.assertEqual(transformed["source_session_id"], "sess-abc")
        self.assertEqual(transformed["status"], "pending")
        self.assertEqual(transformed["reason"], "Name correction")
        self.assertEqual(transformed["changes"], {"candidate_name": "Jane Doe"})
        self.assertEqual(transformed["requested_by"], "Tester 1")
        self.assertIsNotNone(transformed["source_checksum"])

    # 13. Candidate Corrections Section 13 Gate Test Cases (A through G)
    def test_candidate_corrections_section_13_gate_cases(self):
        auth_mock = Mock(return_value={"ok": True, "request_id": "corr-1"})

        # Case A: MTS_DUAL_WRITE_ENABLED=false -> candidate_corrections mirror NO
        _, res_a = self.manager.execute_dual_write(
            domain="candidate_corrections",
            mutation_type="action",
            authoritative_payload={"request_id": "corr-1", "status": "approved"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "false", "MTS_DUAL_WRITE_DOMAINS": "candidate_corrections"},
        )
        self.assertFalse(res_a.mirror_attempted)

        # Case B: MTS_DUAL_WRITE_ENABLED=true, MTS_DUAL_WRITE_DOMAINS=notifications -> candidate_corrections mirror NO
        _, res_b = self.manager.execute_dual_write(
            domain="candidate_corrections",
            mutation_type="action",
            authoritative_payload={"request_id": "corr-1", "status": "approved"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "notifications"},
        )
        self.assertFalse(res_b.mirror_attempted)

        # Case C: MTS_DUAL_WRITE_ENABLED=true, MTS_DUAL_WRITE_DOMAINS=candidate_corrections -> candidate_corrections mirror YES
        self.mock_supabase.list_resource.return_value = [{"request_id": "corr-1", "status": "approved", "source_session_id": "s-1", "reason": "R"}]
        _, res_c = self.manager.execute_dual_write(
            domain="candidate_corrections",
            mutation_type="action",
            authoritative_payload={"request_id": "corr-1", "status": "approved", "source_session_id": "s-1", "reason": "R"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidate_corrections"},
        )
        self.assertTrue(res_c.mirror_attempted)
        self.assertTrue(res_c.mirror_success)

        # Case D: same configuration -> notifications mirror NO
        _, res_d = self.manager.execute_dual_write(
            domain="notifications",
            mutation_type="update",
            authoritative_payload={"ID": "notif-1", "Title": "T"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidate_corrections"},
        )
        self.assertFalse(res_d.mirror_attempted)

        # Case E: same configuration -> headset_reviews mirror NO
        _, res_e = self.manager.execute_dual_write(
            domain="headset_reviews",
            mutation_type="action",
            authoritative_payload={"review_id": "hr-1", "brand": "B", "model": "M"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidate_corrections"},
        )
        self.assertFalse(res_e.mirror_attempted)

        # Case F: same configuration -> candidates mirror NO
        _, res_f = self.manager.execute_dual_write(
            domain="candidates",
            mutation_type="update",
            authoritative_payload={"source_candidate_id": "c-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidate_corrections"},
        )
        self.assertFalse(res_f.mirror_attempted)

        # Case G: same configuration -> pending_requests mirror NO
        _, res_g = self.manager.execute_dual_write(
            domain="pending_requests",
            mutation_type="action",
            authoritative_payload={"request_id": "req-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidate_corrections"},
        )
        self.assertFalse(res_g.mirror_attempted)

    # 14. Newbie Shift Requests Adapter
    def test_newbie_shift_requests_adapter_transformation(self):
        adapter = NewbieShiftRequestsAdapter()
        payload = {
            "request_id": "newbie-123",
            "source_session_id": "sess-456",
            "request_type": "initial_newbie_shift",
            "request_status": "approved",
            "newbie_shift_number": "11223344",
            "scheduled_at": "2026-08-08T01:30:00+00:00",
            "requested_by": "Tester 1",
            "admin_decision_by": "Shawn Bly",
            "counts_as_attempt": True,
            "final_attempt": False,
        }
        transformed = adapter.transform_payload(payload)
        self.assertEqual(transformed["request_id"], "newbie-123")
        self.assertEqual(transformed["source_session_id"], "sess-456")
        self.assertEqual(transformed["request_status"], "approved")
        self.assertEqual(transformed["newbie_shift_number"], "11223344")
        self.assertEqual(transformed["scheduled_at"], "2026-08-08T01:30:00+00:00")
        self.assertEqual(transformed["requested_by"], "Tester 1")
        self.assertEqual(transformed["decision_by"], "Shawn Bly")
        self.assertTrue(transformed["counts_as_attempt"])
        self.assertFalse(transformed["final_attempt"])
        self.assertIsNotNone(transformed["source_checksum"])

    # 15. Newbie Shift Requests Section 14 Gate Test Cases (A through I)
    def test_newbie_shift_requests_section_14_gate_cases(self):
        auth_mock = Mock(return_value={"ok": True, "request_id": "newbie-1"})

        # Case A: MTS_DUAL_WRITE_ENABLED=false -> newbie_shift_requests mirror NO
        _, res_a = self.manager.execute_dual_write(
            domain="newbie_shift_requests",
            mutation_type="action",
            authoritative_payload={"request_id": "newbie-1", "request_status": "approved"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "false", "MTS_DUAL_WRITE_DOMAINS": "newbie_shift_requests"},
        )
        self.assertFalse(res_a.mirror_attempted)

        # Case B: MTS_DUAL_WRITE_ENABLED=true, MTS_DUAL_WRITE_DOMAINS=notifications -> newbie_shift_requests mirror NO
        _, res_b = self.manager.execute_dual_write(
            domain="newbie_shift_requests",
            mutation_type="action",
            authoritative_payload={"request_id": "newbie-1", "request_status": "approved"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "notifications"},
        )
        self.assertFalse(res_b.mirror_attempted)

        # Case C: MTS_DUAL_WRITE_ENABLED=true, MTS_DUAL_WRITE_DOMAINS=newbie_shift_requests -> newbie_shift_requests mirror YES
        self.mock_supabase.list_resource.return_value = [{"request_id": "newbie-1", "request_status": "approved", "source_session_id": "s-1"}]
        _, res_c = self.manager.execute_dual_write(
            domain="newbie_shift_requests",
            mutation_type="action",
            authoritative_payload={"request_id": "newbie-1", "request_status": "approved", "source_session_id": "s-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "newbie_shift_requests"},
        )
        self.assertTrue(res_c.mirror_attempted)
        self.assertTrue(res_c.mirror_success)

        # Case D: same configuration -> notifications mirror NO
        _, res_d = self.manager.execute_dual_write(
            domain="notifications",
            mutation_type="update",
            authoritative_payload={"ID": "notif-1", "Title": "T"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "newbie_shift_requests"},
        )
        self.assertFalse(res_d.mirror_attempted)

        # Case E: same configuration -> headset_reviews mirror NO
        _, res_e = self.manager.execute_dual_write(
            domain="headset_reviews",
            mutation_type="action",
            authoritative_payload={"review_id": "hr-1", "brand": "B", "model": "M"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "newbie_shift_requests"},
        )
        self.assertFalse(res_e.mirror_attempted)

        # Case F: same configuration -> candidate_corrections mirror NO
        _, res_f = self.manager.execute_dual_write(
            domain="candidate_corrections",
            mutation_type="action",
            authoritative_payload={"request_id": "corr-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "newbie_shift_requests"},
        )
        self.assertFalse(res_f.mirror_attempted)

        # Case G: same configuration -> candidate_sessions mirror NO
        _, res_g = self.manager.execute_dual_write(
            domain="candidate_sessions",
            mutation_type="update",
            authoritative_payload={"session_id": "s-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "newbie_shift_requests"},
        )
        self.assertFalse(res_g.mirror_attempted)

        # Case H: same configuration -> candidate_status_actions mirror NO
        _, res_h = self.manager.execute_dual_write(
            domain="candidate_status_actions",
            mutation_type="action",
            authoritative_payload={"id": "act-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "newbie_shift_requests"},
        )
        self.assertFalse(res_h.mirror_attempted)

        # Case I: same configuration -> pending_requests mirror NO
        _, res_i = self.manager.execute_dual_write(
            domain="pending_requests",
            mutation_type="action",
            authoritative_payload={"request_id": "req-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "newbie_shift_requests"},
        )
        self.assertFalse(res_i.mirror_attempted)

    # 16. Supervisor Transfers Adapter
    def test_supervisor_transfers_adapter_transformation(self):
        adapter = SupervisorTransfersAdapter()
        payload = {
            "transfer_id": "pending-123",
            "source_session_id": "sess-789",
            "candidate_name": "John Doe",
            "original_tester_name": "Shawn Bly",
            "status": "completed",
            "completed_status": "PASS",
            "completed_by": "Shawn Bly",
            "needed_reason": "Mock calls passed; supervisor transfer required",
            "notes": "Coaching applied",
        }
        transformed = adapter.transform_payload(payload)
        self.assertEqual(transformed["transfer_id"], "pending-123")
        self.assertEqual(transformed["source_session_id"], "sess-789")
        self.assertEqual(transformed["candidate_name"], "John Doe")
        self.assertEqual(transformed["status"], "completed")
        self.assertEqual(transformed["completed_status"], "PASS")
        self.assertEqual(transformed["completed_by"], "Shawn Bly")
        self.assertEqual(transformed["needed_reason"], "Mock calls passed; supervisor transfer required")
        self.assertIsNotNone(transformed["source_checksum"])

    # 17. Supervisor Transfers Section 14 Gate Test Cases (A through K)
    def test_supervisor_transfers_section_14_gate_cases(self):
        auth_mock = Mock(return_value={"ok": True, "transfer_id": "pending-1"})

        # Case A: MTS_DUAL_WRITE_ENABLED=false -> supervisor_transfers mirror NO
        _, res_a = self.manager.execute_dual_write(
            domain="supervisor_transfers",
            mutation_type="action",
            authoritative_payload={"transfer_id": "pending-1", "status": "completed"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "false", "MTS_DUAL_WRITE_DOMAINS": "supervisor_transfers"},
        )
        self.assertFalse(res_a.mirror_attempted)

        # Case B: MTS_DUAL_WRITE_ENABLED=true, MTS_DUAL_WRITE_DOMAINS=notifications -> supervisor_transfers mirror NO
        _, res_b = self.manager.execute_dual_write(
            domain="supervisor_transfers",
            mutation_type="action",
            authoritative_payload={"transfer_id": "pending-1", "status": "completed"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "notifications"},
        )
        self.assertFalse(res_b.mirror_attempted)

        # Case C: MTS_DUAL_WRITE_ENABLED=true, MTS_DUAL_WRITE_DOMAINS=supervisor_transfers -> supervisor_transfers mirror YES
        self.mock_supabase.list_resource.return_value = [{"transfer_id": "pending-1", "status": "completed", "source_session_id": "s-1"}]
        _, res_c = self.manager.execute_dual_write(
            domain="supervisor_transfers",
            mutation_type="action",
            authoritative_payload={"transfer_id": "pending-1", "status": "completed", "source_session_id": "s-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "supervisor_transfers"},
        )
        self.assertTrue(res_c.mirror_attempted)
        self.assertTrue(res_c.mirror_success)

        # Case D: same configuration -> notifications mirror NO
        _, res_d = self.manager.execute_dual_write(
            domain="notifications",
            mutation_type="update",
            authoritative_payload={"ID": "notif-1", "Title": "T"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "supervisor_transfers"},
        )
        self.assertFalse(res_d.mirror_attempted)

        # Case E: same configuration -> headset_reviews mirror NO
        _, res_e = self.manager.execute_dual_write(
            domain="headset_reviews",
            mutation_type="action",
            authoritative_payload={"review_id": "hr-1", "brand": "B", "model": "M"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "supervisor_transfers"},
        )
        self.assertFalse(res_e.mirror_attempted)

        # Case F: same configuration -> newbie_shift_requests mirror NO
        _, res_f = self.manager.execute_dual_write(
            domain="newbie_shift_requests",
            mutation_type="action",
            authoritative_payload={"request_id": "newbie-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "supervisor_transfers"},
        )
        self.assertFalse(res_f.mirror_attempted)

        # Case G: same configuration -> candidate_corrections mirror NO
        _, res_g = self.manager.execute_dual_write(
            domain="candidate_corrections",
            mutation_type="action",
            authoritative_payload={"request_id": "corr-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "supervisor_transfers"},
        )
        self.assertFalse(res_g.mirror_attempted)

        # Case H: same configuration -> candidates mirror NO
        _, res_h = self.manager.execute_dual_write(
            domain="candidates",
            mutation_type="update",
            authoritative_payload={"source_candidate_id": "c-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "supervisor_transfers"},
        )
        self.assertFalse(res_h.mirror_attempted)

        # Case I: same configuration -> candidate_sessions mirror NO
        _, res_i = self.manager.execute_dual_write(
            domain="candidate_sessions",
            mutation_type="update",
            authoritative_payload={"session_id": "s-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "supervisor_transfers"},
        )
        self.assertFalse(res_i.mirror_attempted)

        # Case J: same configuration -> pending_requests mirror NO
        _, res_j = self.manager.execute_dual_write(
            domain="pending_requests",
            mutation_type="action",
            authoritative_payload={"request_id": "req-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "supervisor_transfers"},
        )
        self.assertFalse(res_j.mirror_attempted)

        # Case K: same configuration -> candidate_status_actions mirror NO
        _, res_k = self.manager.execute_dual_write(
            domain="candidate_status_actions",
            mutation_type="action",
            authoritative_payload={"id": "act-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "supervisor_transfers"},
        )
        self.assertFalse(res_k.mirror_attempted)

    # 18. Extra Attempt Grants Adapter
    def test_extra_attempt_grants_adapter_transformation(self):
        adapter = ExtraAttemptGrantsAdapter()
        payload = {
            "action_id": "extra-sess-123-1",
            "source_session_id": "sess-123",
            "granted_count": 1,
            "resulting_allowed_attempt_count": 4,
            "reason": "Test audio issue",
            "granted_by": "Shawn Bly",
        }
        transformed = adapter.transform_payload(payload)
        self.assertEqual(transformed["action_id"], "extra-sess-123-1")
        self.assertEqual(transformed["source_session_id"], "sess-123")
        self.assertEqual(transformed["granted_count"], 1)
        self.assertEqual(transformed["resulting_allowed_attempt_count"], 4)
        self.assertEqual(transformed["reason"], "Test audio issue")
        self.assertEqual(transformed["granted_by"], "Shawn Bly")
        self.assertEqual(transformed["source_provider"], "sheets")
        self.assertIsNotNone(transformed["granted_at"])

    # 19. Extra Attempt Grants Section 19 Gate Test Cases (A through M)
    def test_extra_attempt_grants_section_19_gate_cases(self):
        auth_mock = Mock(return_value={"ok": True, "action_id": "extra-1"})

        # Case A: MTS_DUAL_WRITE_ENABLED=false -> extra_attempt_grants mirror NO
        _, res_a = self.manager.execute_dual_write(
            domain="extra_attempt_grants",
            mutation_type="action",
            authoritative_payload={"action_id": "extra-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "false", "MTS_DUAL_WRITE_DOMAINS": "extra_attempt_grants"},
        )
        self.assertFalse(res_a.mirror_attempted)

        # Case B: MTS_DUAL_WRITE_ENABLED=true, MTS_DUAL_WRITE_DOMAINS=notifications -> extra_attempt_grants mirror NO
        _, res_b = self.manager.execute_dual_write(
            domain="extra_attempt_grants",
            mutation_type="action",
            authoritative_payload={"action_id": "extra-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "notifications"},
        )
        self.assertFalse(res_b.mirror_attempted)

        # Case C: MTS_DUAL_WRITE_ENABLED=true, MTS_DUAL_WRITE_DOMAINS=extra_attempt_grants -> extra_attempt_grants mirror YES
        self.mock_supabase.list_resource.return_value = [{"action_id": "extra-1", "source_session_id": "s-1", "resulting_allowed_attempt_count": 4}]
        _, res_c = self.manager.execute_dual_write(
            domain="extra_attempt_grants",
            mutation_type="action",
            authoritative_payload={"action_id": "extra-1", "source_session_id": "s-1", "resulting_allowed_attempt_count": 4},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "extra_attempt_grants"},
        )
        self.assertTrue(res_c.mirror_attempted)
        self.assertTrue(res_c.mirror_success)

        # Case D: same configuration -> notifications mirror NO
        _, res_d = self.manager.execute_dual_write(
            domain="notifications",
            mutation_type="update",
            authoritative_payload={"ID": "notif-1", "Title": "T"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "extra_attempt_grants"},
        )
        self.assertFalse(res_d.mirror_attempted)

        # Case E: same configuration -> headset_reviews mirror NO
        _, res_e = self.manager.execute_dual_write(
            domain="headset_reviews",
            mutation_type="action",
            authoritative_payload={"review_id": "hr-1", "brand": "B", "model": "M"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "extra_attempt_grants"},
        )
        self.assertFalse(res_e.mirror_attempted)

        # Case F: same configuration -> newbie_shift_requests mirror NO
        _, res_f = self.manager.execute_dual_write(
            domain="newbie_shift_requests",
            mutation_type="action",
            authoritative_payload={"request_id": "newbie-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "extra_attempt_grants"},
        )
        self.assertFalse(res_f.mirror_attempted)

        # Case G: same configuration -> supervisor_transfers mirror NO
        _, res_g = self.manager.execute_dual_write(
            domain="supervisor_transfers",
            mutation_type="action",
            authoritative_payload={"transfer_id": "trans-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "extra_attempt_grants"},
        )
        self.assertFalse(res_g.mirror_attempted)

        # Case H: same configuration -> candidate_corrections mirror NO
        _, res_h = self.manager.execute_dual_write(
            domain="candidate_corrections",
            mutation_type="action",
            authoritative_payload={"request_id": "corr-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "extra_attempt_grants"},
        )
        self.assertFalse(res_h.mirror_attempted)

        # Case I: same configuration -> candidates mirror NO
        _, res_i = self.manager.execute_dual_write(
            domain="candidates",
            mutation_type="update",
            authoritative_payload={"source_candidate_id": "c-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "extra_attempt_grants"},
        )
        self.assertFalse(res_i.mirror_attempted)

        # Case J: same configuration -> candidate_sessions mirror NO
        _, res_j = self.manager.execute_dual_write(
            domain="candidate_sessions",
            mutation_type="update",
            authoritative_payload={"session_id": "s-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "extra_attempt_grants"},
        )
        self.assertFalse(res_j.mirror_attempted)

        # Case K: same configuration -> session_attempts mirror NO
        _, res_k = self.manager.execute_dual_write(
            domain="session_attempts",
            mutation_type="create",
            authoritative_payload={"id": "att-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "extra_attempt_grants"},
        )
        self.assertFalse(res_k.mirror_attempted)

        # Case L: same configuration -> pending_requests mirror NO
        _, res_l = self.manager.execute_dual_write(
            domain="pending_requests",
            mutation_type="action",
            authoritative_payload={"request_id": "req-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "extra_attempt_grants"},
        )
        self.assertFalse(res_l.mirror_attempted)

        # Case M: same configuration -> candidate_status_actions mirror NO
        _, res_m = self.manager.execute_dual_write(
            domain="candidate_status_actions",
            mutation_type="action",
            authoritative_payload={"id": "act-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "extra_attempt_grants"},
        )
        self.assertFalse(res_m.mirror_attempted)

    # 20. Candidate Status Actions Adapter
    def test_candidate_status_actions_adapter_transformation(self):
        adapter = CandidateStatusActionsAdapter()
        payload = {
            "action_id": "act-override-123",
            "session_id": "a09d6827-2b41-5696-9167-750188fc1caa",
            "action_type": "readiness_override",
            "result": "Needs Retest / Additional Coaching",
            "reason": "Technical audio distortion",
            "actor_name": "Shawn Bly",
        }
        transformed = adapter.transform_payload(payload)
        self.assertEqual(transformed["action_id"], "act-override-123")
        self.assertEqual(transformed["session_id"], "a09d6827-2b41-5696-9167-750188fc1caa")
        self.assertEqual(transformed["action_type"], "readiness_override")
        self.assertEqual(transformed["result"], "Needs Retest / Additional Coaching")
        self.assertEqual(transformed["reason"], "Technical audio distortion")
        self.assertEqual(transformed["actor_name"], "Shawn Bly")
        self.assertEqual(transformed["source_provider"], "sheets")
        self.assertIsNotNone(transformed["occurred_at"])

    # 21. Candidate Status Actions Section 18 Gate Test Cases (A through M)
    def test_candidate_status_actions_section_18_gate_cases(self):
        auth_mock = Mock(return_value={"ok": True, "action_id": "act-1"})

        # Case A: MTS_DUAL_WRITE_ENABLED=false -> candidate_status_actions mirror NO
        _, res_a = self.manager.execute_dual_write(
            domain="candidate_status_actions",
            mutation_type="action",
            authoritative_payload={"action_id": "act-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "false", "MTS_DUAL_WRITE_DOMAINS": "candidate_status_actions"},
        )
        self.assertFalse(res_a.mirror_attempted)

        # Case B: MTS_DUAL_WRITE_ENABLED=true, MTS_DUAL_WRITE_DOMAINS=notifications -> candidate_status_actions mirror NO
        _, res_b = self.manager.execute_dual_write(
            domain="candidate_status_actions",
            mutation_type="action",
            authoritative_payload={"action_id": "act-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "notifications"},
        )
        self.assertFalse(res_b.mirror_attempted)

        # Case C: MTS_DUAL_WRITE_ENABLED=true, MTS_DUAL_WRITE_DOMAINS=candidate_status_actions -> candidate_status_actions mirror YES
        self.mock_supabase.list_resource.return_value = [{"action_id": "act-1", "action_type": "readiness_override", "result": "PASS"}]
        _, res_c = self.manager.execute_dual_write(
            domain="candidate_status_actions",
            mutation_type="action",
            authoritative_payload={"action_id": "act-1", "action_type": "readiness_override", "result": "PASS"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidate_status_actions"},
        )
        self.assertTrue(res_c.mirror_attempted)
        self.assertTrue(res_c.mirror_success)

        # Case D: same configuration -> notifications mirror NO
        _, res_d = self.manager.execute_dual_write(
            domain="notifications",
            mutation_type="update",
            authoritative_payload={"ID": "notif-1", "Title": "T"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidate_status_actions"},
        )
        self.assertFalse(res_d.mirror_attempted)

        # Case E: same configuration -> headset_reviews mirror NO
        _, res_e = self.manager.execute_dual_write(
            domain="headset_reviews",
            mutation_type="action",
            authoritative_payload={"review_id": "hr-1", "brand": "B", "model": "M"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidate_status_actions"},
        )
        self.assertFalse(res_e.mirror_attempted)

        # Case F: same configuration -> newbie_shift_requests mirror NO
        _, res_f = self.manager.execute_dual_write(
            domain="newbie_shift_requests",
            mutation_type="action",
            authoritative_payload={"request_id": "newbie-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidate_status_actions"},
        )
        self.assertFalse(res_f.mirror_attempted)

        # Case G: same configuration -> supervisor_transfers mirror NO
        _, res_g = self.manager.execute_dual_write(
            domain="supervisor_transfers",
            mutation_type="action",
            authoritative_payload={"transfer_id": "trans-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidate_status_actions"},
        )
        self.assertFalse(res_g.mirror_attempted)

        # Case H: same configuration -> candidate_corrections mirror NO
        _, res_h = self.manager.execute_dual_write(
            domain="candidate_corrections",
            mutation_type="action",
            authoritative_payload={"request_id": "corr-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidate_status_actions"},
        )
        self.assertFalse(res_h.mirror_attempted)

        # Case I: same configuration -> extra_attempt_grants mirror NO
        _, res_i = self.manager.execute_dual_write(
            domain="extra_attempt_grants",
            mutation_type="action",
            authoritative_payload={"action_id": "extra-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidate_status_actions"},
        )
        self.assertFalse(res_i.mirror_attempted)

        # Case J: same configuration -> candidates mirror NO
        _, res_j = self.manager.execute_dual_write(
            domain="candidates",
            mutation_type="update",
            authoritative_payload={"source_candidate_id": "c-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidate_status_actions"},
        )
        self.assertFalse(res_j.mirror_attempted)

        # Case K: same configuration -> candidate_sessions mirror NO
        _, res_k = self.manager.execute_dual_write(
            domain="candidate_sessions",
            mutation_type="update",
            authoritative_payload={"session_id": "s-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidate_status_actions"},
        )
        self.assertFalse(res_k.mirror_attempted)

        # Case L: same configuration -> session_attempts mirror NO
        _, res_l = self.manager.execute_dual_write(
            domain="session_attempts",
            mutation_type="create",
            authoritative_payload={"id": "att-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidate_status_actions"},
        )
        self.assertFalse(res_l.mirror_attempted)

        # Case M: same configuration -> pending_requests mirror NO
        _, res_m = self.manager.execute_dual_write(
            domain="pending_requests",
            mutation_type="action",
            authoritative_payload={"request_id": "req-1"},
            authoritative_write_fn=auth_mock,
            environ={"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidate_status_actions"},
        )
        self.assertFalse(res_m.mirror_attempted)

    # 22. Candidates Adapter & Session Attempts Adapter Transformation
    def test_candidates_adapter_transformation(self):
        adapter = CandidatesAdapter()
        payload = {
            "source_candidate_id": "cand-123",
            "display_name": "Jordan Harris",
            "status": "active",
        }
        transformed = adapter.transform_payload(payload)
        self.assertEqual(transformed["source_candidate_id"], "cand-123")
        self.assertEqual(transformed["display_name"], "Jordan Harris")
        self.assertEqual(transformed["normalized_name"], "jordan harris")
        self.assertEqual(transformed["current_status"], "active")
        self.assertIsNotNone(transformed["updated_at"])

    def test_session_attempts_adapter_transformation(self):
        adapter = SessionAttemptsAdapter()
        payload = {
            "source_action_id": "att-sess-1-1",
            "session_id": "sess-1",
            "attempt_number": 1,
            "attempt_type": "mock_call",
            "result": "Pass",
            "details": {"score": 95},
        }
        transformed = adapter.transform_payload(payload)
        self.assertEqual(transformed["source_action_id"], "att-sess-1-1")
        self.assertEqual(transformed["session_id"], "sess-1")
        self.assertEqual(transformed["attempt_number"], 1)
        self.assertEqual(transformed["attempt_type"], "mock_call")
        self.assertEqual(transformed["result"], "Pass")
        self.assertEqual(transformed["details"], {"score": 95})

    # 23. Multi-Domain Gate Verification for Candidate Lifecycle Group (Section 24 & 25)
    def test_candidate_lifecycle_multi_domain_gate_cases(self):
        auth_mock = Mock(return_value={"ok": True})
        multi_domain_env = {
            "MTS_DUAL_WRITE_ENABLED": "true",
            "MTS_DUAL_WRITE_DOMAINS": "candidates,candidate_sessions,session_attempts",
        }

        # Case 1: GLOBAL OFF -> all 3 blocked
        for dom in ["candidates", "candidate_sessions", "session_attempts"]:
            _, res = self.manager.execute_dual_write(
                domain=dom,
                mutation_type="update",
                authoritative_payload={"id": "x"},
                authoritative_write_fn=auth_mock,
                environ={"MTS_DUAL_WRITE_ENABLED": "false", "MTS_DUAL_WRITE_DOMAINS": "candidates,candidate_sessions,session_attempts"},
            )
            self.assertFalse(res.mirror_attempted)

        # Case 2: GLOBAL ON + only candidates -> candidate YES, session NO, attempt NO
        cand_only_env = {"MTS_DUAL_WRITE_ENABLED": "true", "MTS_DUAL_WRITE_DOMAINS": "candidates"}
        self.mock_supabase.list_resource.return_value = [{"source_candidate_id": "c1", "display_name": "N"}]
        _, res_cand = self.manager.execute_dual_write(
            domain="candidates",
            mutation_type="create",
            authoritative_payload={"source_candidate_id": "c1", "display_name": "N"},
            authoritative_write_fn=auth_mock,
            environ=cand_only_env,
        )
        self.assertTrue(res_cand.mirror_attempted)
        self.assertTrue(res_cand.mirror_success)

        _, res_sess = self.manager.execute_dual_write(
            domain="candidate_sessions",
            mutation_type="create",
            authoritative_payload={"session_id": "s1"},
            authoritative_write_fn=auth_mock,
            environ=cand_only_env,
        )
        self.assertFalse(res_sess.mirror_attempted)

        _, res_att = self.manager.execute_dual_write(
            domain="session_attempts",
            mutation_type="create",
            authoritative_payload={"source_action_id": "a1"},
            authoritative_write_fn=auth_mock,
            environ=cand_only_env,
        )
        self.assertFalse(res_att.mirror_attempted)

        # Case 3: Approved 3-domain group -> all 3 mirror YES
        self.mock_supabase.list_resource.side_effect = [
            [{"source_candidate_id": "c1", "display_name": "N"}],
            [{"session_id": "s1", "raw_status": "in_progress", "status": "in_progress"}],
            [{"source_action_id": "a1", "result": "Pass", "attempt_number": 1}],
        ]
        _, res_cand_g = self.manager.execute_dual_write(
            domain="candidates", mutation_type="create", authoritative_payload={"source_candidate_id": "c1", "display_name": "N"}, authoritative_write_fn=auth_mock, environ=multi_domain_env,
        )
        _, res_sess_g = self.manager.execute_dual_write(
            domain="candidate_sessions", mutation_type="create", authoritative_payload={"session_id": "s1"}, authoritative_write_fn=auth_mock, environ=multi_domain_env,
        )
        _, res_att_g = self.manager.execute_dual_write(
            domain="session_attempts", mutation_type="create", authoritative_payload={"source_action_id": "a1", "result": "Pass", "attempt_number": 1}, authoritative_write_fn=auth_mock, environ=multi_domain_env,
        )
        self.assertTrue(res_cand_g.mirror_attempted)
        self.assertTrue(res_sess_g.mirror_attempted)
        self.assertTrue(res_att_g.mirror_attempted)

        # Case 4: Unrelated domains -> ALL NO
        unrelated = [
            "notifications", "headset_reviews", "newbie_shift_requests",
            "supervisor_transfers", "candidate_corrections", "extra_attempt_grants",
            "candidate_status_actions", "pending_requests"
        ]
        for dom in unrelated:
            _, res_u = self.manager.execute_dual_write(
                domain=dom, mutation_type="action", authoritative_payload={"id": "x"}, authoritative_write_fn=auth_mock, environ=multi_domain_env,
            )
            self.assertFalse(res_u.mirror_attempted, f"Domain {dom} should be blocked under candidate lifecycle group")

    # 24. Controlled Candidate Lifecycle Workflow Integration Tests (Section 71)
    def test_candidate_lifecycle_workflow_orchestration(self):
        multi_domain_env = {
            "MTS_DUAL_WRITE_ENABLED": "true",
            "MTS_DUAL_WRITE_DOMAINS": "candidates,candidate_sessions,session_attempts",
        }

        # Scenario A: New candidate + session + attempt 1 (happy path)
        self.mock_supabase.list_resource.side_effect = [
            [{"source_candidate_id": "c-fixture-1", "display_name": "Alex Smith"}],
            [{"session_id": "s-fixture-1", "status": "in_progress", "raw_status": "in_progress"}],
            [{"source_action_id": "att-s1-1", "result": "Pass", "attempt_number": 1}],
        ]
        wf_res = self.manager.execute_candidate_lifecycle_workflow(
            candidate_payload={"source_candidate_id": "c-fixture-1", "display_name": "Alex Smith", "is_new": True},
            candidate_authoritative_write_fn=lambda: {"ok": True, "id": "c-fixture-1"},
            session_payload={"session_id": "s-fixture-1", "candidate_name": "Alex Smith", "is_new": True},
            session_authoritative_write_fn=lambda: {"ok": True, "id": "s-fixture-1"},
            attempt_payload={"source_action_id": "att-s1-1", "session_id": "s-fixture-1", "attempt_number": 1, "result": "Pass"},
            attempt_authoritative_write_fn=lambda: {"ok": True, "id": "att-s1-1"},
            environ=multi_domain_env,
        )
        self.assertTrue(wf_res["all_mirrors_succeeded"])
        self.assertTrue(wf_res["candidate_mirror_result"].mirror_success)
        self.assertTrue(wf_res["session_mirror_result"].mirror_success)
        self.assertTrue(wf_res["attempt_mirror_result"].mirror_success)
        self.assertEqual(len(self.tracker.list_divergences(unresolved_only=True)), 0)

        # Scenario B: Existing candidate + new session + attempt 1
        self.mock_supabase.list_resource.side_effect = [
            [{"source_candidate_id": "c-fixture-1", "display_name": "Alex Smith"}],
            [{"session_id": "s-fixture-2", "status": "in_progress", "raw_status": "in_progress"}],
            [{"source_action_id": "att-s2-1", "result": "Fail", "attempt_number": 1}],
        ]
        wf_res_b = self.manager.execute_candidate_lifecycle_workflow(
            candidate_payload={"source_candidate_id": "c-fixture-1", "display_name": "Alex Smith", "is_new": False},
            candidate_authoritative_write_fn=lambda: {"ok": True, "id": "c-fixture-1"},
            session_payload={"session_id": "s-fixture-2", "candidate_name": "Alex Smith", "is_new": True},
            session_authoritative_write_fn=lambda: {"ok": True, "id": "s-fixture-2"},
            attempt_payload={"source_action_id": "att-s2-1", "session_id": "s-fixture-2", "attempt_number": 1, "result": "Fail"},
            attempt_authoritative_write_fn=lambda: {"ok": True, "id": "att-s2-1"},
            environ=multi_domain_env,
        )
        self.assertTrue(wf_res_b["all_mirrors_succeeded"])

        # Scenario C: Second legitimate attempt on same session
        self.mock_supabase.list_resource.side_effect = [
            [{"source_action_id": "att-s2-2", "result": "Pass", "attempt_number": 2}],
        ]
        _, att_res_2 = self.manager.execute_dual_write(
            domain="session_attempts",
            mutation_type="create",
            authoritative_payload={"source_action_id": "att-s2-2", "session_id": "s-fixture-2", "attempt_number": 2, "result": "Pass"},
            authoritative_write_fn=lambda: {"ok": True, "id": "att-s2-2"},
            environ=multi_domain_env,
        )
        self.assertTrue(att_res_2.mirror_success)

        # Scenario D: Attempt mirror failure does NOT roll back candidate/session or Sheets
        self.mock_supabase.list_resource.side_effect = [
            [{"source_candidate_id": "c-fixture-3", "display_name": "Chris Lee"}],
            [{"session_id": "s-fixture-3", "status": "in_progress", "raw_status": "in_progress"}],
            SupabaseProviderError("Supabase timeout on attempts (status 504)"),
        ]
        wf_res_d = self.manager.execute_candidate_lifecycle_workflow(
            candidate_payload={"source_candidate_id": "c-fixture-3", "display_name": "Chris Lee", "is_new": True},
            candidate_authoritative_write_fn=lambda: {"ok": True, "id": "c-fixture-3"},
            session_payload={"session_id": "s-fixture-3", "candidate_name": "Chris Lee", "is_new": True},
            session_authoritative_write_fn=lambda: {"ok": True, "id": "s-fixture-3"},
            attempt_payload={"source_action_id": "att-s3-1", "session_id": "s-fixture-3", "attempt_number": 1, "result": "Pass"},
            attempt_authoritative_write_fn=lambda: {"ok": True, "id": "att-s3-1"},
            environ=multi_domain_env,
        )
        self.assertFalse(wf_res_d["all_mirrors_succeeded"])
        self.assertTrue(wf_res_d["candidate_authoritative_result"]["ok"])
        self.assertTrue(wf_res_d["session_authoritative_result"]["ok"])
        self.assertTrue(wf_res_d["attempt_authoritative_result"]["ok"])
        self.assertTrue(wf_res_d["candidate_mirror_result"].mirror_success)
        self.assertTrue(wf_res_d["session_mirror_result"].mirror_success)
        self.assertFalse(wf_res_d["attempt_mirror_result"].mirror_success)
        # Exactly 1 divergence recorded for session_attempts
        divs = self.tracker.list_divergences(unresolved_only=True)
        self.assertEqual(len(divs), 1)
        self.assertEqual(divs[0]["domain"], "session_attempts")

        # Scenario E: Dependency-aware repair for the failed attempt only
        self.mock_supabase.list_resource.side_effect = [
            [{"source_action_id": "att-s3-1", "result": "Pass", "attempt_number": 1}],
        ]
        repair_res = self.manager.retry_divergence(divs[0]["operation_id"])
        self.assertTrue(repair_res.mirror_success)
        self.assertEqual(len(self.tracker.list_divergences(unresolved_only=True)), 0)

    # 25. Readiness Report (Section 45)
    def test_readiness_report_structure(self):
        report = self.tracker.get_readiness_report({
            "MTS_DATA_PROVIDER": "sheets",
            "MTS_DUAL_WRITE_ENABLED": "true",
            "MTS_DUAL_WRITE_DOMAINS": "candidates,candidate_sessions,session_attempts",
        })
        self.assertTrue(report["dual_write_implementation_ready"])
        self.assertTrue(report["dual_write_enabled"])
        self.assertEqual(sorted(report["active_domains"]), sorted(["candidates", "candidate_sessions", "session_attempts"]))
        self.assertEqual(report["pending_divergences"], 0)
        self.assertTrue(report["idempotency_ready"])
        self.assertTrue(report["repair_tracking_ready"])
        self.assertIn("notifications", report["eligible_domains"])
        self.assertIn("callers", report["excluded_domains"])


if __name__ == "__main__":
    unittest.main()

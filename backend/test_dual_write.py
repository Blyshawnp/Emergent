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
    build_operation_id,
    compute_payload_digest,
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
        self.assertEqual(dw_res.mirror_status, "skipped_flag_disabled")
        self.assertEqual(self.tracker.pending_count(), 0)

    # 2. Authoritative Failure Rule (Section 9 & 35)
    def test_authoritative_failure_prevents_supabase_mirror(self):
        auth_write_mock = Mock(return_value={"ok": False, "error": "Sheets quota exceeded"})
        environ = {"MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "true"}

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
        environ = {"MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "true"}

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

    # 3. Controlled Flag ON - Success Path (Section 27 & 41)
    def test_controlled_flag_on_executes_and_verifies_supabase_mirror(self):
        auth_write_mock = Mock(return_value={"ok": True, "id": "notif-1"})
        environ = {"MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "true"}

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

    # 4. Mirror Failure Rule - Sheets Up / Supabase Down (Section 10 & 36)
    def test_supabase_mirror_failure_records_divergence_without_failing_authoritative_action(self):
        auth_write_mock = Mock(return_value={"ok": True, "id": "notif-1"})
        environ = {"MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "true"}

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

    # 5. Post-Write Mismatch Test (Section 11 & 37)
    def test_post_write_mismatch_fails_verification_and_records_divergence(self):
        auth_write_mock = Mock(return_value={"ok": True, "id": "notif-1"})
        environ = {"MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "true"}

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

    # 6. Retry Idempotency & Duplicate Protection (Section 13 & 38)
    def test_retry_same_operation_uses_identical_operation_id_and_updates_divergence(self):
        payload = {"ID": "notif-idemp", "Title": "Title", "Message": "Msg"}
        digest1 = compute_payload_digest(payload)
        digest2 = compute_payload_digest(payload)
        self.assertEqual(digest1, digest2)

        op_id_1 = build_operation_id("notifications", "insert", "notif-idemp", digest1)
        op_id_2 = build_operation_id("notifications", "insert", "notif-idemp", digest2)
        self.assertEqual(op_id_1, op_id_2)

        environ = {"MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "true"}

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

    # 7. Notification Null Expiration Semantics (Section 18)
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
        self.assertIsNone(transformed["end_date"])
        self.assertIsNone(transformed["end_time"])
        self.assertIsNone(transformed["expires_at"])

    # 8. Domain Allowlist & Excluded Domains (Section 14 & 46)
    def test_unsupported_domain_skips_mirror_cleanly(self):
        auth_write_mock = Mock(return_value={"ok": True})
        environ = {"MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "true"}

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

    # 9. Headset Reviews Adapter
    def test_headset_reviews_adapter_transformation(self):
        adapter = HeadsetReviewsAdapter()
        payload = {
            "id": "hr-1",
            "brand": "Logitech",
            "model": "H390",
            "status": "Approved",
            "notes": "Good audio",
            "tester": "Tester 1",
            "session_id": "sess-123",
        }
        transformed = adapter.transform_payload(payload)
        self.assertEqual(transformed["id"], "hr-1")
        self.assertEqual(transformed["headset_brand"], "Logitech")
        self.assertEqual(transformed["headset_model"], "H390")
        self.assertEqual(transformed["status"], "approved")
        self.assertEqual(transformed["source_session_id"], "sess-123")

    # 10. Candidate Sessions Adapter
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

    # 11. Readiness Report (Section 45)
    def test_readiness_report_structure(self):
        report = self.tracker.get_readiness_report({"MTS_DATA_PROVIDER": "sheets", "MTS_DUAL_WRITE_ENABLED": "false"})
        self.assertTrue(report["dual_write_implementation_ready"])
        self.assertFalse(report["dual_write_enabled"])
        self.assertEqual(report["pending_divergences"], 0)
        self.assertTrue(report["idempotency_ready"])
        self.assertTrue(report["repair_tracking_ready"])
        self.assertIn("notifications", report["eligible_domains"])
        self.assertIn("callers", report["excluded_domains"])


if __name__ == "__main__":
    unittest.main()

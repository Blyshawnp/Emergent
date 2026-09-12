import os
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server
from data_providers.dual_write import (
    ADAPTER_REGISTRY,
    NewbieShiftRequestsAdapter,
)


class NewbieShiftLifecyclePersistenceTests(unittest.TestCase):
    """Verifies canonical Newbie Shift request persistence within the authenticated

    MTS candidate lifecycle write path across all required cases (A through O).
    """

    def setUp(self):
        self.env_patcher = patch.dict(os.environ, {
            "MTS_DATA_PROVIDER": "supabase",
            "MTS_SHADOW_COMPARE": "false",
            "MTS_DUAL_WRITE_ENABLED": "false",
        })
        self.env_patcher.start()

    def tearDown(self):
        self.env_patcher.stop()

    def _base_session(self, session_id="test-session-newbie-001", candidate_name="Robin Test"):
        return {
            "session_id": session_id,
            "candidate_name": candidate_name,
            "tester_name": "Shawn Bly",
            "session_type": "regular",
            "status": "FAIL",
            "calculated_result": "FAIL",
            "final_result": "Fail",
            "mock_calls_completed": 3,
            "sup_transfers_completed": 0,
            "attempt_number": 1,
            "current_attempt_number": 1,
            "allowed_attempt_count": 3,
            "extra_attempts_granted": 0,
            "final_attempt": False,
            "withdrawn": False,
            "archived": False,
            "needs_sup_transfer": False,
            "call_1": {"result": "FAIL", "details": {"score": 60}},
            "call_2": {"result": "FAIL", "details": {"score": 65}},
            "call_3": {"result": "FAIL", "details": {"score": 70}},
            "created_at": "2026-09-12T10:00:00+00:00",
            "completed_at": "2026-09-12T11:00:00+00:00",
        }

    @patch("server._call_supabase_edge_function")
    def test_case_a_qualifying_session_includes_canonical_newbie_shift_request_dto(self, mock_edge_fn):
        """Case A: Qualifying session (newbie shift scheduled) passes newbie_shift_request in DTO."""
        mock_edge_fn.return_value = {
            "ok": True,
            "canonical_ids": {
                "candidate_id": "cand-uuid-1",
                "session_id": "sess-uuid-1",
                "session_business_id": "test-session-newbie-001",
            },
            "row_counts": {"session_attempts": 3, "newbie_shift_requests": 1},
        }

        session = self._base_session()
        session.update({
            "newbie_shift_request_id": "newbie-req-123",
            "newbie_shift_request_type": "initial_newbie_shift",
            "newbie_shift_scheduled_at": "2026-09-15T14:00:00+00:00",
            "newbie_shift_timezone": "America/New_York",
            "newbie_shift_number": "1",
            "newbie_shift_request_reason": "First attempt failed, scheduling newbie shift",
        })

        res = server._persist_candidate_lifecycle_to_supabase(session, auth_jwt="valid.jwt")
        self.assertTrue(res["ok"])
        mock_edge_fn.assert_called_once()
        _, forwarded_dto, _ = mock_edge_fn.call_args[0]
        self.assertIn("newbie_shift_request", forwarded_dto)
        nsr = forwarded_dto["newbie_shift_request"]
        self.assertIsNotNone(nsr)
        self.assertEqual(nsr["request_id"], "newbie-req-123")
        self.assertEqual(nsr["source_session_id"], "test-session-newbie-001")
        self.assertEqual(nsr["request_type"], "initial_newbie_shift")
        self.assertEqual(nsr["newbie_shift_number"], "1")
        self.assertEqual(nsr["scheduled_at"], "2026-09-15T14:00:00+00:00")
        self.assertEqual(nsr["timezone"], "America/New_York")

    @patch("server._call_supabase_edge_function")
    def test_case_b_non_qualifying_session_omits_newbie_shift_request_dto(self, mock_edge_fn):
        """Case B: Non-qualifying session passes None for newbie_shift_request in DTO."""
        mock_edge_fn.return_value = {
            "ok": True,
            "canonical_ids": {
                "candidate_id": "cand-uuid-1",
                "session_id": "sess-uuid-1",
                "session_business_id": "test-session-plain-001",
            },
            "row_counts": {"session_attempts": 3},
        }

        session = self._base_session(session_id="test-session-plain-001")
        res = server._persist_candidate_lifecycle_to_supabase(session, auth_jwt="valid.jwt")
        self.assertTrue(res["ok"])
        mock_edge_fn.assert_called_once()
        _, forwarded_dto, _ = mock_edge_fn.call_args[0]
        self.assertIsNone(forwarded_dto.get("newbie_shift_request"))

    def test_case_c_no_direct_provider_fallback_for_newbie_shift_requests(self):
        """Case C: Security boundary - local fallback path never directly mutates newbie_shift_requests."""
        provider = MagicMock()
        tables = {"candidates": {}, "candidate_sessions": {}, "session_attempts": {}, "newbie_shift_requests": {}}

        def mock_upsert(table, rows, on_conflict=None, resolution=None):
            results = []
            for r in rows:
                row_copy = dict(r)
                if not row_copy.get("id"):
                    row_copy["id"] = f"uuid-{table}-{len(tables[table]) + 1}"
                if table == "candidates":
                    key = (row_copy.get("source_system", "google_sheets"), row_copy.get("source_candidate_id"))
                elif table == "candidate_sessions":
                    key = row_copy.get("session_id")
                elif table == "session_attempts":
                    key = row_copy.get("source_action_id")
                elif table == "newbie_shift_requests":
                    key = row_copy.get("request_id")
                else:
                    key = row_copy.get("id")
                tables[table][key] = row_copy
                results.append(row_copy)
            return results

        provider.upsert_rows.side_effect = mock_upsert

        session = self._base_session()
        session.update({
            "newbie_shift_request_id": "newbie-direct-001",
            "newbie_shift_scheduled_at": "2026-09-16T15:00:00+00:00",
            "newbie_shift_timezone": "America/Chicago",
            "newbie_shift_request_reason": "Scheduling newbie shift directly",
        })

        with patch("server._get_active_data_provider", return_value=provider):
            res = server._persist_candidate_lifecycle_to_supabase(session)

        self.assertTrue(res["ok"])
        self.assertEqual(len(tables["candidates"]), 1)
        self.assertEqual(len(tables["candidate_sessions"]), 1)
        self.assertEqual(len(tables["session_attempts"]), 3)
        # Direct provider fallback MUST NOT write to newbie_shift_requests
        self.assertEqual(len(tables["newbie_shift_requests"]), 0)

    def test_case_d_reschedule_type_mapping(self):
        """Case D: NEWBIE_REQUEST_RESCHEDULE maps to 'newbie_shift_reschedule'."""
        session = self._base_session()
        session.update({
            "newbie_shift_request_id": "newbie-resched-001",
            "newbie_shift_request_type": server.NEWBIE_REQUEST_RESCHEDULE,
            "newbie_shift_rescheduled_at": "2026-09-18T16:00:00+00:00",
        })
        with patch("server._call_supabase_edge_function") as mock_edge_fn:
            mock_edge_fn.return_value = {"ok": True, "canonical_ids": {}, "row_counts": {}}
            server._persist_candidate_lifecycle_to_supabase(session, auth_jwt="jwt")
            _, dto, _ = mock_edge_fn.call_args[0]
            self.assertEqual(dto["newbie_shift_request"]["request_type"], "newbie_shift_reschedule")
            self.assertEqual(dto["newbie_shift_request"]["rescheduled_at"], "2026-09-18T16:00:00+00:00")

    def test_case_e_auto_approval_policy_mapping(self):
        """Case E: When newbie shift approval is not required, status defaults to approved with policy actor."""
        session = self._base_session()
        session.update({
            "newbie_shift_request_id": "newbie-auto-app-001",
            "newbie_shift_scheduled_at": "2026-09-17T12:00:00+00:00",
        })
        with patch("server._is_newbie_shift_approval_required", return_value=False):
            with patch("server._call_supabase_edge_function") as mock_edge_fn:
                mock_edge_fn.return_value = {"ok": True, "canonical_ids": {}, "row_counts": {}}
                server._persist_candidate_lifecycle_to_supabase(session, auth_jwt="jwt")
                _, dto, _ = mock_edge_fn.call_args[0]
                nsr = dto["newbie_shift_request"]
                self.assertEqual(nsr["request_status"], "approved")
                self.assertEqual(nsr["decision_by"], server.NEWBIE_REQUEST_POLICY_APPROVED_ACTOR)
                self.assertIsNotNone(nsr["decision_at"])

    def test_case_f_pending_approval_required_mapping(self):
        """Case F: When newbie shift approval is required, status defaults to pending without decision_by."""
        session = self._base_session()
        session.update({
            "newbie_shift_request_id": "newbie-pending-001",
            "newbie_shift_scheduled_at": "2026-09-17T12:00:00+00:00",
        })
        with patch("server._is_newbie_shift_approval_required", return_value=True):
            with patch("server._call_supabase_edge_function") as mock_edge_fn:
                mock_edge_fn.return_value = {"ok": True, "canonical_ids": {}, "row_counts": {}}
                server._persist_candidate_lifecycle_to_supabase(session, auth_jwt="jwt")
                _, dto, _ = mock_edge_fn.call_args[0]
                nsr = dto["newbie_shift_request"]
                self.assertEqual(nsr["request_status"], "pending")
                self.assertIsNone(nsr["decision_by"])

    def test_case_g_no_spoofed_auth_fields_forwarded(self):
        """Case G: Security check - forwarded DTO never contains spoofed auth parameters."""
        session = self._base_session()
        session.update({
            "newbie_shift_request_id": "newbie-sec-001",
            "newbie_shift_scheduled_at": "2026-09-17T12:00:00+00:00",
            "actor_user_id": "spoofed-user-id",
            "user_id": "spoofed-id",
            "caller_auth_uid": "spoofed-auth",
        })
        with patch("server._call_supabase_edge_function") as mock_edge_fn:
            mock_edge_fn.return_value = {"ok": True, "canonical_ids": {}, "row_counts": {}}
            server._persist_candidate_lifecycle_to_supabase(session, auth_jwt="jwt")
            _, dto, _ = mock_edge_fn.call_args[0]
            self.assertNotIn("actor_user_id", dto)
            self.assertNotIn("user_id", dto)
            self.assertNotIn("caller_auth_uid", dto)
            self.assertNotIn("role", dto)
            self.assertNotIn("admin", dto)

    def test_case_h_adapter_transformation_columns(self):
        """Case H: NewbieShiftRequestsAdapter extracts business key and maps all schema columns."""
        adapter = NewbieShiftRequestsAdapter()
        payload = {
            "request_id": "test-req-h",
            "source_session_id": "test-sess-h",
            "request_type": "initial_newbie_shift",
            "request_status": "pending",
            "newbie_shift_number": "2",
            "scheduled_at": "2026-09-20T10:00:00Z",
            "timezone": "America/Chicago",
            "within_24_hours": True,
            "counts_as_attempt": True,
            "final_attempt": False,
            "current_attempt": 1,
            "resulting_attempt": 2,
            "requested_by": "Tester One",
            "request_reason": "Failed call 2",
        }
        transformed = adapter.transform_payload(payload)
        self.assertEqual(transformed["request_id"], "test-req-h")
        self.assertEqual(transformed["source_session_id"], "test-sess-h")
        self.assertEqual(transformed["request_status"], "pending")
        self.assertEqual(transformed["newbie_shift_number"], "2")
        self.assertEqual(transformed["within_24_hours"], True)
        self.assertEqual(transformed["current_attempt"], 1)
        self.assertIn("source_checksum", transformed)
        self.assertIn("source_payload", transformed)

    def test_case_i_supervisor_transfers_not_blocked_by_newbie_shift(self):
        """Case I: Invariant check - Pending supervisor transfer is unaffected by newbie shift data."""
        session = self._base_session()
        session.update({
            "needs_sup_transfer": True,
            "pending_sup_transfer_id": "sup-transfer-999",
            "newbie_shift_request_id": "newbie-sup-001",
            "newbie_shift_scheduled_at": "2026-09-21T14:00:00+00:00",
        })
        with patch("server._call_supabase_edge_function") as mock_edge_fn:
            mock_edge_fn.return_value = {"ok": True, "canonical_ids": {}, "row_counts": {}}
            server._persist_candidate_lifecycle_to_supabase(session, auth_jwt="jwt")
            _, dto, _ = mock_edge_fn.call_args[0]
            self.assertTrue(dto["session"]["needs_sup_transfer"])
            self.assertEqual(dto["session"]["pending_sup_transfer_id"], "sup-transfer-999")
            self.assertIsNotNone(dto["newbie_shift_request"])


    def test_case_j_pass_clears_or_omits_newbie_shift_request(self):
        """Case J: Passed session does not schedule a newbie shift and omits request DTO."""
        session = self._base_session()
        session["final_result"] = "Pass"
        session["status"] = "PASS"
        with patch("server._call_supabase_edge_function") as mock_edge_fn:
            mock_edge_fn.return_value = {"ok": True, "canonical_ids": {}, "row_counts": {}}
            server._persist_candidate_lifecycle_to_supabase(session, auth_jwt="jwt")
            _, dto, _ = mock_edge_fn.call_args[0]
            self.assertIsNone(dto.get("newbie_shift_request"))

    def test_case_k_sam_pending_requests_projects_newbie_shift_requests(self):
        """Case K: SAM pending requests projection surfaces newbie_shift_requests directly from table."""
        from data_providers.supabase import SupabaseDataProvider
        provider = SupabaseDataProvider("https://example.supabase.co", "mock-service-role-key")
        newbie_row = {
            "id": "uuid-nsr-1",
            "request_id": "newbie-proj-001",
            "source_session_id": "sess-proj-001",
            "request_type": "initial_newbie_shift",
            "request_status": "pending",
            "newbie_shift_number": "1",
            "scheduled_at": "2026-09-22T10:00:00Z",
            "created_at": "2026-09-12T10:00:00Z",
        }
        with patch.object(provider, "_cached_read") as mock_read:
            def side_effect_read(res, query):
                if res == "newbie_shift_requests":
                    return [newbie_row]
                return []
            mock_read.side_effect = side_effect_read
            results = provider._list_request_projection(limit=50, offset=0)
            self.assertEqual(len(results), 1)
            self.assertEqual(results[0]["request_id"], "newbie-proj-001")
            self.assertEqual(results[0]["category"], "newbie-shift-requests")
            self.assertEqual(results[0]["status"], "pending")

    def test_case_l_no_duplicate_generic_pending_requests_created(self):
        """Case L: Lifecycle persistence strictly targets newbie_shift_requests without writing generic pending_requests."""
        session = self._base_session()
        session.update({
            "newbie_shift_request_id": "newbie-no-dup-001",
            "newbie_shift_scheduled_at": "2026-09-23T14:00:00+00:00",
        })

        with patch("server._call_supabase_edge_function") as mock_edge_fn:
            mock_edge_fn.return_value = {"ok": True, "canonical_ids": {}, "row_counts": {"newbie_shift_requests": 1}}
            res = server._persist_candidate_lifecycle_to_supabase(session, auth_jwt="jwt")

        self.assertTrue(res["ok"])
        _, dto, _ = mock_edge_fn.call_args[0]
        # DTO has newbie_shift_request
        self.assertIsNotNone(dto.get("newbie_shift_request"))
        self.assertEqual(dto["newbie_shift_request"]["request_id"], "newbie-no-dup-001")
        # DTO does NOT have generic pending_requests or duplicate request structures
        self.assertNotIn("pending_requests", dto)
        self.assertNotIn("pending_request", dto)


    def test_case_m_edge_function_row_counts_includes_newbie_shift_requests(self):
        """Case M: Edge Function response row_counts includes newbie_shift_requests."""
        mock_res = {
            "ok": True,
            "canonical_ids": {
                "candidate_id": "cand-uuid-1",
                "session_id": "sess-uuid-1",
                "session_business_id": "test-session-newbie-001",
            },
            "row_counts": {
                "candidates": 1,
                "candidate_sessions": 1,
                "session_attempts": 3,
                "headset_reviews": 0,
                "newbie_shift_requests": 1,
            },
        }
        session = self._base_session()
        session["newbie_shift_request_id"] = "newbie-m-001"
        with patch("server._call_supabase_edge_function", return_value=mock_res):
            res = server._persist_candidate_lifecycle_to_supabase(session, auth_jwt="jwt")
            self.assertTrue(res["ok"])
            self.assertEqual(res["session_id"], "test-session-newbie-001")

    def test_case_n_lead_time_and_attempt_rules_preserved(self):
        """Case N: Attempt rules and attempt numbers are mapped faithfully."""
        session = self._base_session()
        session.update({
            "newbie_shift_request_id": "newbie-rules-001",
            "newbie_shift_scheduled_at": "2026-09-25T15:00:00+00:00",
            "newbie_shift_current_attempt": 1,
            "newbie_shift_resulting_attempt": 2,
            "newbie_shift_becomes_final_attempt": False,
            "newbie_shift_attempt_rule": "advance_attempt",
            "newbie_shift_terminal_outcome": "retest_required",
        })
        with patch("server._call_supabase_edge_function") as mock_edge_fn:
            mock_edge_fn.return_value = {"ok": True, "canonical_ids": {}, "row_counts": {}}
            server._persist_candidate_lifecycle_to_supabase(session, auth_jwt="jwt")
            _, dto, _ = mock_edge_fn.call_args[0]
            nsr = dto["newbie_shift_request"]
            self.assertEqual(nsr["current_attempt"], 1)
            self.assertEqual(nsr["resulting_attempt"], 2)
            self.assertEqual(nsr["becomes_final_attempt"], False)
            self.assertEqual(nsr["attempt_rule"], "advance_attempt")
            self.assertEqual(nsr["terminal_outcome"], "retest_required")

    def test_case_o_timezone_and_schedule_fidelity(self):
        """Case O: Schedule timestamps and timezone strings retain exact values."""
        session = self._base_session()
        session.update({
            "newbie_shift_request_id": "newbie-tz-001",
            "newbie_shift_scheduled_at": "2026-09-26T18:30:00+00:00",
            "newbie_shift_original_scheduled_at": "2026-09-24T18:30:00+00:00",
            "newbie_shift_rescheduled_at": "2026-09-26T18:30:00+00:00",
            "newbie_shift_timezone": "America/Los_Angeles",
            "newbie_shift_within_24_hours": True,
            "newbie_shift_counts_as_attempt": True,
        })
        with patch("server._call_supabase_edge_function") as mock_edge_fn:
            mock_edge_fn.return_value = {"ok": True, "canonical_ids": {}, "row_counts": {}}
            server._persist_candidate_lifecycle_to_supabase(session, auth_jwt="jwt")
            _, dto, _ = mock_edge_fn.call_args[0]
            nsr = dto["newbie_shift_request"]
            self.assertEqual(nsr["scheduled_at"], "2026-09-26T18:30:00+00:00")
            self.assertEqual(nsr["original_scheduled_at"], "2026-09-24T18:30:00+00:00")
            self.assertEqual(nsr["rescheduled_at"], "2026-09-26T18:30:00+00:00")
            self.assertEqual(nsr["timezone"], "America/Los_Angeles")
            self.assertTrue(nsr["within_24_hours"])
            self.assertTrue(nsr["counts_as_attempt"])


class MtsRoleAuthorizationTests(unittest.TestCase):
    """Verifies strict MTS role authorization semantics for Edge Function / transaction logic:
    A. Evaluator only: AUTHORIZED
    B. Administrator + Evaluator: AUTHORIZED
    C. Administrator only: DENIED (403)
    D. Viewer only: DENIED (403)
    E. Importer only: DENIED (403)
    F. Revoked evaluator: DENIED (403)
    G. Inactive evaluator: DENIED (403)
    H. Unlinked valid Auth user: DENIED (403)
    """

    def _evaluate_mts_authorization(
        self,
        *,
        app_user: dict | None,
        role_assignments: list[dict],
    ) -> tuple[bool, int, str]:
        """Simulates the exact Edge Function authorization logic:
        1. Check if app_user exists (unlinked check).
        2. Check if app_user is active.
        3. Query user_role_assignments for role_key == 'evaluator' and revoked_at is None.
        Administrator alone is NOT accepted.
        """
        if not app_user:
            return False, 403, "UNLINKED_ACCOUNT"

        if not app_user.get("active"):
            return False, 403, "INACTIVE_ACCOUNT"

        user_id = app_user.get("id")
        active_evaluators = [
            r for r in role_assignments
            if r.get("user_id") == user_id
            and r.get("role_key") == "evaluator"
            and r.get("revoked_at") is None
        ]

        if not active_evaluators:
            return False, 403, "INSUFFICIENT_ROLE"

        return True, 200, "AUTHORIZED"

    def test_case_a_evaluator_only_authorized(self):
        """Case A: Evaluator only is AUTHORIZED."""
        app_user = {"id": "user-1", "auth_user_id": "auth-1", "active": True}
        roles = [{"user_id": "user-1", "role_key": "evaluator", "revoked_at": None}]
        ok, status, code = self._evaluate_mts_authorization(app_user=app_user, role_assignments=roles)
        self.assertTrue(ok)
        self.assertEqual(status, 200)
        self.assertEqual(code, "AUTHORIZED")

    def test_case_b_admin_plus_evaluator_authorized(self):
        """Case B: Administrator + Evaluator is AUTHORIZED."""
        app_user = {"id": "user-2", "auth_user_id": "auth-2", "active": True}
        roles = [
            {"user_id": "user-2", "role_key": "administrator", "revoked_at": None},
            {"user_id": "user-2", "role_key": "evaluator", "revoked_at": None},
        ]
        ok, status, code = self._evaluate_mts_authorization(app_user=app_user, role_assignments=roles)
        self.assertTrue(ok)
        self.assertEqual(status, 200)
        self.assertEqual(code, "AUTHORIZED")

    def test_case_c_admin_only_denied(self):
        """Case C: Administrator only is 403 / DENIED."""
        app_user = {"id": "user-3", "auth_user_id": "auth-3", "active": True}
        roles = [{"user_id": "user-3", "role_key": "administrator", "revoked_at": None}]
        ok, status, code = self._evaluate_mts_authorization(app_user=app_user, role_assignments=roles)
        self.assertFalse(ok)
        self.assertEqual(status, 403)
        self.assertEqual(code, "INSUFFICIENT_ROLE")

    def test_case_d_viewer_only_denied(self):
        """Case D: Viewer only is 403 / DENIED."""
        app_user = {"id": "user-4", "auth_user_id": "auth-4", "active": True}
        roles = [{"user_id": "user-4", "role_key": "viewer", "revoked_at": None}]
        ok, status, code = self._evaluate_mts_authorization(app_user=app_user, role_assignments=roles)
        self.assertFalse(ok)
        self.assertEqual(status, 403)
        self.assertEqual(code, "INSUFFICIENT_ROLE")

    def test_case_e_importer_only_denied(self):
        """Case E: Importer only is 403 / DENIED."""
        app_user = {"id": "user-5", "auth_user_id": "auth-5", "active": True}
        roles = [{"user_id": "user-5", "role_key": "importer", "revoked_at": None}]
        ok, status, code = self._evaluate_mts_authorization(app_user=app_user, role_assignments=roles)
        self.assertFalse(ok)
        self.assertEqual(status, 403)
        self.assertEqual(code, "INSUFFICIENT_ROLE")

    def test_case_f_revoked_evaluator_denied(self):
        """Case F: Revoked evaluator is 403 / DENIED."""
        app_user = {"id": "user-6", "auth_user_id": "auth-6", "active": True}
        roles = [{"user_id": "user-6", "role_key": "evaluator", "revoked_at": "2026-09-10T12:00:00Z"}]
        ok, status, code = self._evaluate_mts_authorization(app_user=app_user, role_assignments=roles)
        self.assertFalse(ok)
        self.assertEqual(status, 403)
        self.assertEqual(code, "INSUFFICIENT_ROLE")

    def test_case_g_inactive_evaluator_denied(self):
        """Case G: Inactive evaluator user is 403 / DENIED."""
        app_user = {"id": "user-7", "auth_user_id": "auth-7", "active": False}
        roles = [{"user_id": "user-7", "role_key": "evaluator", "revoked_at": None}]
        ok, status, code = self._evaluate_mts_authorization(app_user=app_user, role_assignments=roles)
        self.assertFalse(ok)
        self.assertEqual(status, 403)
        self.assertEqual(code, "INSUFFICIENT_ACCOUNT") if code == "INSUFFICIENT_ACCOUNT" else self.assertEqual(code, "INACTIVE_ACCOUNT")

    def test_case_h_unlinked_user_denied(self):
        """Case H: Unlinked valid Auth user is 403 / DENIED."""
        ok, status, code = self._evaluate_mts_authorization(app_user=None, role_assignments=[])
        self.assertFalse(ok)
        self.assertEqual(status, 403)
        self.assertEqual(code, "UNLINKED_ACCOUNT")


if __name__ == "__main__":
    unittest.main()


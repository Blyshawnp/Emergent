import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402


class AdditionalAttemptOverrideSafeguardTests(unittest.TestCase):
    """Targeted test suite for Additional Attempt Override safeguards and policy."""

    # -------------------------------------------------------------------------
    # Safeguard 1: Offline Conflict Resolution & SAM Review
    # -------------------------------------------------------------------------
    def test_safeguard1_migration_defines_conflict_resolution_and_reservation(self):
        migration = (
            Path(__file__).resolve().parents[1]
            / "supabase/migrations/20260921000000_mts_additional_attempt_overrides.sql"
        ).read_text(encoding="utf-8")

        self.assertIn("create table mts_sam.additional_attempt_overrides", migration)
        self.assertIn("resolve_offline_override_conflict", migration)
        self.assertIn("reserve_additional_attempt_session", migration)
        self.assertIn("cancel_additional_attempt_reservation", migration)
        self.assertIn("decide_additional_attempt_override", migration)
        self.assertIn("conflict_source_override_id", migration)
        self.assertIn("'conflict'", migration)
        self.assertIn("p_is_offline_emergency", migration)

    def test_safeguard1_conflict_session_does_not_auto_certify(self):
        # Even if a conflicting offline session has a 'PASS' result,
        # authorization_status = 'conflict' must prevent certification.
        conflict_session = {
            "session_id": "sess-offline-conflict-1",
            "attempt_number": 4,
            "status": "Pass",
            "final_result": "PASS",
            "authorization_status": "conflict",
            "additional_attempt_overridden": True,
        }
        self.assertFalse(server._is_session_certification_authorized(conflict_session))

        state = server.calculate_candidate_attempt_state([conflict_session])
        self.assertFalse(state["passed"])

    def test_safeguard1_offline_emergency_reservation_fallback(self):
        # When remote is unavailable, emergency_offline=True returns Option B local reservation
        # without crashing, assigning local_pending_sync status.
        orig_mode = server.configured_provider_mode
        try:
            server.configured_provider_mode = lambda: "supabase"
            # Unreachable / erroring mock
            res = server._reserve_additional_attempt_session(
                candidate_name="Test Candidate",
                source_candidate_id="cand-test",
                session_id="sess-offline-123",
                tester_name="Tester",
                reason="Candidate experienced disconnect during call 2",
                emergency_offline=True,
            )
            self.assertTrue(res["ok"])
            self.assertTrue(res.get("offline_emergency"))
            self.assertEqual(res.get("authorization_status"), "local_pending_sync")
            self.assertIn("sess-offline-123", res.get("reservation_id"))
        finally:
            server.configured_provider_mode = orig_mode

    # -------------------------------------------------------------------------
    # Safeguard 2: Historical Certification Compatibility
    # -------------------------------------------------------------------------
    def test_safeguard2_positive_authorization_explicit_statuses(self):
        self.assertTrue(server._is_session_certification_authorized({"authorization_status": "approved"}))
        self.assertTrue(server._is_session_certification_authorized({"authorization_status": "not_required"}))
        self.assertFalse(server._is_session_certification_authorized({"authorization_status": "pending_admin_authorization"}))
        self.assertFalse(server._is_session_certification_authorized({"authorization_status": "denied"}))
        self.assertFalse(server._is_session_certification_authorized({"authorization_status": "abandoned"}))
        self.assertFalse(server._is_session_certification_authorized({"authorization_status": "conflict"}))
        self.assertFalse(server._is_session_certification_authorized({"authorization_status": "local_pending_sync"}))

    def test_safeguard2_legacy_rows_without_authorization_status(self):
        # Standard legacy within-allowance attempts retain certification
        legacy_attempt_1 = {"session_id": "leg-1", "attempt_number": 1, "final_result": "PASS"}
        legacy_attempt_2 = {"session_id": "leg-2", "attempt_number": 2, "final_result": "PASS"}
        legacy_attempt_3 = {"session_id": "leg-3", "attempt_number": 3, "final_result": "PASS"}
        legacy_sup = {"session_id": "leg-sup", "supervisor_only": True, "final_result": "PASS"}

        self.assertTrue(server._is_session_certification_authorized(legacy_attempt_1))
        self.assertTrue(server._is_session_certification_authorized(legacy_attempt_2))
        self.assertTrue(server._is_session_certification_authorized(legacy_attempt_3))
        self.assertTrue(server._is_session_certification_authorized(legacy_sup))

        # Legacy attempt exceeding allowance without grants is NOT authorized
        legacy_attempt_4 = {"session_id": "leg-4", "attempt_number": 4, "allowed_attempt_count": 3}
        self.assertFalse(server._is_session_certification_authorized(legacy_attempt_4))

        # Unauthorized override attempt without authorization_status is NOT approved
        unauthorized_override = {
            "session_id": "unauth-override-1",
            "attempt_number": 4,
            "additional_attempt_overridden": True,
            "additional_attempt_override_reason": "Tester proceeded without approval",
        }
        self.assertFalse(server._is_session_certification_authorized(unauthorized_override))

    def test_safeguard2_pending_override_does_not_grant_candidate_pass(self):
        # Candidate failed 3 times, then has 4th session with PASS but pending authorization
        prior_fails = [
            {"session_id": f"cert-{i}", "attempt_number": i, "status": "Fail", "authorization_status": "not_required"}
            for i in range(1, 4)
        ]
        pending_pass = {
            "session_id": "cert-4-override",
            "attempt_number": 4,
            "status": "Pass",
            "final_result": "PASS",
            "additional_attempt_overridden": True,
            "additional_attempt_override_reason": "Emergency audio dropout",
            "authorization_status": "pending_admin_authorization",
        }
        state = server.calculate_candidate_attempt_state(prior_fails + [pending_pass])
        self.assertFalse(state["passed"], "Pending override must NOT mark candidate as passed")

        # Once approved by admin, candidate is certified
        approved_pass = dict(pending_pass, authorization_status="approved")
        state_approved = server.calculate_candidate_attempt_state(prior_fails + [approved_pass])
        self.assertTrue(state_approved["passed"], "Approved override must mark candidate as passed")

    # -------------------------------------------------------------------------
    # Safeguard 3: Offline Cancellation Safety & Activity Check
    # -------------------------------------------------------------------------
    def test_safeguard3_has_session_test_activity_detection(self):
        empty = {}
        draft = {"candidate_name": "Taylor", "mock_calls_completed": 0}
        self.assertFalse(server._has_session_test_activity(empty))
        self.assertFalse(server._has_session_test_activity(draft))

        call1_dict = {"call_1": {"result": "Pass"}}
        call1_str = {"call_1_result": "Fail"}
        call2_dict = {"call_2": {"status": "completed"}}
        sup_dict = {"sup_transfer_1": {"result": "Pass"}}
        count_calls = {"mock_calls_completed": 1}
        count_sups = {"sup_transfers_completed": 1}

        self.assertTrue(server._has_session_test_activity(call1_dict))
        self.assertTrue(server._has_session_test_activity(call1_str))
        self.assertTrue(server._has_session_test_activity(call2_dict))
        self.assertTrue(server._has_session_test_activity(sup_dict))
        self.assertTrue(server._has_session_test_activity(count_calls))
        self.assertTrue(server._has_session_test_activity(count_sups))

    def test_safeguard3_cancellation_preserves_active_session(self):
        active_session = {
            "session_id": "sess-active-1",
            "additional_attempt_overridden": True,
            "call_1": {"result": "Pass"},
        }
        res = server._cancel_additional_attempt_reservation("sess-active-1", active_session)
        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "SESSION_IN_PROGRESS")
        self.assertIn("has test activity", res["error"])

    def test_safeguard3_cancellation_allows_empty_draft(self):
        empty_draft = {
            "session_id": "sess-draft-1",
            "additional_attempt_overridden": True,
            "mock_calls_completed": 0,
        }
        res = server._cancel_additional_attempt_reservation("sess-draft-1", empty_draft)
        self.assertTrue(res["ok"])
        self.assertTrue(res.get("abandoned"))

    # -------------------------------------------------------------------------
    # Start-Time Reservation & Mandatory Reason Validation
    # -------------------------------------------------------------------------
    def test_start_policy_mandatory_reason_additional_attempt(self):
        state = server.calculate_candidate_attempt_state([
            {"session_id": f"cert-{i}", "attempt_number": i, "status": "Fail"}
            for i in range(1, 4)
        ])
        # Missing reason
        no_reason = server.apply_certification_start_policy(
            {"candidate_name": "Taylor", "additional_attempt_overridden": True},
            state,
        )
        self.assertFalse(no_reason["ok"])
        self.assertEqual(no_reason["error_code"], "REASON_REQUIRED")

        # Valid reason
        with_reason = server.apply_certification_start_policy(
            {
                "candidate_name": "Taylor",
                "additional_attempt_overridden": True,
                "additional_attempt_override_reason": "Extenuating medical circumstance verified by ops.",
            },
            state,
        )
        self.assertTrue(with_reason["ok"])
        self.assertEqual(with_reason["session"]["attempt_number"], 4)

    def test_start_policy_rejects_hardcoded_final_attempt_default(self):
        state = server.calculate_candidate_attempt_state([
            {"session_id": f"cert-{i}", "attempt_number": i, "status": "Fail"}
            for i in range(1, 3)
        ])
        # Candidate at attempt 3 of 3 (final_attempt=True)
        # Tester attempts to uncheck final attempt with old hardcoded default string
        hardcoded = server.apply_certification_start_policy(
            {
                "candidate_name": "Taylor",
                "final_attempt": False,
                "final_attempt_overridden": True,
                "final_attempt_override_reason": "Tester confirmed Final Attempt Yes to No override.",
            },
            state,
        )
        self.assertFalse(hardcoded["ok"])
        self.assertEqual(hardcoded["error_code"], "REASON_REQUIRED")

        # Genuine written reason accepted
        genuine = server.apply_certification_start_policy(
            {
                "candidate_name": "Taylor",
                "final_attempt": False,
                "final_attempt_overridden": True,
                "final_attempt_override_reason": "Candidate headset failed on call 2 of prior test, admin approved retry.",
            },
            state,
        )
        self.assertTrue(genuine["ok"])
        self.assertFalse(genuine["session"]["final_attempt"])
        self.assertTrue(genuine["session"]["final_attempt_overridden"])


    # -------------------------------------------------------------------------
    # Offline Emergency Reservation Reconciliation
    # -------------------------------------------------------------------------
    def test_reconciliation_preserves_session_id_and_validates_reason(self):
        # Missing reason fails reconciliation
        bad_session = {
            "session_id": "sess-offline-test-1",
            "candidate_name": "Test Candidate",
            "emergency_offline_override": True,
            "additional_attempt_overridden": True,
            "additional_attempt_override_reason": "",
        }
        res = server._reconcile_offline_emergency_reservation(bad_session)
        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "REASON_REQUIRED")

        # Non-offline session is a no-op
        regular_session = {
            "session_id": "sess-regular-1",
            "candidate_name": "Regular Candidate",
            "additional_attempt_overridden": False,
        }
        res_reg = server._reconcile_offline_emergency_reservation(regular_session)
        self.assertTrue(res_reg["ok"])
        self.assertFalse(res_reg["reconciled"])

    def test_reconciliation_handles_conflict_and_standard_resolution(self):
        class MockProvider:
            def __init__(self, mode="normal"):
                self.mode = mode

            def call_rpc(self, rpc_name, params):
                if rpc_name == "reserve_additional_attempt_session":
                    if self.mode == "conflict":
                        return {
                            "ok": True,
                            "conflict": True,
                            "reservation_id": "ov-conflict-uuid",
                            "attempt_number": 4,
                            "max_attempts": 3,
                            "authorization_status": "conflict",
                            "conflicting_reservation_id": "ov-existing-uuid",
                        }
                    return {
                        "ok": True,
                        "reservation_id": "ov-normal-uuid",
                        "attempt_number": 4,
                        "max_attempts": 3,
                        "authorization_status": "pending_admin_authorization",
                    }
                return {"ok": False, "error": "Unknown RPC"}

        orig_mode = server.configured_provider_mode
        orig_prov = server._get_active_data_provider
        try:
            server.configured_provider_mode = lambda: "supabase"

            # 1. Conflict scenario
            server._get_active_data_provider = lambda: MockProvider("conflict")
            conflict_session = {
                "session_id": "sess-offline-conf-1",
                "candidate_name": "Conflict Candidate",
                "emergency_offline_override": True,
                "additional_attempt_overridden": True,
                "additional_attempt_override_reason": "Emergency network glitch",
                "authorization_status": "local_pending_sync",
            }
            res_conf = server._reconcile_offline_emergency_reservation(conflict_session)
            self.assertTrue(res_conf["ok"])
            self.assertTrue(res_conf["conflict"])
            self.assertEqual(conflict_session["authorization_status"], "conflict")
            self.assertEqual(conflict_session["reservation_id"], "ov-conflict-uuid")

            # 2. Standard resolution scenario
            server._get_active_data_provider = lambda: MockProvider("normal")
            normal_session = {
                "session_id": "sess-offline-norm-1",
                "candidate_name": "Normal Candidate",
                "emergency_offline_override": True,
                "additional_attempt_overridden": True,
                "additional_attempt_override_reason": "Approved offline test",
                "authorization_status": "local_pending_sync",
            }
            res_norm = server._reconcile_offline_emergency_reservation(normal_session)
            self.assertTrue(res_norm["ok"])
            self.assertFalse(res_norm["conflict"])
            self.assertEqual(normal_session["authorization_status"], "pending_admin_authorization")
            self.assertEqual(normal_session["reservation_id"], "ov-normal-uuid")
        finally:
            server.configured_provider_mode = orig_mode
            server._get_active_data_provider = orig_prov

    def test_independent_sync_status_vs_authorization_status(self):
        # A session can be synced (sync_status='synced') while its authorization_status
        # remains 'pending_admin_authorization' or 'conflict'.
        # Safeguard 2 must ensure that positive clearance is NOT granted merely because sync_status='synced'.
        synced_pending = {
            "session_id": "sess-synced-pending",
            "attempt_number": 4,
            "status": "Pass",
            "final_result": "PASS",
            "sync_status": "synced",
            "authorization_status": "pending_admin_authorization",
            "additional_attempt_overridden": True,
        }
        self.assertFalse(server._is_session_certification_authorized(synced_pending))
        state = server.calculate_candidate_attempt_state([synced_pending])
        self.assertFalse(state["passed"], "Synced session with pending authorization must NOT certify")

        synced_conflict = {
            "session_id": "sess-synced-conflict",
            "attempt_number": 4,
            "status": "Pass",
            "final_result": "PASS",
            "sync_status": "synced",
            "authorization_status": "conflict",
            "additional_attempt_overridden": True,
        }
        self.assertFalse(server._is_session_certification_authorized(synced_conflict))
        state_conf = server.calculate_candidate_attempt_state([synced_conflict])
        self.assertFalse(state_conf["passed"], "Synced session with conflict status must NOT certify")

    # -------------------------------------------------------------------------
    # SAM Administrator Review & Decision Endpoints
    # -------------------------------------------------------------------------
    def test_admin_overrides_pending_list_and_in_progress_detection(self):
        # Active session without final result is detected as in-progress
        orig_active = server.db.sessions._read_document("active_session")
        try:
            test_active = {
                "_id": "active_session",
                "session_id": "sess-active-test-99",
                "candidate_name": "Test InProgress",
                "additional_attempt_overridden": True,
                "additional_attempt_override_reason": "Router failure",
                "authorization_status": "pending_admin_authorization",
                "mock_calls_completed": 1,
            }
            server.db.sessions._write_document(test_active)

            overrides = server._get_local_pending_overrides_list()
            matched = [ov for ov in overrides if ov["source_session_id"] == "sess-active-test-99"]
            self.assertEqual(len(matched), 1)
            ov = matched[0]
            self.assertTrue(ov["session"]["is_in_progress"])
            self.assertIsNone(ov["session"]["final_result"])
            self.assertEqual(ov["candidate_name"], "Test InProgress")
        finally:
            if orig_active:
                orig_active["_id"] = "active_session"
                server.db.sessions._write_document(orig_active)
            else:
                server.db.sessions.store.execute("DELETE FROM kv_documents WHERE collection = 'sessions' AND doc_id = 'active_session'", ())

    def test_admin_decide_override_blocks_when_session_in_progress(self):
        # Attempting to decide an in-progress session must be rejected with SESSION_IN_PROGRESS
        orig_active = server.db.sessions._read_document("active_session")
        try:
            test_active = {
                "_id": "active_session",
                "session_id": "sess-active-prog-88",
                "candidate_name": "Test Progress Blocking",
                "additional_attempt_overridden": True,
                "additional_attempt_override_reason": "Testing block",
                "authorization_status": "pending_admin_authorization",
            }
            server.db.sessions._write_document(test_active)

            res = server._decide_local_override("ov-sess-active-prog-88", "approved", "Admin approves early")
            self.assertFalse(res["ok"])
            self.assertEqual(res["error_code"], "SESSION_IN_PROGRESS")
            self.assertIn("Evaluation Not Yet Available", res["error"])
        finally:
            if orig_active:
                orig_active["_id"] = "active_session"
                server.db.sessions._write_document(orig_active)
            else:
                server.db.sessions.store.execute("DELETE FROM kv_documents WHERE collection = 'sessions' AND doc_id = 'active_session'", ())

    def test_admin_decide_override_approves_completed_session(self):
        # Completed session with final_result can be decided
        import json
        test_history_doc = {
            "session_id": "sess-hist-decide-1",
            "history_id": "hist-decide-1",
            "reservation_id": "ov-decide-1",
            "candidate_name": "Test Decided Candidate",
            "additional_attempt_overridden": True,
            "additional_attempt_override_reason": "Admin test",
            "authorization_status": "pending_admin_authorization",
            "final_result": "PASS",
            "status": "Pass",
        }
        server.db.history.store.execute(
            "INSERT INTO history_documents (data, timestamp) VALUES (?, ?)",
            (json.dumps(test_history_doc), "2026-09-21T02:00:00Z"),
        )
        row_id = server.db.history.store.fetchone("SELECT last_insert_rowid() as id", ())["id"]

        try:
            res = server._decide_local_override("ov-decide-1", "approved", "Ops verified issue")
            self.assertTrue(res["ok"])
            self.assertEqual(res["authorization_status"], "approved")
            self.assertTrue(res["certification_cleared"])

            # Verify persisted in SQLite
            updated_row = server.db.history.store.fetchone("SELECT data FROM history_documents WHERE id = ?", (row_id,))
            updated_doc = json.loads(updated_row["data"])
            self.assertEqual(updated_doc["authorization_status"], "approved")
            self.assertEqual(updated_doc["decision"], "approved")
        finally:
            server.db.history.store.execute("DELETE FROM history_documents WHERE id = ?", (row_id,))

    def test_admin_override_endpoints_and_jwt_requirement(self):
        from fastapi.testclient import TestClient
        client = TestClient(server.app)

        from unittest.mock import patch
        headers = {"X-MTS-Admin-Token": "test-admin-token"}

        with patch.dict(server.os.environ, {"MTS_ADMIN_TOKEN": "test-admin-token"}):
            # Missing admin token rejected (403 Forbidden)
            res_no_token = client.get("/api/shared/admin/overrides/pending")
            self.assertEqual(res_no_token.status_code, 403)

            # Valid admin token accepted
            res_with_token = client.get("/api/shared/admin/overrides/pending", headers=headers)
            self.assertEqual(res_with_token.status_code, 200)
            self.assertIsInstance(res_with_token.json(), list)

            # 2. POST /api/shared/admin/overrides/decide
            # Missing admin token rejected (403 Forbidden)
            res_decide_no_token = client.post("/api/shared/admin/overrides/decide", json={"override_id": "test", "decision": "approved"})
            self.assertEqual(res_decide_no_token.status_code, 403)

            # In Supabase mode, static token alone without JWT must be rejected with 401
            orig_mode = server.configured_provider_mode
            try:
                server.configured_provider_mode = lambda: "supabase"
                res_no_jwt = client.post(
                    "/api/shared/admin/overrides/decide",
                    json={"override_id": "test", "decision": "approved"},
                    headers=headers,
                )
                self.assertEqual(res_no_jwt.status_code, 401)
                self.assertIn("Authenticated SAM administrator session required", res_no_jwt.json().get("detail", ""))

                # Same for resolve-conflict
                res_conflict_no_jwt = client.post(
                    "/api/shared/admin/overrides/resolve-conflict",
                    json={"conflict_override_id": "test", "decision": "approved"},
                    headers=headers,
                )
                self.assertEqual(res_conflict_no_jwt.status_code, 401)
                self.assertIn("Authenticated SAM administrator session required", res_conflict_no_jwt.json().get("detail", ""))
            finally:
                server.configured_provider_mode = orig_mode

    def test_decide_rpc_sql_security_specifications(self):
        migration = (
            Path(__file__).resolve().parents[1]
            / "supabase/migrations/20260921000000_mts_additional_attempt_overrides.sql"
        ).read_text(encoding="utf-8")

        # decide_additional_attempt_override security checks
        self.assertIn("v_jwt_caller_uid := coalesce(", migration)
        self.assertIn("request.jwt.claim.sub", migration)
        self.assertIn("'UNAUTHENTICATED'", migration)
        self.assertIn("'CALLER_IDENTITY_MISMATCH'", migration)
        self.assertIn("'INACTIVE_CALLER'", migration)
        self.assertIn("'ADMINISTRATOR_REQUIRED'", migration)
        self.assertIn("grant execute on function mts_sam.decide_additional_attempt_override", migration)
        self.assertIn("to authenticated;", migration)
        self.assertIn("revoke all on function mts_sam.decide_additional_attempt_override", migration)

        # resolve_offline_override_conflict security checks
        self.assertIn("grant execute on function mts_sam.resolve_offline_override_conflict", migration)
        self.assertIn("revoke all on function mts_sam.resolve_offline_override_conflict", migration)

        # In-progress evaluation guard in both RPCs
        self.assertIn("'SESSION_IN_PROGRESS'", migration)
        self.assertIn("Evaluation Not Yet Available", migration)


if __name__ == "__main__":
    unittest.main()

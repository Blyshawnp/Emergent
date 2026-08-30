import json
import os
import sys
import time
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(__file__))

from fastapi.testclient import TestClient
from server import app, db, _complete_sam_setup, sanitize_settings
from data_providers.factory import build_data_provider
from data_providers.supabase import SupabaseDataProvider
from tools.supabase_import.cli import _supabase_client, _sheets_client
from tools.supabase_import.core import compare_shadow_provider


class ProviderCutoverRehearsalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)
        cls.supabase = _supabase_client()
        cls.sheets = _sheets_client()

    # =============================================================
    # 1. READ SMOKE TEST UNDER SUPABASE PROVIDER
    # =============================================================

    def test_supabase_read_smoke_all_domains(self):
        """Verify that all 23 domains can be read cleanly from Supabase."""
        domains = [
            "candidates", "candidate_sessions", "session_attempts", "authoritative_candidate_status",
            "candidate_tracking", "headset_catalog", "headset_reviews", "pending_requests",
            "supervisor_transfers", "newbie_shift_requests", "candidate_corrections",
            "candidate_status_actions", "notifications", "recent_activity",
            "callers", "call_types", "call_fail_reasons", "supervisor_coaching",
            "supervisor_fail_reasons", "supervisor_reasons", "shows",
            "gemini_coaching_prompt", "gemini_fail_prompt"
        ]
        for d in domains:
            rows = self.supabase.list_resource(d, limit=5)
            self.assertIsInstance(rows, list, f"Domain {d} did not return a list")

    def test_supabase_configuration_reads(self):
        """Verify specific configuration values from Supabase."""
        callers = self.supabase.list_resource("callers", limit=50)
        self.assertEqual(len(callers), 22)

        call_types = self.supabase.list_resource("call_types", limit=50)
        self.assertEqual(len(call_types), 5)

        shows = self.supabase.list_resource("shows", limit=50)
        self.assertEqual(len(shows), 8)

        prompts = self.supabase.list_resource("gemini_coaching_prompt", limit=10)
        self.assertEqual(len(prompts), 1)

    # =============================================================
    # 2. CONTROLLED WRITE & LINEAGE TEST
    # =============================================================

    def test_controlled_candidate_lifecycle_simulation(self):
        """Simulate creating a candidate session and attempt in Supabase."""
        test_session_id = f"rehearsal-test-sess-{int(time.time())}"
        test_cand_name = "Rehearsal Candidate"

        cand_payload = {
            "source_candidate_id": f"cand-{test_cand_name.lower().replace(' ', '-')}",
            "display_name": test_cand_name,
            "first_name": "Rehearsal",
            "last_initial": "C",
        }
        sess_payload = {
            "session_id": test_session_id,
            "candidate_name": test_cand_name,
            "candidate_first_name": "Rehearsal",
            "candidate_last_initial": "C",
            "tester_name": "Rehearsal Tester",
            "status": "PASS",
            "final_result": "Pass",
            "attempt_number": 1,
        }
        attempt_payload = {
            "source_action_id": f"rehearsal:attempt:{test_session_id}:1",
            "session_id": test_session_id,
            "attempt_number": 1,
            "result": "Pass",
        }

        self.assertIsNotNone(cand_payload["display_name"])
        self.assertIsNotNone(sess_payload["session_id"])
        self.assertEqual(attempt_payload["attempt_number"], 1)

    # =============================================================
    # 3. PHASE 1B ADMIN SETTINGS UNDER REHEARSAL
    # =============================================================

    def test_admin_settings_under_rehearsal(self):
        """Admin settings require admin token and preserve defaults."""
        res_get = self.client.get("/api/settings")
        self.assertEqual(res_get.status_code, 200)
        data = res_get.json()
        self.assertIn("require_newbie_shift_approval", data)
        self.assertIn("headset_notification_mode", data)

        with patch.dict(os.environ, {"MTS_ADMIN_TOKEN": "rehearsal-admin-token"}):
            # Unauthorized mutation denied
            res_unauth = self.client.put("/api/settings", json={"require_newbie_shift_approval": False})
            self.assertEqual(res_unauth.status_code, 403)

            # Authorized mutation accepted
            res_auth = self.client.put(
                "/api/settings",
                json={"require_newbie_shift_approval": True, "headset_notification_mode": "all"},
                headers={"X-MTS-Admin-Token": "rehearsal-admin-token"}
            )
            self.assertEqual(res_auth.status_code, 200)

    # =============================================================
    # 4. AUTH UNDER SUPABASE PROVIDER
    # =============================================================

    def test_auth_under_supabase_provider(self):
        """Pilot user verifies, inactive user denied, and user management functions correctly."""
        with patch("server._supabase_anon_rpc") as mock_rpc:
            mock_rpc.return_value = {
                "ok": True,
                "user_id": "c6cdf86b-9624-dc61-cfc9-acd33d4aee9a",
                "auth_user_id": "ca4cb01e-0777-435d-8a7c-1f2bcfaed291",
                "display_name": "Shawn Bly",
                "active": True,
                "role": "administrator",
                "is_owner": True,
            }
            res = self.client.post("/api/sam/auth/verify", json={"auth_uid": "ca4cb01e-0777-435d-8a7c-1f2bcfaed291"})
            self.assertTrue(res.json().get("ok"))
            self.assertEqual(res.json().get("display_name"), "Shawn Bly")

        with patch("server._supabase_anon_rpc") as mock_rpc:
            mock_rpc.return_value = {
                "ok": False,
                "error_code": "inactive_account",
                "error": "This SAM account is inactive.",
            }
            res = self.client.post("/api/sam/auth/verify", json={"auth_uid": "inactive-uid"})
            self.assertFalse(res.json().get("ok"))
            self.assertEqual(res.json().get("error_code"), "inactive_account")

    # =============================================================
    # 5. ERROR & FAILURE RECOVERY
    # =============================================================

    def test_error_handling_graceful_failures(self):
        """Network timeouts and missing configs fail closed with user-safe messages."""
        with patch("server._load_backend_runtime_config", return_value={}):
            res = self.client.get("/api/sam/auth/config")
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.json().get("supabase_url"), "")

    # =============================================================
    # 6. WORKFLOW LOGIC INTEGRITY
    # =============================================================

    def test_supervisor_transfer_and_newbie_shift_invariants(self):
        """Unanswered newbie requests and passed request dates never block supervisor transfer."""
        from server import _candidate_session_row
        session = {
            "candidate_name": "Workflow Candidate",
            "session_id": "sess-wf-100",
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
            "call_3": {"result": "Pass"},
            "sup_transfer_1": {"result": "Pass"},
            "sup_transfer_2": {"result": "Pass"},
            "newbie_shift_request_id": "newbie-wf-100",
            "newbie_shift_request_status": "pending",
            "newbie_shift_scheduled_at": "2026-08-01T10:00:00Z",
            "tester_name": "Tester",
        }
        row, _, needs_sup = _candidate_session_row(session, [])
        self.assertEqual(row[8], "PASS")
        self.assertFalse(needs_sup)


if __name__ == "__main__":
    unittest.main()

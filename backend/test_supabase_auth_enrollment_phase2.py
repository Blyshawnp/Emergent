import os
import sys
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.dirname(__file__))

from fastapi.testclient import TestClient

from server import (
    app,
    db,
    _complete_sam_setup,
    _sam_setup_status,
    _supabase_anon_rpc,
)


class SupabaseAuthEnrollmentPhase2Tests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)

    # =============================================================
    # 1. PILOT USER LINKAGE & VERIFICATION
    # =============================================================

    def test_pilot_user_linkage_and_role_verification(self):
        """Pilot user Shawn Bly is linked to Auth UID ca4cb01e-0777-435d-8a7c-1f2bcfaed291 and active."""
        with patch("server._supabase_anon_rpc") as mock_rpc:
            mock_rpc.return_value = {
                "ok": True,
                "user_id": "c6cdf86b-9624-dc61-cfc9-acd33d4aee9a",
                "auth_user_id": "ca4cb01e-0777-435d-8a7c-1f2bcfaed291",
                "display_name": "Shawn Bly",
                "active": True,
                "role": "administrator",
                "source_role": "owner",
                "is_owner": True,
            }
            res = self.client.post("/api/sam/auth/verify", json={"auth_uid": "ca4cb01e-0777-435d-8a7c-1f2bcfaed291"})
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertTrue(data.get("ok"))
            self.assertEqual(data.get("display_name"), "Shawn Bly")
            self.assertEqual(data.get("role"), "administrator")
            self.assertTrue(data.get("active"))
            self.assertTrue(data.get("is_owner"))

    # =============================================================
    # 2. INACTIVE USER ACCESS DENIAL
    # =============================================================

    def test_inactive_user_auth_verification_denied(self):
        """Inactive user attempting Supabase Auth verification must be rejected."""
        with patch("server._supabase_anon_rpc") as mock_rpc:
            mock_rpc.return_value = {
                "ok": False,
                "error_code": "inactive_account",
                "error": "This SAM account is inactive.",
            }
            res = self.client.post("/api/sam/auth/verify", json={"auth_uid": "some-inactive-uid"})
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertFalse(data.get("ok"))
            self.assertEqual(data.get("error_code"), "inactive_account")

    def test_inactive_user_legacy_pin_fallback_denied(self):
        """Inactive user attempting legacy PIN fallback must be rejected."""
        mock_service = MagicMock()
        mock_sheets = MagicMock()
        mock_service.spreadsheets.return_value = mock_sheets
        with patch("server._sam_master_sheet_context", return_value={"ok": True, "service": mock_service, "sheet_id": "mock_sheet", "appsScriptClient": None}),              patch("server._read_sam_authorized_users", return_value=(
                 {"ok": True},
                 [
                     {"name": "Ashley Shealey", "pin": "1234", "enabled": "FALSE", "role": "admin", "_row_number": 2},
                     {"name": "Shawn Bly", "pin": "9999", "enabled": "TRUE", "role": "owner", "_row_number": 3},
                 ]
             )),              patch("server._shared_update_existing_row"):
            res_inactive = _complete_sam_setup({"name": "Ashley Shealey", "pin": "1234", "device_name": "TestPC"})
            self.assertFalse(res_inactive.get("ok"))
            self.assertEqual(res_inactive.get("errorCode"), "setup_authorization_failed")

            res_active = _complete_sam_setup({"name": "Shawn Bly", "pin": "9999", "device_name": "TestPC"})
            self.assertTrue(res_active.get("ok"))
            self.assertEqual(res_active.get("name"), "Shawn Bly")

    def test_unknown_user_legacy_pin_fallback_denied(self):
        """Unknown user attempting legacy PIN fallback must be rejected."""
        mock_service = MagicMock()
        mock_sheets = MagicMock()
        mock_service.spreadsheets.return_value = mock_sheets
        with patch("server._sam_master_sheet_context", return_value={"ok": True, "service": mock_service, "sheet_id": "mock_sheet", "appsScriptClient": None}),              patch("server._read_sam_authorized_users", return_value=(
                 {"ok": True},
                 [{"name": "Shawn Bly", "pin": "9999", "enabled": "TRUE", "role": "owner", "_row_number": 2}]
             )):
            res = _complete_sam_setup({"name": "Unknown Admin", "pin": "9999", "device_name": "TestPC"})
            self.assertFalse(res.get("ok"))
            self.assertEqual(res.get("errorCode"), "setup_admin_not_found")

    def test_wrong_pin_legacy_fallback_denied(self):
        """Wrong PIN attempting legacy fallback must be rejected."""
        mock_service = MagicMock()
        mock_sheets = MagicMock()
        mock_service.spreadsheets.return_value = mock_sheets
        with patch("server._sam_master_sheet_context", return_value={"ok": True, "service": mock_service, "sheet_id": "mock_sheet", "appsScriptClient": None}),              patch("server._read_sam_authorized_users", return_value=(
                 {"ok": True},
                 [{"name": "Shawn Bly", "pin": "9999", "enabled": "TRUE", "role": "owner", "_row_number": 2}]
             )):
            res = _complete_sam_setup({"name": "Shawn Bly", "pin": "0000", "device_name": "TestPC"})
            self.assertFalse(res.get("ok"))
            self.assertEqual(res.get("errorCode"), "setup_invalid_pin")

    # =============================================================
    # 3. USER MANAGEMENT ENFORCEMENT
    # =============================================================

    def test_user_management_list_requires_caller_uid(self):
        """User management list without caller UID is rejected."""
        res = self.client.post("/api/sam/admin/users/list", json={})
        self.assertEqual(res.status_code, 200)
        self.assertFalse(res.json().get("ok"))
        self.assertEqual(res.json().get("error"), "Unauthorized")

    def test_user_management_set_active_requires_both_ids(self):
        """Set-active requires both caller_auth_uid and target_user_id."""
        res = self.client.post("/api/sam/admin/users/set-active", json={"caller_auth_uid": "uid-1"})
        self.assertEqual(res.status_code, 200)
        self.assertFalse(res.json().get("ok"))
        self.assertIn("required", res.json().get("error", "").lower())

    # =============================================================
    # 4. PHASE 1B ADMIN CONTROLS PERMISSION RE-VERIFICATION
    # =============================================================

    def test_admin_settings_mutation_requires_admin_token(self):
        """Admin settings endpoint requires admin authorization; non-admin receives HTTP 403."""
        with patch.dict(os.environ, {"MTS_ADMIN_TOKEN": "super-secret-admin-token"}):
            # Unauthorized request
            res_unauth = self.client.put("/api/settings", json={"require_newbie_shift_approval": False})
            self.assertEqual(res_unauth.status_code, 403)

            # Authorized request
            res_auth = self.client.put(
                "/api/settings",
                json={"require_newbie_shift_approval": False},
                headers={"X-MTS-Admin-Token": "super-secret-admin-token"}
            )
            self.assertEqual(res_auth.status_code, 200)


if __name__ == "__main__":
    unittest.main()

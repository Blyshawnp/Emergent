"""
Unit tests for SAM secure user enrollment and management endpoints.
Tests JWT-derived caller authorization, update without email dispatch,
enrollment RPC integration, and password recovery triggering.
"""
import json
import os
import sys
import unittest
from unittest.mock import patch, MagicMock
import urllib.request
import urllib.error

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BACKEND_DIR = os.path.join(REPO_ROOT, "backend")
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import server


class SamUserEnrollmentEndpointTests(unittest.TestCase):
    def setUp(self):
        self.mock_config = {
            "supabase_url": "https://xyfhikikddcqcmzbdvbj.supabase.co",
            "supabase_anon_key": "test-anon-key-12345",
        }

    @patch("server._load_backend_runtime_config")
    @patch("urllib.request.urlopen")
    def test_supabase_anon_rpc_with_jwt_passes_bearer_authorization(self, mock_urlopen, mock_cfg):
        mock_cfg.return_value = self.mock_config
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"ok": True, "users": []}).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        jwt_token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.testjwt"
        res = server._supabase_anon_rpc(
            "get_sam_user_management_list",
            {"p_caller_auth_uid": "test-uid"},
            auth_jwt=jwt_token,
        )
        self.assertTrue(res.get("ok"))

        req = mock_urlopen.call_args[0][0]
        self.assertEqual(req.get_header("Apikey"), "test-anon-key-12345")
        self.assertEqual(req.get_header("Authorization"), f"Bearer {jwt_token}")
        self.assertEqual(req.get_header("Content-profile"), "mts_sam")
        self.assertEqual(req.get_header("Accept-profile"), "mts_sam")

    @patch("server._supabase_anon_rpc")
    def test_post_sam_admin_users_list_requires_auth(self, mock_rpc):
        req = MagicMock()
        req.headers = {}
        import asyncio

        res = asyncio.run(server.post_sam_admin_users_list({}, req))
        self.assertFalse(res.get("ok"))
        self.assertEqual(res.get("error"), "Unauthorized")
        mock_rpc.assert_not_called()

    @patch("server._supabase_anon_rpc")
    def test_post_sam_admin_users_update_requires_target_user_id(self, mock_rpc):
        req = MagicMock()
        req.headers = {"Authorization": "Bearer test-jwt"}
        import asyncio

        res = asyncio.run(server.post_sam_admin_users_update({}, req))
        self.assertFalse(res.get("ok"))
        self.assertIn("Target user ID is required", res.get("error", ""))
        mock_rpc.assert_not_called()

    @patch("server._supabase_anon_rpc")
    def test_post_sam_admin_users_update_invokes_rpc_without_sending_email(self, mock_rpc):
        mock_rpc.return_value = {"ok": True, "updated": True}
        req = MagicMock()
        req.headers = {"Authorization": "Bearer test-jwt"}
        import asyncio

        payload = {
            "target_user_id": "3b6adb57-c87d-bd76-f5de-da6a177b8226",
            "email": "ashley@example.com",
            "role": "administrator",
            "active": True,
        }
        res = asyncio.run(server.post_sam_admin_users_update(payload, req))
        self.assertTrue(res.get("ok"))
        mock_rpc.assert_called_once_with(
            "update_sam_user",
            {
                "p_target_user_id": "3b6adb57-c87d-bd76-f5de-da6a177b8226",
                "p_email": "ashley@example.com",
                "p_role": "administrator",
                "p_active": True,
            },
            "test-jwt",
        )

    @patch("server._supabase_anon_rpc")
    def test_post_sam_admin_users_enroll_invokes_enroll_rpc(self, mock_rpc):
        mock_rpc.return_value = {"ok": True, "enrollment_status": "Active / Setup Sent"}
        req = MagicMock()
        req.headers = {"Authorization": "Bearer test-jwt"}
        import asyncio

        payload = {
            "target_user_id": "3b6adb57-c87d-bd76-f5de-da6a177b8226",
        }
        res = asyncio.run(server.post_sam_admin_users_enroll(payload, req))
        self.assertTrue(res.get("ok"))
        mock_rpc.assert_called_once_with(
            "enroll_sam_user",
            {
                "p_target_user_id": "3b6adb57-c87d-bd76-f5de-da6a177b8226",
            },
            "test-jwt",
        )

    @patch("server._load_backend_runtime_config")
    @patch("urllib.request.urlopen")
    def test_post_sam_admin_users_send_reset_calls_gotrue_recover(self, mock_urlopen, mock_cfg):
        mock_cfg.return_value = self.mock_config
        mock_resp = MagicMock()
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        req = MagicMock()
        import asyncio

        payload = {"email": "ashley@example.com"}
        res = asyncio.run(server.post_sam_admin_users_send_reset(payload, req))
        self.assertTrue(res.get("ok"))
        self.assertIn("Password reset instructions sent", res.get("message", ""))

        called_req = mock_urlopen.call_args[0][0]
        self.assertIn("/auth/v1/recover?redirect_to=smartalertmanager://reset-password", called_req.full_url)
        self.assertEqual(called_req.get_header("Apikey"), "test-anon-key-12345")
        posted_data = json.loads(called_req.data.decode("utf-8"))
        self.assertEqual(posted_data.get("email"), "ashley@example.com")

    @patch("server._load_backend_runtime_config")
    def test_post_sam_admin_users_send_reset_rejects_empty_email(self, mock_cfg):
        mock_cfg.return_value = self.mock_config
        req = MagicMock()
        import asyncio

        res = asyncio.run(server.post_sam_admin_users_send_reset({}, req))
        self.assertFalse(res.get("ok"))
        self.assertIn("email address is required", res.get("error", ""))


if __name__ == "__main__":
    unittest.main()

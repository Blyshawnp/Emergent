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

    @patch("server._call_supabase_edge_function")
    def test_post_sam_admin_users_enroll_invokes_edge_function(self, mock_edge_fn):
        mock_edge_fn.return_value = {
            "ok": True,
            "status": "created_and_invited",
            "message": "New authentication account created and setup invitation email sent.",
        }
        req = MagicMock()
        req.headers = {"Authorization": "Bearer test-jwt"}
        import asyncio

        payload = {
            "target_user_id": "3b6adb57-c87d-bd76-f5de-da6a177b8226",
            "caller_auth_uid": "ca4cb01e-0777-435d-8a7c-1f2bcfaed291",
        }
        res = asyncio.run(server.post_sam_admin_users_enroll(payload, req))
        self.assertTrue(res.get("ok"))
        mock_edge_fn.assert_called_once_with(
            "sam-admin-enroll-user",
            {
                "target_user_id": "3b6adb57-c87d-bd76-f5de-da6a177b8226",
                "caller_auth_uid": "ca4cb01e-0777-435d-8a7c-1f2bcfaed291",
            },
            "test-jwt",
        )

    def test_post_sam_admin_users_enroll_requires_auth_jwt(self):
        req = MagicMock()
        req.headers = {}
        import asyncio

        payload = {
            "target_user_id": "3b6adb57-c87d-bd76-f5de-da6a177b8226",
            "caller_auth_uid": "ca4cb01e-0777-435d-8a7c-1f2bcfaed291",
        }
        res = asyncio.run(server.post_sam_admin_users_enroll(payload, req))
        self.assertFalse(res.get("ok"))
        self.assertIn("Caller authentication token is required", res.get("error", ""))

    @patch("server._load_backend_runtime_config")
    @patch("urllib.request.urlopen")
    def test_call_supabase_edge_function_passes_bearer_and_apikey(self, mock_urlopen, mock_cfg):
        mock_cfg.return_value = self.mock_config
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps({"ok": True, "status": "created_and_invited"}).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        res = server._call_supabase_edge_function(
            "sam-admin-enroll-user",
            {"target_user_id": "test-target-id"},
            auth_jwt="admin-jwt-token-xyz",
        )
        self.assertTrue(res.get("ok"))
        called_req = mock_urlopen.call_args[0][0]
        self.assertIn("/functions/v1/sam-admin-enroll-user", called_req.full_url)
        self.assertEqual(called_req.get_header("Apikey"), "test-anon-key-12345")
        self.assertEqual(called_req.get_header("Authorization"), "Bearer admin-jwt-token-xyz")
        self.assertEqual(called_req.get_header("Content-type"), "application/json")

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

    @patch("server._call_supabase_edge_function")
    def test_post_sam_admin_users_enroll_propagates_caller_mismatch(self, mock_edge_fn):
        mock_edge_fn.return_value = {
            "ok": False,
            "error_code": "CALLER_IDENTITY_MISMATCH",
            "error": "Client-supplied caller UID does not match verified JWT identity.",
        }
        req = MagicMock()
        req.headers = {"Authorization": "Bearer non-admin-jwt"}
        import asyncio

        payload = {
            "target_user_id": "3b6adb57-c87d-bd76-f5de-da6a177b8226",
            "caller_auth_uid": "spoofed-owner-uid",
        }
        res = asyncio.run(server.post_sam_admin_users_enroll(payload, req))
        self.assertFalse(res.get("ok"))
        self.assertEqual(res.get("error_code"), "CALLER_IDENTITY_MISMATCH")

    @patch("server._supabase_anon_rpc")
    def test_post_sam_admin_users_list_relays_jwt(self, mock_rpc):
        mock_rpc.return_value = {"ok": True, "users": []}
        req = MagicMock()
        req.headers = {"Authorization": "Bearer admin-jwt-123"}
        import asyncio

        res = asyncio.run(server.post_sam_admin_users_list({}, req))
        self.assertTrue(res.get("ok"))
        mock_rpc.assert_called_once_with("get_sam_user_management_list", {}, "admin-jwt-123")

    @patch("server._supabase_anon_rpc")
    def test_post_sam_admin_users_set_active_relays_jwt(self, mock_rpc):
        mock_rpc.return_value = {"ok": True, "active": True}
        req = MagicMock()
        req.headers = {"Authorization": "Bearer admin-jwt-123"}
        import asyncio

        payload = {
            "target_user_id": "3b6adb57-c87d-bd76-f5de-da6a177b8226",
            "active": True,
        }
        res = asyncio.run(server.post_sam_admin_users_set_active(payload, req))
        self.assertTrue(res.get("ok"))
        mock_rpc.assert_called_once_with(
            "set_sam_user_active",
            {"p_target_user_id": "3b6adb57-c87d-bd76-f5de-da6a177b8226", "p_active": True},
            "admin-jwt-123",
        )


if __name__ == "__main__":
    unittest.main()

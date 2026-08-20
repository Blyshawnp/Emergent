"""
Tests for SAM Supabase Auth RPC helper and endpoints in server.py
"""
import json
import unittest
from unittest.mock import patch, MagicMock
import urllib.request

import server

class SupabaseAuthRpcTests(unittest.TestCase):
    @patch("server._load_backend_runtime_config")
    @patch("urllib.request.urlopen")
    def test_supabase_anon_rpc_constructs_urllib_request_with_correct_headers(self, mock_urlopen, mock_config):
        mock_config.return_value = {
            "supabase_url": "https://xyfhikikddcqcmzbdvbj.supabase.co",
            "supabase_anon_key": "test-anon-key-12345",
        }
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({"ok": True, "role": "administrator"}).encode("utf-8")
        mock_response.__enter__.return_value = mock_response
        mock_urlopen.return_value = mock_response

        res = server._supabase_anon_rpc("verify_sam_authorization", {"p_auth_uid": "test-uid-123"})
        self.assertTrue(res.get("ok"))
        self.assertEqual(res.get("role"), "administrator")

        # Verify urllib.request.Request was passed to urlopen
        call_args = mock_urlopen.call_args
        req = call_args[0][0]
        self.assertIsInstance(req, urllib.request.Request)
        self.assertEqual(req.get_header("Content-profile"), "mts_sam")
        self.assertEqual(req.get_header("Accept-profile"), "mts_sam")
        self.assertEqual(req.get_header("Apikey"), "test-anon-key-12345")
        self.assertEqual(req.get_header("Authorization"), "Bearer test-anon-key-12345")

    @patch("server._load_backend_runtime_config")
    def test_supabase_anon_rpc_missing_config(self, mock_config):
        mock_config.return_value = {}
        res = server._supabase_anon_rpc("verify_sam_authorization")
        self.assertFalse(res.get("ok"))
        self.assertIn("not available", res.get("error", ""))

if __name__ == "__main__":
    unittest.main()

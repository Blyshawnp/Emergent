import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402


class SamSetupTests(unittest.TestCase):
    def apps_context(self, client):
        return {
            "ok": True,
            "service": None,
            "appsScriptClient": client,
            "sheet_id": "",
            "transport": "apps_script",
        }

    def test_production_context_uses_sam_apps_script_without_direct_sheets(self):
        client = mock.Mock()
        with mock.patch("services.apps_script_api.create_apps_script_sheet_service", return_value={"ok": True, "client": client}), \
                mock.patch("server._get_shared_tracking_sheet_service") as direct, \
                mock.patch.dict(os.environ, {"MTS_DEV_MODE": "false", "APP_ENV": "production"}, clear=False):
            result = server._sam_master_sheet_context()

        self.assertTrue(result["ok"])
        self.assertIs(result["appsScriptClient"], client)
        self.assertIsNone(result["service"])
        self.assertEqual(result["transport"], "apps_script")
        direct.assert_not_called()

    def test_production_does_not_fall_back_to_service_account(self):
        with mock.patch("services.apps_script_api.create_apps_script_sheet_service", return_value={"ok": False}), \
                mock.patch("server._get_shared_tracking_sheet_service") as direct, \
                mock.patch.dict(os.environ, {"MTS_DEV_MODE": "false", "APP_ENV": "production"}, clear=False):
            result = server._sam_master_sheet_context()

        self.assertFalse(result["ok"])
        self.assertEqual(result["errorCode"], "setup_configuration_unavailable")
        direct.assert_not_called()

    def test_development_can_use_direct_sheets_fallback(self):
        service = mock.Mock()
        with mock.patch("services.apps_script_api.create_apps_script_sheet_service", return_value={"ok": False}), \
                mock.patch("server._get_shared_tracking_sheet_service", return_value={"ok": True, "service": service, "sheet_id": "sheet"}), \
                mock.patch.dict(os.environ, {"MTS_DEV_MODE": "true"}, clear=False):
            result = server._sam_master_sheet_context()

        self.assertTrue(result["ok"])
        self.assertIs(result["service"], service)
        self.assertEqual(result["transport"], "direct_sheets_development")

    def test_setup_status_uses_role_specific_apps_script_action(self):
        client = mock.Mock()
        client.get.return_value = {"ok": True, "configured": True}
        with mock.patch("server._sam_master_sheet_context", return_value=self.apps_context(client)):
            result = server._sam_setup_status()

        self.assertEqual(result, {"ok": True, "configured": True, "errorCode": "", "error": ""})
        client.get.assert_called_once_with("getSamSetupStatus")

    def test_valid_setup_posts_to_apps_script_and_normalizes_identity(self):
        client = mock.Mock()
        client.post.return_value = {"ok": True, "name": "  Admin Example  ", "role": "owner", "alreadyInstalled": False}
        with mock.patch("server._sam_master_sheet_context", return_value=self.apps_context(client)):
            result = server._complete_sam_setup({"name": " Admin   Example ", "pin": "1234", "device_name": "Desk PC"})

        self.assertEqual(result, {"ok": True, "name": "Admin Example", "role": "owner"})
        client.post.assert_called_once_with("completeSamSetup", {
            "name": "Admin Example",
            "pin": "1234",
            "device_name": "Desk PC",
        })

    def test_expected_rejections_keep_stable_codes_and_generic_credentials_copy(self):
        cases = (
            ("setup_admin_not_found", "The administrator name or PIN was not recognized."),
            ("setup_invalid_pin", "The administrator name or PIN was not recognized."),
            ("setup_authorization_failed", "SAM could not verify setup authorization. Contact support if this continues."),
        )
        for code, message in cases:
            with self.subTest(code=code):
                client = mock.Mock()
                client.post.return_value = {"ok": False, "errorCode": code, "error": "sensitive remote detail"}
                with mock.patch("server._sam_master_sheet_context", return_value=self.apps_context(client)):
                    result = server._complete_sam_setup({"name": "Admin", "pin": "1234"})
                self.assertEqual(result["errorCode"], code)
                self.assertEqual(result["error"], message)
                self.assertNotIn("sensitive", result["error"])

    def test_malformed_and_transport_failures_never_expose_raw_exceptions(self):
        client = mock.Mock()
        for response, expected in (([], "setup_response_invalid"), ({"name": "Admin"}, "setup_response_invalid")):
            client.post.return_value = response
            with mock.patch("server._sam_master_sheet_context", return_value=self.apps_context(client)):
                result = server._complete_sam_setup({"name": "Admin", "pin": "1234"})
            self.assertEqual(result["errorCode"], expected)

        client.post.side_effect = RuntimeError("'NoneType' object has no attribute 'spreadsheets' secret-sheet")
        with mock.patch("server._sam_master_sheet_context", return_value=self.apps_context(client)):
            result = server._complete_sam_setup({"name": "Admin", "pin": "1234"})
        self.assertEqual(result["errorCode"], "setup_transport_unavailable")
        self.assertNotIn("NoneType", result["error"])
        self.assertNotIn("spreadsheets", result["error"])

    def test_transient_failure_can_retry_with_the_same_credentials(self):
        client = mock.Mock()
        client.post.side_effect = [
            TimeoutError("temporary transport timeout"),
            {"ok": True, "name": "Admin", "role": "owner", "alreadyInstalled": False},
        ]
        with mock.patch("server._sam_master_sheet_context", return_value=self.apps_context(client)):
            first = server._complete_sam_setup({"name": "Admin", "pin": "1234"})
            second = server._complete_sam_setup({"name": "Admin", "pin": "1234"})

        self.assertEqual(first["errorCode"], "setup_transport_unavailable")
        self.assertEqual(second, {"ok": True, "name": "Admin", "role": "owner"})
        self.assertEqual(client.post.call_count, 2)

    def test_failed_remote_validation_never_marks_local_setup_complete(self):
        rejected = server._sam_setup_error("setup_invalid_pin")
        with mock.patch("server._complete_sam_setup", return_value=rejected), \
                mock.patch.object(server.db.settings, "update_one", new=mock.AsyncMock()) as persist:
            result = asyncio.run(server.post_sam_setup_complete({"name": "Admin", "pin": "0000"}))

        self.assertEqual(result["errorCode"], "setup_invalid_pin")
        persist.assert_not_awaited()

    def test_local_persistence_failure_returns_retryable_safe_error(self):
        verified = {"ok": True, "name": "Admin", "role": "owner"}
        with mock.patch("server._complete_sam_setup", return_value=verified), \
                mock.patch.object(server.db.settings, "update_one", new=mock.AsyncMock(side_effect=OSError("private path"))):
            result = asyncio.run(server.post_sam_setup_complete({"name": "Admin", "pin": "1234"}))

        self.assertFalse(result["ok"])
        self.assertEqual(result["errorCode"], "setup_persistence_failed")
        self.assertNotIn("private path", result["error"])


if __name__ == "__main__":
    unittest.main()

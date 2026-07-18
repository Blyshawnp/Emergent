import sys
import unittest
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parent))
import server


class UpdateMetadataTransportTests(unittest.TestCase):
    def test_packaged_apps_script_uses_role_scoped_mts_and_sam_tabs(self):
        class FakeClient:
            def __init__(self, app_name, tab_name, version):
                self.app_name = app_name
                self.tab_name = tab_name
                self.version = version
                self.actions = []

            def get(self, action):
                self.actions.append(action)
                return {
                    "app": self.app_name,
                    "tab": self.tab_name,
                    "row": {
                        "Version": self.version,
                        "RequiredVersion": "1.0.0",
                        "Release Date": "2026-07-18",
                        "Release Title": f"{self.app_name.upper()} release",
                        "URL": "",
                        "Notes": "First note\n- Second note",
                    },
                }

        cases = (
            ("mts", server.UPDATE_MTS_TAB, "1.0.1"),
            ("sam", server.UPDATE_SAM_TAB, "1.0.2"),
        )
        for app_name, tab_name, version in cases:
            with self.subTest(app=app_name):
                client = FakeClient(app_name, tab_name, version)
                with mock.patch.object(server, "_get_shared_tracking_sheet_service", return_value={
                    "ok": True,
                    "appsScriptClient": client,
                    "sheet_id": "test-sheet",
                }):
                    result = server._get_update_metadata(app_name)

                self.assertTrue(result["ok"])
                self.assertEqual(result["app"], app_name)
                self.assertEqual(result["tab"], tab_name)
                self.assertEqual(result["latestVersion"], version)
                self.assertEqual(result["notes"], ["First note", "Second note"])
                self.assertEqual(client.actions, ["getUpdateMetadata"])

    def test_role_mismatch_and_transport_failure_are_safe(self):
        mismatched = mock.Mock()
        mismatched.get.return_value = {
            "app": "sam",
            "tab": server.UPDATE_SAM_TAB,
            "row": {},
        }
        with mock.patch.object(server, "_get_shared_tracking_sheet_service", return_value={
            "ok": True,
            "appsScriptClient": mismatched,
            "sheet_id": "test-sheet",
        }):
            mismatch_result = server._get_update_metadata("mts")
        self.assertFalse(mismatch_result["ok"])
        self.assertIn("does not match", mismatch_result["error"])

        failing = mock.Mock()
        failing.get.side_effect = RuntimeError("private credential and deployment detail")
        with self.assertLogs("server", level="WARNING") as captured, \
                mock.patch.object(server, "_get_shared_tracking_sheet_service", return_value={
                    "ok": True,
                    "appsScriptClient": failing,
                    "sheet_id": "test-sheet",
                }):
            failure_result = server._get_update_metadata("sam")
        self.assertFalse(failure_result["ok"])
        self.assertNotIn("private credential", failure_result["error"])
        self.assertNotIn("deployment", failure_result["error"])
        self.assertNotIn("private credential", "\n".join(captured.output))
        self.assertNotIn("deployment detail", "\n".join(captured.output))

    def test_direct_sheets_branch_is_unchanged(self):
        direct_service = mock.Mock()
        sheets_api = direct_service.spreadsheets.return_value
        rows = [{
            "Version": "1.0.3",
            "RequiredVersion": "",
            "Release Date": "2026-07-18",
            "Release Title": "Direct Sheets release",
            "URL": "",
            "Notes": "Direct note",
        }]
        with mock.patch.object(server, "_get_shared_tracking_sheet_service", return_value={
            "ok": True,
            "service": direct_service,
            "sheet_id": "test-sheet",
        }), mock.patch.object(server, "_ensure_update_tabs", return_value={"ok": True}), \
                mock.patch.object(server, "_shared_read_rows", return_value=rows) as read_rows:
            result = server._get_update_metadata("sam")

        self.assertTrue(result["ok"])
        self.assertEqual(result["app"], "sam")
        self.assertEqual(result["tab"], server.UPDATE_SAM_TAB)
        self.assertEqual(result["latestVersion"], "1.0.3")
        read_rows.assert_called_once_with(
            sheets_api,
            "test-sheet",
            server.UPDATE_SAM_TAB,
            server.UPDATE_TAB_HEADERS,
        )


if __name__ == "__main__":
    unittest.main()

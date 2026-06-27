import json
import os
import tempfile
import unittest
import asyncio
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from unittest import mock

from backend.services.apps_script_api import (
    AppsScriptApiError,
    create_apps_script_sheet_service,
    load_apps_script_api_config,
)


class _Response:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self._payload


class AppsScriptApiTests(unittest.TestCase):
    def _write_config(self, root, payload):
        config_dir = Path(root) / "config"
        config_dir.mkdir(parents=True, exist_ok=True)
        (config_dir / "apps-script-api.json").write_text(json.dumps(payload), encoding="utf-8")

    def test_deployable_server_uses_real_tabs_and_compatibility_actions(self):
        source = (Path(__file__).resolve().parents[1] / "docs" / "apps-script-api-web-app.gs").read_text(encoding="utf-8")
        for tab in ("sam-authorized-users", "sam-notifications", "Candidate Sessions", "Pending Sup Transfers", "headsets", "settings", "notification-recipients"):
            self.assertIn(f"'{tab}'", source)
        for action in (
            "getSamAdmins",
            "getTickerMessages",
            "getCandidateTracking",
            "getSharedCandidates",
            "getSheetMetadata",
            "getSheetRange",
            "updateSheetRange",
            "appendSheetRows",
            "batchGetSheetRanges",
            "batchUpdateSheetRanges",
            "batchUpdateSpreadsheet",
            "getSettings",
            "getNotificationRecipients",
            "approveHeadset",
            "denyHeadset",
            "archiveHeadsetReview",
            "deleteHeadsetReview",
            "addNotification",
            "updateNotification",
            "disableNotification",
            "deleteNotification",
        ):
            self.assertIn(f"case '{action}'", source)
        self.assertNotIn("BEGIN PRIVATE KEY", source)
        self.assertNotIn("private_key", source)

    def test_missing_disabled_and_placeholder_configs_fall_back_safely(self):
        with tempfile.TemporaryDirectory() as root:
            config, status = load_apps_script_api_config(Path(root))
            self.assertIsNone(config)
            self.assertEqual(status["status"], "missing")

            self._write_config(root, {"enabled": False, "base_url": "", "token": ""})
            config, status = load_apps_script_api_config(Path(root))
            self.assertIsNone(config)
            self.assertEqual(status["status"], "disabled")

            self._write_config(root, {
                "enabled": True,
                "base_url": "https://script.google.com/macros/s/DEPLOYMENT_ID/exec",
                "token": "TOKEN",
            })
            config, status = load_apps_script_api_config(Path(root))
            self.assertIsNone(config)
            self.assertEqual(status["status"], "invalid")

    def test_adapter_sends_token_but_never_exposes_it_in_repr_or_error(self):
        secret = "unit-test-secret"
        seen = {}

        def opener(request, timeout):
            if request.data is None:
                seen.update({key: value[0] for key, value in parse_qs(urlparse(request.full_url).query).items()})
            else:
                seen.update(json.loads(request.data.decode("utf-8")))
            seen["timeout"] = timeout
            return _Response({"ok": False, "error": f"Rejected {secret}"})

        with tempfile.TemporaryDirectory() as root:
            self._write_config(root, {
                "enabled": True,
                "base_url": "https://script.google.com/macros/s/test-deployment/exec",
                "token": secret,
            })
            result = create_apps_script_sheet_service(Path(root), opener=opener)
            self.assertTrue(result["ok"])
            self.assertNotIn("token", result["status"])
            self.assertNotIn("base_url", result["status"])
            self.assertNotIn(secret, repr(result["client"]))
            self.assertNotIn(secret, repr(result["service"]))
            with self.assertRaises(AppsScriptApiError) as caught:
                result["service"].spreadsheets().values().get(
                    spreadsheetId="sheet",
                    range="headsets!A:D",
                ).execute()
            self.assertEqual(seen["token"], secret)
            self.assertEqual(seen["action"], "getSheetRange")
            self.assertNotIn(secret, str(caught.exception))

    def test_config_diagnostics_expose_only_safe_metadata(self):
        secret = "unit-test-diagnostic-secret"
        with tempfile.TemporaryDirectory() as root:
            self._write_config(root, {
                "enabled": True,
                "base_url": "https://script.google.com/macros/s/test-deployment/exec",
                "token": secret,
            })
            with self.assertLogs("backend.services.apps_script_api", level="INFO") as captured:
                config, status = load_apps_script_api_config(Path(root))

        combined = "\n".join(captured.output)
        self.assertIsNotNone(config)
        self.assertTrue(status["ok"])
        self.assertIn("enabled=True", combined)
        self.assertIn("base_url_host_path=script.google.com/macros/s/test-deployment/exec", combined)
        self.assertIn("token_present=True", combined)
        self.assertNotIn(secret, combined)

    def test_explicit_and_packaged_config_paths_precede_development_fallback(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as resources:
            explicit = Path(root) / "explicit.json"
            packaged = Path(resources) / "backend" / "config" / "apps-script-api.json"
            packaged.parent.mkdir(parents=True)
            payload = {
                "enabled": True,
                "base_url": "https://script.google.com/macros/s/test-deployment/exec",
                "token": "safe-test-token",
            }
            explicit.write_text(json.dumps(payload), encoding="utf-8")
            packaged.write_text(json.dumps(payload), encoding="utf-8")

            with mock.patch.dict(os.environ, {
                "APPS_SCRIPT_API_CONFIG_FILE": str(explicit),
                "APP_RESOURCES_PATH": str(resources),
            }, clear=False):
                config, _status = load_apps_script_api_config(Path(root))
                self.assertEqual(config.path, explicit)

            with mock.patch.dict(os.environ, {
                "APPS_SCRIPT_API_CONFIG_FILE": "",
                "APP_RESOURCES_PATH": str(resources),
            }, clear=False):
                config, _status = load_apps_script_api_config(Path(root))
                self.assertEqual(config.path, packaged)

    def test_adapter_returns_google_compatible_result(self):
        def opener(_request, timeout):
            self.assertGreater(timeout, 0)
            return _Response({"ok": True, "result": {"values": [["Brand", "Model"]]}})

        with tempfile.TemporaryDirectory() as root:
            self._write_config(root, {
                "enabled": True,
                "base_url": "https://script.google.com/macros/s/test-deployment/exec",
                "token": "safe-test-token",
            })
            result = create_apps_script_sheet_service(Path(root), opener=opener)
            values = result["service"].spreadsheets().values().get(
                spreadsheetId="sheet",
                range="headsets!A:D",
            ).execute()["values"]
            self.assertEqual(values, [["Brand", "Model"]])

    def test_adapter_exposes_every_sheet_operation_used_by_mts_and_sam(self):
        actions = []

        def opener(request, timeout):
            self.assertGreater(timeout, 0)
            if request.data is None:
                request_payload = parse_qs(urlparse(request.full_url).query)
                actions.append(request_payload["action"][0])
            else:
                request_payload = json.loads(request.data.decode("utf-8"))
                actions.append(request_payload["action"])
            return _Response({"ok": True, "result": {}})

        with tempfile.TemporaryDirectory() as root:
            self._write_config(root, {
                "enabled": True,
                "base_url": "https://script.google.com/macros/s/test-deployment/exec",
                "token": "safe-test-token",
            })
            result = create_apps_script_sheet_service(Path(root), opener=opener)
            sheets = result["service"].spreadsheets()
            result["client"].ping()
            sheets.get(spreadsheetId="sheet").execute()
            sheets.batchUpdate(spreadsheetId="sheet", body={"requests": []}).execute()
            sheets.values().get(spreadsheetId="sheet", range="headsets!A:D").execute()
            sheets.values().update(
                spreadsheetId="sheet",
                range="headsets!A1:D1",
                valueInputOption="USER_ENTERED",
                body={"values": [["Brand", "Model", "Status", "Note"]]},
            ).execute()
            sheets.values().append(
                spreadsheetId="sheet",
                range="headset-review-log!A2",
                valueInputOption="USER_ENTERED",
                insertDataOption="INSERT_ROWS",
                body={"values": [["Brand", "Model", "pending", ""]]},
            ).execute()
            sheets.values().batchGet(
                spreadsheetId="sheet",
                ranges=["'headsets'!A:D", "'sam-notifications'!A:Q"],
            ).execute()
            sheets.values().batchUpdate(
                spreadsheetId="sheet",
                body={"data": [{"range": "'headsets'!A1:D1", "values": [["Brand", "Model", "Status", "Note"]]}]},
            ).execute()

        self.assertEqual(actions, [
            "ping",
            "getSheetMetadata",
            "batchUpdateSpreadsheet",
            "getSheetRange",
            "updateSheetRange",
            "appendSheetRows",
            "batchGetSheetRanges",
            "batchUpdateSheetRanges",
        ])

    def test_compatibility_routes_cover_sam_ticker_candidates_and_headsets(self):
        requests = []

        def opener(request, timeout):
            self.assertGreater(timeout, 0)
            if request.data is None:
                payload = {key: value[0] for key, value in parse_qs(urlparse(request.full_url).query).items()}
                requests.append(payload)
                if payload["action"] == "getSheetMetadata":
                    return _Response({"ok": True, "result": {"sheets": []}})
                return _Response({"ok": True, "result": {"values": [["header"], ["row"]]}})
            payload = json.loads(request.data.decode("utf-8"))
            requests.append(payload)
            return _Response({"ok": True, "result": {"updated": True}})

        with tempfile.TemporaryDirectory() as root:
            self._write_config(root, {
                "enabled": True,
                "base_url": "https://script.google.com/macros/s/test-deployment/exec",
                "token": "safe-test-token",
            })
            service = create_apps_script_sheet_service(Path(root), opener=opener)["service"].spreadsheets()
            service.get(spreadsheetId="sheet").execute()
            for sheet_range in (
                "'sam-authorized-users'!A2:H",
                "'sam-notifications'!A2:Q",
                "'Candidate Sessions'!A2:AZ",
                "'Pending Sup Transfers'!A2:AL",
                "'headsets'!A2:D",
                "'settings'!A2:Z",
                "'notification-recipients'!A2:Z",
            ):
                service.values().get(spreadsheetId="sheet", range=sheet_range).execute()

        self.assertEqual(requests[0]["action"], "getSheetMetadata")
        self.assertTrue(all(request["action"] in ("getSheetRange", "getSettings", "getNotificationRecipients") for request in requests[1:]))
        self.assertEqual(
            [request["range"] for request in requests[1:]],
            [
                "'sam-authorized-users'!A2:H",
                "'sam-notifications'!A2:Q",
                "'Candidate Sessions'!A2:AZ",
                "'Pending Sup Transfers'!A2:AL",
                "'headsets'!A2:D",
                "'settings'!A2:Z",
                "'notification-recipients'!A2:Z",
            ],
        )

    def test_missing_compatibility_route_is_controlled_and_never_forwards_generic_action(self):
        seen_actions = []

        def opener(request, timeout):
            self.assertGreater(timeout, 0)
            payload = {key: value[0] for key, value in parse_qs(urlparse(request.full_url).query).items()}
            seen_actions.append(payload["action"])
            return _Response({"ok": False, "error": "Unknown action: getSheetMetadata"})

        with tempfile.TemporaryDirectory() as root:
            self._write_config(root, {
                "enabled": True,
                "base_url": "https://script.google.com/macros/s/test-deployment/exec",
                "token": "safe-test-token",
            })
            service = create_apps_script_sheet_service(Path(root), opener=opener)["service"]
            with self.assertRaisesRegex(AppsScriptApiError, "Unknown action: getSheetMetadata"):
                service.spreadsheets().get(spreadsheetId="sheet").execute()

        self.assertEqual(seen_actions, ["getSheetMetadata"])
        self.assertFalse(any(action.startswith("spreadsheets.") for action in seen_actions))

    def test_named_actions_use_encoded_get_and_reserved_post_auth_fields(self):
        requests = []

        def opener(request, timeout):
            self.assertGreater(timeout, 0)
            if request.data is None:
                payload = {key: value[0] for key, value in parse_qs(urlparse(request.full_url).query).items()}
                requests.append(("GET", payload))
                return _Response({"ok": True, "rows": [{"Brand": "Example", "Model": "H1"}]})
            payload = json.loads(request.data.decode("utf-8"))
            requests.append(("POST", payload))
            return _Response({"ok": True, "updated": True})

        with tempfile.TemporaryDirectory() as root:
            self._write_config(root, {
                "enabled": True,
                "base_url": "https://script.google.com/macros/s/test-deployment/exec",
                "token": "safe-test-token",
            })
            result = create_apps_script_sheet_service(Path(root), opener=opener)
            read_actions = [
                "getHeadsets",
                "getScreenshots",
                "getDiscordPosts",
                "getHeadsetReviewLog",
                "getCandidateTracking",
                "getSamAdmins",
                "getTickerMessages",
                "getSharedCandidates",
                "getSettings",
                "getNotificationRecipients",
            ]
            get_results = [result["client"].get(action) for action in read_actions]
            post_result = result["client"].post("approveHeadset", {
                "action": "must-not-override",
                "token": "must-not-override",
                "brand": "Example",
                "model": "H1",
            })

        self.assertTrue(all(len(response["rows"]) == 1 for response in get_results))
        self.assertTrue(post_result["updated"])
        read_count = len(read_actions)
        self.assertEqual([request[1]["action"] for request in requests[:read_count]], read_actions)
        self.assertTrue(all(request[0] == "GET" for request in requests[:read_count]))
        self.assertEqual(requests[read_count][0], "POST")
        self.assertEqual(requests[read_count][1]["action"], "approveHeadset")
        self.assertEqual(requests[read_count][1]["token"], "safe-test-token")

    def test_apps_script_candidate_lookup_and_pending_rows_use_named_payload(self):
        mock_client = mock.MagicMock()
        mock_client.get.return_value = {
            "rows": [
                {
                    "candidate_name": "Lisa Rusie",
                    "status": "PASS",
                    "completed_at": "2026-06-18T23:40:29.888099-04:00",
                    "notes": "Passed first attempt",
                    "tester_name": "Tester A",
                    "session_type": "Campaign 1",
                    "attempt_number": "1",
                }
            ],
            "pendingRows": [
                {
                    "pending_id": "pending-123",
                    "candidate_name": "John Doe",
                    "status": "pending",
                    "created_at": "2026-06-24T02:00:00Z",
                }
            ]
        }
        
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server

        with mock.patch("server._shared_sheet_context") as mock_ctx:
            mock_ctx.return_value = {
                "ok": True,
                "appsScriptClient": mock_client,
                "sheet_id": "test-sheet-id",
            }
            snapshot = server._shared_admin_candidate_snapshot()
            
        self.assertTrue(snapshot["ok"])
        self.assertEqual(len(snapshot["candidates"]), 1)
        self.assertEqual(snapshot["candidates"][0]["candidate_name"], "Lisa Rusie")
        self.assertEqual(snapshot["candidates"][0]["attempt_count"], "1")
        self.assertEqual(len(snapshot["pending"]), 1)
        self.assertEqual(snapshot["pending"][0]["candidate_name"], "John Doe")
        self.assertEqual(snapshot["pending"][0]["pending_id"], "pending-123")
        self.assertEqual(snapshot["pending"][0]["status"], "pending")
        self.assertEqual(snapshot["pending"][0]["created_at"], "2026-06-24T02:00:00Z")

    def test_candidate_admin_action_posts_operation_to_apps_script(self):
        mock_client = mock.MagicMock()
        mock_client.post.return_value = {"updated": True}

        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server

        with mock.patch("server._shared_sheet_context") as mock_ctx:
            mock_ctx.return_value = {
                "ok": True,
                "appsScriptClient": mock_client,
                "sheet_id": "test-sheet-id",
            }
            result = server._shared_admin_candidate_action({
                "action": "archive_candidate",
                "candidate_name": "Lisa Rusie",
                "session_id": "session-1",
            })

        self.assertTrue(result["ok"])
        mock_client.post.assert_called_once()
        action, payload = mock_client.post.call_args.args
        self.assertEqual(action, "updateCandidateTracking")
        self.assertEqual(payload["operation"], "archive_candidate")
        self.assertNotIn("action", payload)

    def test_apps_script_ticker_rows_are_used_for_notification_groups(self):
        mock_client = mock.MagicMock()
        mock_client.get.return_value = {
            "rows": [{
                "Enabled": "TRUE",
                "ID": "live-row",
                "Type": "info",
                "Title": "Live",
                "Message": "Live sheet ticker",
                "ShowTicker": "TRUE",
                "ShowPopup": "FALSE",
                "ShowBanner": "FALSE",
                "Persistent": "TRUE",
            }]
        }

        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server

        result = server._read_sam_notification_items_via_apps_script(mock_client, "sheet-id")
        groups = server._group_notification_manager_items(result["items"])

        self.assertTrue(result["ok"])
        self.assertEqual(groups["tickerMessages"][0]["message"], "Live sheet ticker")
        mock_client.get.assert_called_once_with("getTickerMessages", {})

    def test_ticker_endpoint_returns_live_apps_script_rows_before_fallback(self):
        mock_client = mock.MagicMock()
        mock_client.get.return_value = {
            "rows": [{
                "Enabled": "TRUE",
                "ID": "live-row",
                "Type": "info",
                "Title": "Live",
                "Message": "Live endpoint ticker",
                "ShowTicker": "TRUE",
                "ShowPopup": "FALSE",
                "ShowBanner": "FALSE",
                "Persistent": "TRUE",
            }]
        }

        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server

        server._ticker_cache.update({"messages": None, "last_fetch": 0, "using_fallback": False})
        server._notification_cache.update({"groups": None, "last_fetch": 0, "url": ""})
        with mock.patch("server._sam_master_sheet_context") as mock_ctx:
            mock_ctx.return_value = {
                "ok": True,
                "appsScriptClient": mock_client,
                "sheet_id": "test-sheet-id",
            }
            result = asyncio.run(server.get_ticker())

        self.assertEqual(result["messages"], ["Live: Live endpoint ticker"])
        self.assertFalse(result["fallback"])
        self.assertEqual(result["source"], "google")
        mock_client.get.assert_called_once_with("getTickerMessages", {})


if __name__ == "__main__":
    unittest.main()

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
    def _write_config(self, root, payload, filename="apps-script-api.json"):
        config_dir = Path(root) / "config"
        config_dir.mkdir(parents=True, exist_ok=True)
        (config_dir / filename).write_text(json.dumps(payload), encoding="utf-8")

    def test_deployable_server_uses_real_tabs_and_compatibility_actions(self):
        source = (Path(__file__).resolve().parents[1] / "docs" / "apps-script-api-web-app.gs").read_text(encoding="utf-8")
        for tab in ("sam-authorized-users", "sam-notifications", "Candidate Sessions", "Pending Sup Transfers", "headsets", "settings", "notification-recipients"):
            self.assertIn(f"'{tab}'", source)
        for action in (
            "getSamSetupStatus",
            "getSamAdmins",
            "getTickerMessages",
            "getCandidateTracking",
            "getSharedCandidates",
            "getSheetMetadata",
            "getSheetRange",
            "getHeadsetReviewMigrationPlan",
            "updateSheetRange",
            "appendSheetRows",
            "batchGetSheetRanges",
            "batchUpdateSheetRanges",
            "batchUpdateSpreadsheet",
            "getSettings",
            "getNotificationRecipients",
            "approveHeadset",
            "editHeadsetReview",
            "migrateHeadsetReviewSchema",
            "denyHeadset",
            "archiveHeadsetReview",
            "deleteHeadsetReview",
            "addNotification",
            "updateNotification",
            "disableNotification",
            "deleteNotification",
            "completeSamSetup",
        ):
            self.assertIn(f"case '{action}'", source)
        self.assertNotIn("BEGIN PRIVATE KEY", source)
        self.assertNotIn("private_key", source)

    def test_headset_review_migration_requires_verified_backup_and_checksum_guard(self):
        source = (Path(__file__).resolve().parents[1] / "docs" / "apps-script-api-web-app.gs").read_text(encoding="utf-8")
        migration = source.split("function migrateHeadsetReviewSchema_", 1)[1].split("function headsetReviewStatus_", 1)[0]
        self.assertIn("MIGRATE_HEADSET_REVIEW_V2", migration)
        self.assertIn("expected_checksum", migration)
        self.assertIn("migration-backup-", migration)
        self.assertIn("backupChecksum !== analysis.source_checksum", migration)
        self.assertIn("analysis.safe_to_migrate", migration)
        self.assertNotIn("deleteSheet", migration)

    def test_candidate_correction_preserves_catalog_boundary_and_updates_only_linked_review(self):
        source = (Path(__file__).resolve().parents[1] / "docs" / "apps-script-api-web-app.gs").read_text(encoding="utf-8")
        self.assertIn("'Brand',\n  'Model',\n  'Status',\n  'Note'", source)
        correction_body = source.split("function applyCandidateCorrection_", 1)[1].split("function applyCandidateDeletionTerminal_", 1)[0]
        self.assertIn("change.field === 'headset_brand'", correction_body)
        self.assertIn("change.field === 'headset_model'", correction_body)
        self.assertNotIn("allowedSheet_('headsets')", correction_body)
        self.assertIn("updateMatchingRows_('headset-review-log'", correction_body)
        self.assertIn("String(review.source_session_id || '').trim() === sourceSessionId", correction_body)
        self.assertNotIn("submitHeadsetReview_", correction_body)

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
        self.assertIn("base_url_host=script.google.com", combined)
        self.assertNotIn("test-deployment", combined)
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

    def test_role_specific_development_configs_are_selected_by_app_mode(self):
        with tempfile.TemporaryDirectory() as root:
            self._write_config(root, {
                "enabled": True,
                "role": "mts",
                "base_url": "https://script.google.com/macros/s/test-deployment/exec",
                "token": "mts-test-token",
            }, "apps-script-api-mts.json")
            self._write_config(root, {
                "enabled": True,
                "role": "sam",
                "base_url": "https://script.google.com/macros/s/test-deployment/exec",
                "token": "sam-test-token",
            }, "apps-script-api-sam.json")

            with mock.patch.dict(os.environ, {
                "APPS_SCRIPT_API_CONFIG_FILE": "",
                "APP_RESOURCES_PATH": "",
                "APPS_SCRIPT_API_ROLE": "mts",
                "MTS_NOTIFICATION_MANAGER": "",
            }, clear=False):
                mts_config, mts_status = load_apps_script_api_config(Path(root))
            with mock.patch.dict(os.environ, {
                "APPS_SCRIPT_API_CONFIG_FILE": "",
                "APP_RESOURCES_PATH": "",
                "APPS_SCRIPT_API_ROLE": "sam",
                "MTS_NOTIFICATION_MANAGER": "1",
            }, clear=False):
                sam_config, sam_status = load_apps_script_api_config(Path(root))

        self.assertEqual(mts_config.role, "mts")
        self.assertEqual(mts_config.path.name, "apps-script-api-mts.json")
        self.assertEqual(mts_status["role"], "mts")
        self.assertEqual(sam_config.role, "sam")
        self.assertEqual(sam_config.path.name, "apps-script-api-sam.json")
        self.assertEqual(sam_status["role"], "sam")

    def test_role_mismatch_and_unscoped_sam_config_fail_closed(self):
        with tempfile.TemporaryDirectory() as root:
            explicit = Path(root) / "wrong-role.json"
            explicit.write_text(json.dumps({
                "enabled": True,
                "role": "sam",
                "base_url": "https://script.google.com/macros/s/test-deployment/exec",
                "token": "sam-test-token",
            }), encoding="utf-8")
            with mock.patch.dict(os.environ, {
                "APPS_SCRIPT_API_CONFIG_FILE": str(explicit),
                "APPS_SCRIPT_API_ROLE": "mts",
            }, clear=False):
                config, status = load_apps_script_api_config(Path(root))
            self.assertIsNone(config)
            self.assertEqual(status["status"], "role_mismatch")

        with tempfile.TemporaryDirectory() as root:
            self._write_config(root, {
                "enabled": True,
                "base_url": "https://script.google.com/macros/s/test-deployment/exec",
                "token": "legacy-test-token",
            })
            with mock.patch.dict(os.environ, {
                "APPS_SCRIPT_API_CONFIG_FILE": "",
                "APP_RESOURCES_PATH": "",
                "APPS_SCRIPT_API_ROLE": "sam",
                "MTS_NOTIFICATION_MANAGER": "1",
            }, clear=False):
                config, status = load_apps_script_api_config(Path(root))
            self.assertIsNone(config)
            self.assertEqual(status["status"], "role_mismatch")

    def test_legacy_unscoped_config_remains_mts_only_during_migration(self):
        with tempfile.TemporaryDirectory() as root:
            self._write_config(root, {
                "enabled": True,
                "base_url": "https://script.google.com/macros/s/test-deployment/exec",
                "token": "legacy-test-token",
            })
            with mock.patch.dict(os.environ, {
                "APPS_SCRIPT_API_CONFIG_FILE": "",
                "APP_RESOURCES_PATH": "",
                "APPS_SCRIPT_API_ROLE": "mts",
                "MTS_NOTIFICATION_MANAGER": "",
            }, clear=False):
                config, status = load_apps_script_api_config(Path(root))

        self.assertIsNotNone(config)
        self.assertEqual(config.role, "mts")
        self.assertEqual(status["role"], "mts")

    def test_packaging_uses_separate_role_credentials_with_common_runtime_destination(self):
        repo_root = Path(__file__).resolve().parents[1]
        mts_manifest = json.loads((repo_root / "desktop" / "package.json").read_text(encoding="utf-8"))
        sam_manifest = json.loads((repo_root / "desktop" / "notification-manager-builder.json").read_text(encoding="utf-8"))

        def apps_script_resource(resources):
            return next(
                item for item in resources
                if str(item.get("to") or "").replace("\\", "/") == "backend/config/apps-script-api.json"
            )

        mts_resource = apps_script_resource(mts_manifest["build"]["extraResources"])
        sam_resource = apps_script_resource(sam_manifest["extraResources"])
        self.assertEqual(mts_resource["from"].replace("\\", "/"), "../backend/config/apps-script-api-mts.json")
        self.assertEqual(sam_resource["from"].replace("\\", "/"), "../backend/config/apps-script-api-sam.json")
        self.assertNotEqual(mts_resource["from"], sam_resource["from"])

        main_source = (repo_root / "desktop" / "src" / "main.js").read_text(encoding="utf-8")
        self.assertIn("APPS_SCRIPT_API_ROLE", main_source)
        self.assertIn("isNotificationManagerMode ? 'sam' : 'mts'", main_source)

    def test_direct_sheets_service_remains_preferred_regardless_of_apps_script_role(self):
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server

        direct_service = object()
        fake_credentials = object()
        with mock.patch.dict(os.environ, {"APPS_SCRIPT_API_ROLE": "sam"}, clear=False), \
                mock.patch.object(server, "_shared_tracking_sheet_id", return_value="test-sheet"), \
                mock.patch.object(server, "_resolve_notification_service_account_file", return_value=Path("test-credential.json")), \
                mock.patch.object(server, "_get_service_account_email", return_value="configured"), \
                mock.patch.object(server, "_record_google_sheet_auth_status"), \
                mock.patch("google.oauth2.service_account.Credentials.from_service_account_file", return_value=fake_credentials), \
                mock.patch("googleapiclient.discovery.build", return_value=direct_service):
            result = server._get_shared_tracking_sheet_service()

        self.assertTrue(result["ok"])
        self.assertIs(result["service"], direct_service)
        self.assertNotIn("appsScriptClient", result)

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

    def test_mts_candidate_sync_uses_named_candidate_and_pending_rows(self):
        mock_client = mock.MagicMock()
        mock_client.post.return_value = {
            "updated": True,
            "candidateAction": "appended",
            "pendingAction": "appended",
        }

        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server

        candidate_values = [f"candidate-{index}" for index in range(len(server.SHARED_CANDIDATE_SESSION_HEADERS))]
        pending_values = [f"pending-{index}" for index in range(len(server.SHARED_PENDING_SUP_TRANSFER_HEADERS))]
        with mock.patch.object(server, "_shared_sheet_context", return_value={
            "ok": True,
            "appsScriptClient": mock_client,
            "sheet_id": "test-sheet-id",
        }), mock.patch.object(server, "_remote_newbie_request_snapshot", return_value={"ok": False}), \
                mock.patch.object(server, "_candidate_session_row", return_value=(candidate_values, "pending-1", True)), \
                mock.patch.object(server, "_pending_sup_transfer_row", return_value=pending_values):
            result = server._sync_shared_candidate_tracking({
                "history_id": "session-1",
                "candidate_name": "Candidate Example",
                "tester_name": "Tester Example",
            })

        self.assertTrue(result["ok"])
        action, payload = mock_client.post.call_args.args
        self.assertEqual(action, "updateCandidateTracking")
        self.assertEqual(
            payload["candidateRow"],
            dict(zip(server.SHARED_CANDIDATE_SESSION_HEADERS, candidate_values)),
        )
        self.assertEqual(
            payload["pendingRow"],
            dict(zip(server.SHARED_PENDING_SUP_TRANSFER_HEADERS, pending_values)),
        )
        self.assertNotIn("candidateName", payload)
        self.assertNotIn("operation", payload)

    def test_shared_admin_snapshot_reuses_one_sheet_context(self):
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server

        context = {"ok": False, "error": "test-unavailable"}
        with mock.patch.object(server, "_shared_sheet_context", return_value=context) as context_loader:
            snapshot = server._shared_admin_snapshot()

        self.assertFalse(snapshot["ok"])
        context_loader.assert_called_once_with()

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
        with mock.patch("server._notification_read_sheet_context") as mock_ctx:
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

    def test_notifications_endpoint_labels_successful_remote_content_for_safe_renderer_cache(self):
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server

        groups = {
            "tickerMessages": [{"id": "live", "message": "Remote"}],
            "banners": [],
            "popups": [],
        }
        server._ticker_fetch_status.update({"source": "google", "status": "test success"})

        with mock.patch("server._fetch_notifications_from_sheet", new=mock.AsyncMock(return_value=groups)):
            result = asyncio.run(server.get_notifications())

        self.assertEqual(result["tickerMessages"], groups["tickerMessages"])
        self.assertEqual(result["source"], "google")
        self.assertFalse(result["fallback"])

    def test_dedicated_read_resolver_mts_only_success(self):
        # MTS-only configuration reads ticker successfully
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server
        from services.apps_script_api import AppsScriptApiConfig

        # Mock load_apps_script_api_config:
        # mts is ready, sam is missing.
        def mock_load(root_dir, expected_role=None):
            if expected_role == "mts":
                return AppsScriptApiConfig(True, "mts", "http://mts.exec", "token-mts", Path(".")), {"status": "ready"}
            return None, {"status": "missing"}

        server._ticker_cache.update({"messages": None, "last_fetch": 0, "using_fallback": False})
        server._notification_cache.update({"groups": None, "last_fetch": 0, "url": ""})
        server._ticker_fetch_status.update({"source": "builtin", "status": "not fetched"})

        with mock.patch("services.apps_script_api.load_apps_script_api_config", side_effect=mock_load), \
             mock.patch("server._is_development_mode", return_value=False), \
             mock.patch("os.getenv", return_value=None):

            # Call resolver
            ctx = server._notification_read_sheet_context()
            self.assertTrue(ctx["ok"])
            self.assertEqual(ctx["resolved_role"], "mts")
            self.assertEqual(ctx["transport"], "apps_script")

    def test_dedicated_read_resolver_sam_only_success(self):
        # SAM-only configuration reads ticker successfully
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server
        from services.apps_script_api import AppsScriptApiConfig

        def mock_load(root_dir, expected_role=None):
            if expected_role == "sam":
                return AppsScriptApiConfig(True, "sam", "http://sam.exec", "token-sam", Path(".")), {"status": "ready"}
            return None, {"status": "missing"}

        server._ticker_cache.update({"messages": None, "last_fetch": 0, "using_fallback": False})
        server._notification_cache.update({"groups": None, "last_fetch": 0, "url": ""})
        server._ticker_fetch_status.update({"source": "builtin", "status": "not fetched"})

        # Run as MTS preferred role (default), so when it finds MTS missing, it falls back to SAM config
        with mock.patch("services.apps_script_api.load_apps_script_api_config", side_effect=mock_load), \
             mock.patch("server._is_development_mode", return_value=False), \
             mock.patch("os.getenv", return_value=None):

            ctx = server._notification_read_sheet_context()
            self.assertTrue(ctx["ok"])
            self.assertEqual(ctx["resolved_role"], "sam")
            self.assertEqual(ctx["transport"], "apps_script")

    def test_dedicated_read_resolver_both_present_uses_preferred(self):
        # Both configs present, uses preferred (MTS by default when MTS_NOTIFICATION_MANAGER is not set)
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server
        from services.apps_script_api import AppsScriptApiConfig

        def mock_load(root_dir, expected_role=None):
            if expected_role == "sam":
                return AppsScriptApiConfig(True, "sam", "http://sam.exec", "token-sam", Path(".")), {"status": "ready"}
            return AppsScriptApiConfig(True, "mts", "http://mts.exec", "token-mts", Path(".")), {"status": "ready"}

        with mock.patch("services.apps_script_api.load_apps_script_api_config", side_effect=mock_load), \
             mock.patch("server._is_development_mode", return_value=False), \
             mock.patch("os.getenv", return_value=None):

            ctx = server._notification_read_sheet_context()
            self.assertTrue(ctx["ok"])
            self.assertEqual(ctx["resolved_role"], "mts") # preferred for MTS app

    def test_dedicated_read_resolver_preferred_absent_falls_back(self):
        # Preferred config (say SAM is preferred because MTS_NOTIFICATION_MANAGER=1) is missing, falls back to MTS
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server
        from services.apps_script_api import AppsScriptApiConfig

        def mock_load(root_dir, expected_role=None):
            if expected_role == "sam":
                return None, {"status": "missing"}
            return AppsScriptApiConfig(True, "mts", "http://mts.exec", "token-mts", Path(".")), {"status": "ready"}

        # Force SAM as preferred
        with mock.patch("services.apps_script_api.load_apps_script_api_config", side_effect=mock_load), \
             mock.patch("server._is_development_mode", return_value=False), \
             mock.patch.dict("os.environ", {"MTS_NOTIFICATION_MANAGER": "1"}):

            ctx = server._notification_read_sheet_context()
            self.assertTrue(ctx["ok"])
            self.assertEqual(ctx["resolved_role"], "mts") # falls back to MTS

    def test_invalid_sam_token_does_not_fall_back_to_mts(self):
        # invalid SAM token does not fall back to MTS
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server
        from services.apps_script_api import AppsScriptApiConfig

        def mock_load(root_dir, expected_role=None):
            if expected_role == "sam":
                # present but invalid/mismatched/unusable config status
                return None, {"status": "role_mismatch", "message": "role mismatch error"}
            return AppsScriptApiConfig(True, "mts", "http://mts.exec", "token-mts", Path(".")), {"status": "ready"}

        # Force SAM as preferred
        with mock.patch("services.apps_script_api.load_apps_script_api_config", side_effect=mock_load), \
             mock.patch("server._is_development_mode", return_value=False), \
             mock.patch.dict("os.environ", {"MTS_NOTIFICATION_MANAGER": "1"}):

            ctx = server._notification_read_sheet_context()
            self.assertFalse(ctx["ok"])
            self.assertEqual(ctx["resolved_role"], "sam")
            self.assertEqual(ctx["errorCode"], "role_mismatch")

    def test_sam_timeout_does_not_fall_back_to_mts(self):
        # SAM timeout does not fall back to MTS
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server
        from services.apps_script_api import AppsScriptApiConfig

        # SAM config is ready, MTS config is ready
        def mock_load(root_dir, expected_role=None):
            if expected_role == "sam":
                return AppsScriptApiConfig(True, "sam", "http://sam.exec", "token-sam", Path(".")), {"status": "ready"}
            return AppsScriptApiConfig(True, "mts", "http://mts.exec", "token-mts", Path(".")), {"status": "ready"}

        mock_client = mock.MagicMock()
        # Mock client to raise a timeout exception when calling getTickerMessages
        mock_client.get.side_effect = asyncio.TimeoutError("timeout error")

        server._ticker_cache.update({"messages": None, "last_fetch": 0, "using_fallback": False})
        server._notification_cache.update({"groups": None, "last_fetch": 0, "url": ""})
        server._ticker_fetch_status.update({"source": "builtin", "status": "not fetched"})

        # Force SAM as preferred
        with mock.patch("services.apps_script_api.load_apps_script_api_config", side_effect=mock_load), \
             mock.patch("services.apps_script_api.create_apps_script_sheet_service") as mock_srv, \
             mock.patch("server._is_development_mode", return_value=False), \
             mock.patch.dict("os.environ", {"MTS_NOTIFICATION_MANAGER": "1"}):

            mock_srv.return_value = {"ok": True, "client": mock_client}

            # Since timeout is raised during load, it should raise HTTPException 504 and not use fallback
            from fastapi import HTTPException
            with self.assertRaises(HTTPException) as context_exc:
                asyncio.run(server.get_ticker())

            self.assertEqual(context_exc.exception.status_code, 504)
            self.assertIn("timeout", context_exc.exception.detail)

    def test_unauthorized_does_not_become_generic_fallback_indefinitely(self):
        # Unauthorized raises 401 HTTPException
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server
        from services.apps_script_api import AppsScriptApiConfig, AppsScriptApiError

        def mock_load(root_dir, expected_role=None):
            return AppsScriptApiConfig(True, "mts", "http://mts.exec", "token-mts", Path(".")), {"status": "ready"}

        mock_client = mock.MagicMock()
        mock_client.get.side_effect = AppsScriptApiError(401, "Unauthorized access token")

        server._ticker_cache.update({"messages": None, "last_fetch": 0, "using_fallback": False})
        server._notification_cache.update({"groups": None, "last_fetch": 0, "url": ""})
        server._ticker_fetch_status.update({"source": "builtin", "status": "not fetched"})

        with mock.patch("services.apps_script_api.load_apps_script_api_config", side_effect=mock_load), \
             mock.patch("services.apps_script_api.create_apps_script_sheet_service") as mock_srv, \
             mock.patch("server._is_development_mode", return_value=False):

            mock_srv.return_value = {"ok": True, "client": mock_client}

            from fastapi import HTTPException
            with self.assertRaises(HTTPException) as context_exc:
                asyncio.run(server.get_ticker())

            self.assertEqual(context_exc.exception.status_code, 401)
            self.assertIn("Unauthorized", context_exc.exception.detail)

    def test_live_recovery_replaces_stale_content(self):
        # live recovery replaces stale/default content
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server
        from services.apps_script_api import AppsScriptApiConfig

        # Mock load config to be ready
        def mock_load(root_dir, expected_role=None):
            return AppsScriptApiConfig(True, "mts", "http://mts.exec", "token-mts", Path(".")), {"status": "ready"}

        mock_client = mock.MagicMock()
        mock_client.get.return_value = {
            "rows": [{
                "Enabled": "TRUE",
                "ID": "rec-row",
                "Type": "info",
                "Title": "Recovered",
                "Message": "Live recovered messages",
                "ShowTicker": "TRUE",
                "ShowPopup": "FALSE",
                "ShowBanner": "FALSE",
                "Persistent": "TRUE",
            }]
        }

        # Initialize caches with fallback default messages
        server._ticker_cache.update({"messages": ["Stale message"], "last_fetch": 100, "using_fallback": True})
        server._notification_cache.update({"groups": server._notification_defaults, "last_fetch": 100, "url": "fallback"})
        server._ticker_fetch_status.update({"source": "fallback", "status": "stale"})

        with mock.patch("services.apps_script_api.load_apps_script_api_config", side_effect=mock_load), \
             mock.patch("services.apps_script_api.create_apps_script_sheet_service") as mock_srv, \
             mock.patch("server._is_development_mode", return_value=False):

            mock_srv.return_value = {"ok": True, "client": mock_client}

            result = asyncio.run(server.get_ticker())
            self.assertEqual(result["messages"], ["Recovered: Live recovered messages"])
            self.assertFalse(result["fallback"])
            self.assertEqual(result["source"], "google")

    def test_valid_empty_live_response_distinguished_from_failure(self):
        # valid empty live response is distinguished (returns messages=[] and fallback=False)
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server
        from services.apps_script_api import AppsScriptApiConfig

        def mock_load(root_dir, expected_role=None):
            return AppsScriptApiConfig(True, "mts", "http://mts.exec", "token-mts", Path(".")), {"status": "ready"}

        mock_client = mock.MagicMock()
        mock_client.get.return_value = {
            "rows": [] # valid empty response
        }

        server._ticker_cache.update({"messages": None, "last_fetch": 0, "using_fallback": False})
        server._notification_cache.update({"groups": None, "last_fetch": 0, "url": ""})
        server._ticker_fetch_status.update({"source": "builtin", "status": "not fetched"})

        with mock.patch("services.apps_script_api.load_apps_script_api_config", side_effect=mock_load), \
             mock.patch("services.apps_script_api.create_apps_script_sheet_service") as mock_srv, \
             mock.patch("server._is_development_mode", return_value=False):

            mock_srv.return_value = {"ok": True, "client": mock_client}

            result = asyncio.run(server.get_ticker())
            self.assertEqual(result["messages"], [])
            self.assertFalse(result["fallback"])
            self.assertEqual(result["source"], "google")

    def test_malformed_response_raises_error(self):
        # malformed response does not fallback, raises bad gateway / internal error
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server
        from services.apps_script_api import AppsScriptApiConfig

        def mock_load(root_dir, expected_role=None):
            return AppsScriptApiConfig(True, "mts", "http://mts.exec", "token-mts", Path(".")), {"status": "ready"}

        mock_client = mock.MagicMock()
        mock_client.get.return_value = "Not a dictionary! Malformed response."

        server._ticker_cache.update({"messages": None, "last_fetch": 0, "using_fallback": False})
        server._notification_cache.update({"groups": None, "last_fetch": 0, "url": ""})
        server._ticker_fetch_status.update({"source": "builtin", "status": "not fetched"})

        with mock.patch("services.apps_script_api.load_apps_script_api_config", side_effect=mock_load), \
             mock.patch("services.apps_script_api.create_apps_script_sheet_service") as mock_srv, \
             mock.patch("server._is_development_mode", return_value=False):

            mock_srv.return_value = {"ok": True, "client": mock_client}

            from fastapi import HTTPException
            with self.assertRaises(HTTPException) as context_exc:
                asyncio.run(server.get_ticker())

            self.assertEqual(context_exc.exception.status_code, 502)

    def test_sam_notification_management_remains_sam_only(self):
        # save and delete must call _sam_master_sheet_context directly
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import server

        # We verify that they do not call the read-context resolver, but call _sam_master_sheet_context directly
        with mock.patch("server._sam_master_sheet_context") as mock_sam_ctx, \
             mock.patch("server._notification_read_sheet_context") as mock_read_ctx:

            mock_sam_ctx.return_value = {"ok": False, "error": "test"}
            server._delete_notification_from_google_sheet("123")

            mock_sam_ctx.assert_called_once()
            mock_read_ctx.assert_not_called()

        with mock.patch("server._sam_master_sheet_context") as mock_sam_ctx, \
             mock.patch("server._notification_read_sheet_context") as mock_read_ctx:

            mock_sam_ctx.return_value = {"ok": False, "error": "test"}
            server._save_notification_to_google_sheet({"ID": "123", "Message": "test", "Enabled": True, "Type": "info"})

            mock_sam_ctx.assert_called_once()
            mock_read_ctx.assert_not_called()


if __name__ == "__main__":
    unittest.main()

import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

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
            self.assertEqual(seen["action"], "spreadsheets.values.get")
            self.assertNotIn(secret, str(caught.exception))

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

        self.assertEqual(actions, [
            "ping",
            "spreadsheets.get",
            "spreadsheets.batchUpdate",
            "spreadsheets.values.get",
            "spreadsheets.values.update",
            "spreadsheets.values.append",
        ])

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
            get_result = result["client"].get("getHeadsets")
            post_result = result["client"].post("approveHeadset", {
                "action": "must-not-override",
                "token": "must-not-override",
                "brand": "Example",
                "model": "H1",
            })

        self.assertEqual(len(get_result["rows"]), 1)
        self.assertTrue(post_result["updated"])
        self.assertEqual(requests[0][0], "GET")
        self.assertEqual(requests[0][1]["action"], "getHeadsets")
        self.assertEqual(requests[1][0], "POST")
        self.assertEqual(requests[1][1]["action"], "approveHeadset")
        self.assertEqual(requests[1][1]["token"], "safe-test-token")


if __name__ == "__main__":
    unittest.main()

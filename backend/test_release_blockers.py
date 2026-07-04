import asyncio
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException
from starlette.requests import Request

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402


def make_request(headers=None, client_host="127.0.0.1"):
    raw_headers = []
    for key, value in (headers or {}).items():
        raw_headers.append((key.lower().encode("latin-1"), value.encode("latin-1")))
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/api/admin/runtime-diagnostics",
        "headers": raw_headers,
        "client": (client_host, 12345),
        "server": ("testserver", 80),
        "scheme": "http",
    })


class ReleaseBlockerTests(unittest.TestCase):
    def test_sqlite_transient_open_failure_does_not_delete_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "locked.sqlite3"
            db_path.write_bytes(b"not deleted")
            store = object.__new__(server.SQLiteDocumentStore)
            store.path = db_path

            with mock.patch("server.sqlite3.connect", side_effect=sqlite3.OperationalError("database is locked")):
                with self.assertRaises(sqlite3.OperationalError):
                    store._connect_with_recovery()

            self.assertTrue(db_path.exists())
            self.assertEqual(db_path.read_bytes(), b"not deleted")

    def test_runtime_diagnostics_require_admin_token_without_local_fallback(self):
        request = make_request()
        with mock.patch.dict(os.environ, {"MTS_ADMIN_TOKEN": "secret", "MTS_DEV_MODE": "true"}, clear=False):
            with self.assertRaises(HTTPException):
                asyncio.run(server.get_admin_runtime_diagnostics(request))

    def test_runtime_diagnostics_omit_paths_and_credential_identifiers(self):
        payload = server._runtime_diagnostics_payload()
        for forbidden in ("sysExecutable", "cwd", "backendRoot", "appResourcesPath", "packagedLogPath"):
            self.assertNotIn(forbidden, payload)
        credential = payload.get("googleServiceAccount") or {}
        for forbidden in ("path", "client_email", "private_key_id"):
            self.assertNotIn(forbidden, credential)
        self.assertIn("clientEmailConfigured", credential)
        self.assertIn("privateKeyIdConfigured", credential)

    def test_config_status_omits_full_path_keys(self):
        payload = asyncio.run(server.get_config_status())
        for forbidden in ("configPathUsed", "defaultsPathUsed", "googleCredentialsPath"):
            self.assertNotIn(forbidden, payload)
        self.assertIn("configFileUsed", payload)
        self.assertIn("defaultsFileUsed", payload)
        self.assertIn("googleCredentialsFile", payload)

    def test_microsoft_form_url_validation_allows_only_trusted_https_hosts(self):
        valid, error = server._validate_microsoft_form_url("https://forms.office.com/pages/responsepage.aspx?id=abc")
        self.assertTrue(valid)
        self.assertEqual(error, "")

        for url in (
            "http://forms.office.com/pages/responsepage.aspx?id=abc",
            "https://example.com/form",
            "javascript:alert(1)",
        ):
            valid, error = server._validate_microsoft_form_url(url)
            self.assertFalse(valid)
            self.assertIn("trusted Microsoft Forms domain", error)

    def test_getipintel_uses_https_endpoint(self):
        provider = server.GetIpIntelProvider()
        response = mock.Mock()
        response.json.return_value = {"status": "success", "result": "0"}
        response.raise_for_status.return_value = None

        with mock.patch.dict(os.environ, {"GETIPINTEL_EMAIL": "tester@example.com"}, clear=False):
            with mock.patch("server.httpx.AsyncClient") as client_cls:
                client_cls.return_value.__aenter__.return_value.get = mock.AsyncMock(return_value=response)
                asyncio.run(provider.lookup("8.8.8.8"))

        called_url = client_cls.return_value.__aenter__.return_value.get.call_args.args[0]
        self.assertEqual(called_url, "https://check.getipintel.net/check.php")

    def test_managed_default_save_does_not_unset_content(self):
        key = "discord_templates"
        update = server.normalize_settings_payload({key: server.DEFAULT_SETTINGS[key]})
        self.assertIn(key, update["$set"])
        self.assertIn(server._managed_custom_flag(key), update["$set"])
        self.assertNotIn(key, update["$unset"])
        self.assertNotIn(server._managed_custom_flag(key), update["$unset"])

    def test_getipintel_skips_without_email_and_no_fallback(self):
        provider = server.GetIpIntelProvider()
        with mock.patch.dict(os.environ, {"GETIPINTEL_EMAIL": ""}, clear=True):
            with mock.patch("server._load_backend_runtime_config", return_value={}):
                with self.assertRaises(RuntimeError) as context:
                    asyncio.run(provider.lookup("8.8.8.8"))
                self.assertIn("missing contact email", str(context.exception))
                self.assertNotIn("blyshawnp", str(context.exception))

    def test_service_account_diagnostics_do_not_expose_secrets(self):
        payload = server._runtime_diagnostics_payload()
        payload_str = str(payload).lower()
        self.assertNotIn("'private_key':", payload_str)
        self.assertNotIn("'private_key_id':", payload_str)
        self.assertNotIn("-----begin private key-----", payload_str)
        self.assertNotIn("raw_credential", payload_str)
        
        # Ensure _public_service_account_file_diagnostics strips paths
        diag = server._public_service_account_file_diagnostics({"activePath": "C:\\Secret\\Path\\google-service-account.json"})
        self.assertEqual(diag.get("activeFile"), "google-service-account.json")
        self.assertNotIn("C:\\Secret", str(diag))

    def test_docs_mention_service_account_packaging_risk(self):
        docs_dir = Path(server.ROOT_DIR).parent / "docs"
        checklist_path = docs_dir / "release-checklist.md"
        risk_path = docs_dir / "service-account-packaging-risk.md"
        
        self.assertTrue(checklist_path.exists())
        self.assertTrue(risk_path.exists())
        
        checklist_content = checklist_path.read_text(encoding="utf-8")
        self.assertIn("google-service-account.json", checklist_content)
        self.assertIn("service-account-packaging-risk", checklist_content)

if __name__ == "__main__":
    unittest.main()

"""Packaged Apps Script transport for Google Sheet operations.

The token and endpoint are deliberately kept out of public status payloads,
logs, exception messages, and object representations.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import quote, quote_plus, urlencode, urlparse
from urllib.request import Request, urlopen


CONFIG_FILENAME = "apps-script-api.json"
PLACEHOLDER_TOKENS = {"TOKEN", "REPLACE_ME", "CHANGE_ME"}


class AppsScriptApiError(RuntimeError):
    """Safe-to-display Apps Script API failure."""


@dataclass(frozen=True)
class AppsScriptApiConfig:
    enabled: bool
    base_url: str = field(repr=False)
    token: str = field(repr=False)
    path: Path = field(repr=False)

    def public_status(self, status="ready", message="Apps Script API is configured."):
        return {
            "ok": status == "ready",
            "enabled": self.enabled,
            "status": status,
            "path": str(self.path),
            "message": message,
        }


def apps_script_config_candidates(root_dir: Path):
    resources_root = (os.getenv("APP_RESOURCES_PATH") or "").strip()
    configured = (os.getenv("APPS_SCRIPT_API_CONFIG_FILE") or "").strip()
    candidates = []
    if configured:
        candidates.append(Path(configured).expanduser())
    if resources_root:
        candidates.append(Path(resources_root) / "backend" / "config" / CONFIG_FILENAME)
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent / "config" / CONFIG_FILENAME)
    candidates.append(Path(root_dir) / "config" / CONFIG_FILENAME)

    seen = set()
    for candidate in candidates:
        key = str(candidate.resolve(strict=False)).lower()
        if key not in seen:
            seen.add(key)
            yield candidate


def _valid_endpoint(value: str):
    parsed = urlparse(value)
    return (
        parsed.scheme == "https"
        and parsed.netloc.lower() == "script.google.com"
        and parsed.path.startswith("/macros/s/")
        and parsed.path.endswith("/exec")
    )


def load_apps_script_api_config(root_dir: Path):
    """Return (config, public status) without exposing endpoint or token."""
    existing_path = next(
        (candidate for candidate in apps_script_config_candidates(root_dir) if candidate.is_file()),
        None,
    )
    if not existing_path:
        return None, {
            "ok": False,
            "enabled": False,
            "status": "missing",
            "path": "",
            "message": "Apps Script API config is missing; using packaged local defaults.",
        }

    try:
        payload = json.loads(existing_path.read_text(encoding="utf-8"))
    except Exception:
        return None, {
            "ok": False,
            "enabled": False,
            "status": "invalid",
            "path": str(existing_path),
            "message": "Apps Script API config is unreadable or invalid; using packaged local defaults.",
        }

    if not isinstance(payload, dict):
        payload = {}
    enabled = payload.get("enabled") is True
    endpoint = str(payload.get("base_url") or "").strip()
    token = str(payload.get("token") or "").strip()
    if not enabled:
        return None, {
            "ok": False,
            "enabled": False,
            "status": "disabled",
            "path": str(existing_path),
            "message": "Apps Script API is disabled; using packaged local defaults.",
        }
    if not _valid_endpoint(endpoint) or not token or token.upper() in PLACEHOLDER_TOKENS:
        return None, {
            "ok": False,
            "enabled": True,
            "status": "invalid",
            "path": str(existing_path),
            "message": "Apps Script API config is incomplete or invalid; using packaged local defaults.",
        }

    config = AppsScriptApiConfig(True, endpoint, token, existing_path)
    return config, config.public_status()


class AppsScriptApiClient:
    def __init__(
        self,
        config: AppsScriptApiConfig,
        *,
        timeout: float = 15.0,
        opener: Callable = urlopen,
    ):
        self._config = config
        self._timeout = timeout
        self._opener = opener

    def __repr__(self):
        return "AppsScriptApiClient(configured=True)"

    def _redact(self, value):
        text = str(value or "")
        if self._config.token:
            for token_form in {
                self._config.token,
                quote(self._config.token, safe=""),
                quote_plus(self._config.token),
            }:
                if token_form:
                    text = text.replace(token_form, "[REDACTED]")
        if self._config.base_url:
            text = text.replace(self._config.base_url, "[configured endpoint]")
        return text

    def request(self, action: str, params: Optional[dict] = None):
        body = json.dumps({
            "action": str(action or "").strip(),
            "token": self._config.token,
            "params": params or {},
        }).encode("utf-8")
        request = Request(
            self._config.base_url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with self._opener(request, timeout=self._timeout) as response:
                raw = response.read().decode("utf-8-sig")
            payload = json.loads(raw)
        except Exception as exc:
            raise AppsScriptApiError(
                f"Apps Script API request failed: {self._redact(exc)}"
            ) from exc

        if not isinstance(payload, dict):
            raise AppsScriptApiError("Apps Script API returned an invalid response.")
        if payload.get("ok") is False:
            message = self._redact(payload.get("error") or payload.get("message") or "Request rejected.")
            raise AppsScriptApiError(f"Apps Script API rejected the request: {message}")
        if "result" in payload:
            return payload.get("result") or {}
        if "data" in payload:
            return payload.get("data") or {}
        return {key: value for key, value in payload.items() if key != "ok"}

    def ping(self):
        return self.get("ping")

    def get(self, action: str, params: Optional[dict] = None):
        query = {"action": str(action or "").strip(), "token": self._config.token}
        for key, value in (params or {}).items():
            if value is not None:
                query[str(key)] = value
        request_url = f"{self._config.base_url}?{urlencode(query)}"
        request = Request(request_url, method="GET")
        return self._read_response(request)

    def post(self, action: str, payload: Optional[dict] = None):
        body_payload = dict(payload or {})
        body_payload["action"] = str(action or "").strip()
        body_payload["token"] = self._config.token
        body = json.dumps(body_payload).encode("utf-8")
        request = Request(
            self._config.base_url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return self._read_response(request)

    def _read_response(self, request: Request):
        try:
            with self._opener(request, timeout=self._timeout) as response:
                raw = response.read().decode("utf-8-sig")
            payload = json.loads(raw)
        except Exception as exc:
            raise AppsScriptApiError(
                f"Apps Script API request failed: {self._redact(exc)}"
            ) from exc

        if not isinstance(payload, dict):
            raise AppsScriptApiError("Apps Script API returned an invalid response.")
        if payload.get("ok") is False:
            message = self._redact(payload.get("error") or payload.get("message") or "Request rejected.")
            raise AppsScriptApiError(f"Apps Script API rejected the request: {message}")
        if "result" in payload:
            return payload.get("result") or {}
        if "data" in payload:
            return payload.get("data") or {}
        return {key: value for key, value in payload.items() if key != "ok"}


class _ExecuteCall:
    def __init__(self, client: AppsScriptApiClient, action: str, params: dict):
        self._client = client
        self._action = action
        self._params = params

    def execute(self):
        return self._client.request(self._action, self._params)


class _ValuesResource:
    def __init__(self, client: AppsScriptApiClient):
        self._client = client

    def get(self, **params):
        return _ExecuteCall(self._client, "spreadsheets.values.get", params)

    def update(self, **params):
        return _ExecuteCall(self._client, "spreadsheets.values.update", params)

    def append(self, **params):
        return _ExecuteCall(self._client, "spreadsheets.values.append", params)


class _SpreadsheetsResource:
    def __init__(self, client: AppsScriptApiClient):
        self._client = client

    def get(self, **params):
        return _ExecuteCall(self._client, "spreadsheets.get", params)

    def batchUpdate(self, **params):
        return _ExecuteCall(self._client, "spreadsheets.batchUpdate", params)

    def values(self):
        return _ValuesResource(self._client)


class AppsScriptSheetsService:
    """Minimal Google Sheets client compatibility layer used by server.py."""

    def __init__(self, client: AppsScriptApiClient):
        self._client = client

    def __repr__(self):
        return "AppsScriptSheetsService(configured=True)"

    def spreadsheets(self):
        return _SpreadsheetsResource(self._client)


def create_apps_script_sheet_service(root_dir: Path, *, opener: Callable = urlopen):
    config, status = load_apps_script_api_config(root_dir)
    if not config:
        return {"ok": False, "status": status}
    client = AppsScriptApiClient(config, opener=opener)
    return {
        "ok": True,
        "service": AppsScriptSheetsService(client),
        "client": client,
        "status": status,
    }

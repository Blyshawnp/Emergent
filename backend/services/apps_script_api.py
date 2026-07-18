"""Packaged Apps Script transport for Google Sheet operations.

The token and endpoint are deliberately kept out of public status payloads,
logs, exception messages, and object representations.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import quote, quote_plus, urlencode, urlparse
from urllib.request import Request, urlopen


CONFIG_FILENAME = "apps-script-api.json"
ROLE_CONFIG_FILENAMES = {
    "mts": "apps-script-api-mts.json",
    "sam": "apps-script-api-sam.json",
}
VALID_ROLES = frozenset(ROLE_CONFIG_FILENAMES)
PLACEHOLDER_TOKENS = {"TOKEN", "REPLACE_ME", "CHANGE_ME"}
logger = logging.getLogger(__name__)


class AppsScriptApiError(RuntimeError):
    """Safe-to-display Apps Script API failure."""


@dataclass(frozen=True)
class AppsScriptApiConfig:
    enabled: bool
    role: str
    base_url: str = field(repr=False)
    token: str = field(repr=False)
    path: Path = field(repr=False)

    def public_status(self, status="ready", message="Apps Script API is configured."):
        return {
            "ok": status == "ready",
            "enabled": self.enabled,
            "role": self.role,
            "status": status,
            "path": str(self.path),
            "message": message,
        }


def _normalize_role(value: str):
    normalized = str(value or "").strip().lower()
    if normalized in {"sam", "notification", "notification-manager"}:
        return "sam"
    if normalized in {"mts", "main"}:
        return "mts"
    return ""


def apps_script_api_role(expected_role: Optional[str] = None):
    explicit = _normalize_role(expected_role)
    if explicit:
        return explicit
    configured = _normalize_role(os.getenv("APPS_SCRIPT_API_ROLE"))
    if configured:
        return configured
    return "sam" if (os.getenv("MTS_NOTIFICATION_MANAGER") or "").strip() == "1" else "mts"


def apps_script_config_candidates(root_dir: Path, expected_role: Optional[str] = None):
    role = apps_script_api_role(expected_role)
    resources_root = (os.getenv("APP_RESOURCES_PATH") or "").strip()
    configured = (os.getenv("APPS_SCRIPT_API_CONFIG_FILE") or "").strip()
    candidates = []
    if configured:
        candidates.append(Path(configured).expanduser())
    if resources_root:
        candidates.append(Path(resources_root) / "backend" / "config" / CONFIG_FILENAME)
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent / "config" / CONFIG_FILENAME)
    candidates.append(Path(root_dir) / "config" / ROLE_CONFIG_FILENAMES[role])
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


def _endpoint_host(value: str):
    parsed = urlparse(value or "")
    return parsed.netloc if parsed.netloc else ""


def _log_config_status(path, *, enabled, role="", endpoint="", token_present=False, status=""):
    logger.info(
        "[APPS-SCRIPT] config_path=%s enabled=%s role=%s base_url_host=%s token_present=%s status=%s",
        str(path or ""),
        bool(enabled),
        str(role or ""),
        _endpoint_host(endpoint),
        bool(token_present),
        str(status or ""),
    )


def load_apps_script_api_config(root_dir: Path, *, expected_role: Optional[str] = None):
    """Return (config, public status) without exposing endpoint or token."""
    role = apps_script_api_role(expected_role)
    existing_path = next(
        (candidate for candidate in apps_script_config_candidates(root_dir, role) if candidate.is_file()),
        None,
    )
    if not existing_path:
        _log_config_status("", enabled=False, role=role, status="missing")
        return None, {
            "ok": False,
            "enabled": False,
            "role": role,
            "status": "missing",
            "path": "",
            "message": "Apps Script API config is missing; using packaged local defaults.",
        }

    try:
        payload = json.loads(existing_path.read_text(encoding="utf-8"))
    except Exception:
        _log_config_status(existing_path, enabled=False, role=role, status="invalid")
        return None, {
            "ok": False,
            "enabled": False,
            "role": role,
            "status": "invalid",
            "path": str(existing_path),
            "message": "Apps Script API config is unreadable or invalid; using packaged local defaults.",
        }

    if not isinstance(payload, dict):
        payload = {}
    enabled = payload.get("enabled") is True
    endpoint = str(payload.get("base_url") or "").strip()
    token = str(payload.get("token") or "").strip()
    declared_role = _normalize_role(payload.get("role"))
    if not declared_role and role == "mts":
        declared_role = "mts"
    if declared_role != role:
        _log_config_status(
            existing_path,
            enabled=enabled,
            role=role,
            endpoint=endpoint,
            token_present=bool(token),
            status="role_mismatch",
        )
        return None, {
            "ok": False,
            "enabled": enabled,
            "role": role,
            "status": "role_mismatch",
            "path": str(existing_path),
            "message": "Apps Script API config role does not match this application; using packaged local defaults.",
        }
    if not enabled:
        _log_config_status(existing_path, enabled=False, role=role, endpoint=endpoint, token_present=bool(token), status="disabled")
        return None, {
            "ok": False,
            "enabled": False,
            "role": role,
            "status": "disabled",
            "path": str(existing_path),
            "message": "Apps Script API is disabled; using packaged local defaults.",
        }
    if not _valid_endpoint(endpoint) or not token or token.upper() in PLACEHOLDER_TOKENS:
        _log_config_status(existing_path, enabled=True, role=role, endpoint=endpoint, token_present=bool(token), status="invalid")
        return None, {
            "ok": False,
            "enabled": True,
            "role": role,
            "status": "invalid",
            "path": str(existing_path),
            "message": "Apps Script API config is incomplete or invalid; using packaged local defaults.",
        }

    config = AppsScriptApiConfig(True, role, endpoint, token, existing_path)
    _log_config_status(existing_path, enabled=True, role=role, endpoint=endpoint, token_present=True, status="ready")
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
        action = str(action or "").strip()
        body = json.dumps({
            "action": action,
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
            logger.warning("[APPS-SCRIPT] action=%s response=error error=%s", action, self._redact(exc))
            raise AppsScriptApiError(
                f"Apps Script API request failed: {self._redact(exc)}"
            ) from exc

        if not isinstance(payload, dict):
            logger.warning("[APPS-SCRIPT] action=%s response=error error=invalid_response", action)
            raise AppsScriptApiError("Apps Script API returned an invalid response.")
        if payload.get("ok") is False:
            message = self._redact(payload.get("error") or payload.get("message") or "Request rejected.")
            logger.warning("[APPS-SCRIPT] action=%s response=error error=%s", action, message)
            raise AppsScriptApiError(f"Apps Script API rejected the request: {message}")
        logger.info("[APPS-SCRIPT] action=%s response=ok", action)
        if "result" in payload:
            return payload.get("result") or {}
        if "data" in payload:
            return payload.get("data") or {}
        return {key: value for key, value in payload.items() if key != "ok"}

    def ping(self):
        return self.get("ping")

    def get(self, action: str, params: Optional[dict] = None):
        action = str(action or "").strip()
        query = {"action": action, "token": self._config.token}
        for key, value in (params or {}).items():
            if value is not None:
                query[str(key)] = json.dumps(value, separators=(",", ":")) if isinstance(value, (dict, list)) else value
        request_url = f"{self._config.base_url}?{urlencode(query)}"
        request = Request(request_url, method="GET")
        return self._read_response(request, action)

    def post(self, action: str, payload: Optional[dict] = None):
        action = str(action or "").strip()
        body_payload = dict(payload or {})
        body_payload["action"] = action
        body_payload["token"] = self._config.token
        body = json.dumps(body_payload).encode("utf-8")
        request = Request(
            self._config.base_url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return self._read_response(request, action)

    def _read_response(self, request: Request, action: str):
        try:
            with self._opener(request, timeout=self._timeout) as response:
                raw = response.read().decode("utf-8-sig")
            payload = json.loads(raw)
        except Exception as exc:
            logger.warning("[APPS-SCRIPT] action=%s response=error error=%s", action, self._redact(exc))
            raise AppsScriptApiError(
                f"Apps Script API request failed: {self._redact(exc)}"
            ) from exc

        if not isinstance(payload, dict):
            logger.warning("[APPS-SCRIPT] action=%s response=error error=invalid_response", action)
            raise AppsScriptApiError("Apps Script API returned an invalid response.")
        if payload.get("ok") is False:
            message = self._redact(payload.get("error") or payload.get("message") or "Request rejected.")
            logger.warning("[APPS-SCRIPT] action=%s response=error error=%s", action, message)
            raise AppsScriptApiError(f"Apps Script API rejected the request: {message}")
        logger.info("[APPS-SCRIPT] action=%s response=ok", action)
        if "result" in payload:
            return payload.get("result") or {}
        if "data" in payload:
            return payload.get("data") or {}
        return {key: value for key, value in payload.items() if key != "ok"}


class _ExecuteCall:
    def __init__(self, client: AppsScriptApiClient, action: str, params: dict, method: str):
        self._client = client
        self._action = action
        self._params = params
        self._method = method

    def execute(self):
        if self._method == "GET":
            res = self._client.get(self._action, self._params)
        elif self._method == "POST":
            res = self._client.post(self._action, self._params)
        else:
            raise AppsScriptApiError(
                f"Apps Script compatibility route is unavailable for method {self._method}."
            )
        if self._action in ("getSettings", "getNotificationRecipients"):
            if isinstance(res, dict) and "rows" in res:
                rows = res["rows"]
                if not isinstance(rows, list):
                    rows = []
                values = []
                if rows:
                    headers = list(rows[0].keys())
                    values.append(headers)
                    for r in rows:
                        values.append([r.get(h, "") for h in headers])
                res["values"] = values
        return res


def _without_spreadsheet_id(params: dict):
    return {
        key: value
        for key, value in (params or {}).items()
        if key != "spreadsheetId"
    }


def _write_payload(params: dict):
    payload = _without_spreadsheet_id(params)
    body = payload.pop("body", None)
    if isinstance(body, dict):
        payload.update(body)
    return payload


class _ValuesResource:
    def __init__(self, client: AppsScriptApiClient):
        self._client = client

    def get(self, **params):
        r = str(params.get("range") or "").strip().replace("'", "").replace('"', "")
        if r.startswith("settings") or "settings" in r.lower():
            return _ExecuteCall(self._client, "getSettings", _without_spreadsheet_id(params), "GET")
        if r.startswith("notification-recipients") or "notification-recipients" in r.lower():
            return _ExecuteCall(self._client, "getNotificationRecipients", _without_spreadsheet_id(params), "GET")
        return _ExecuteCall(self._client, "getSheetRange", _without_spreadsheet_id(params), "GET")

    def update(self, **params):
        return _ExecuteCall(self._client, "updateSheetRange", _write_payload(params), "POST")

    def append(self, **params):
        return _ExecuteCall(self._client, "appendSheetRows", _write_payload(params), "POST")

    def batchGet(self, **params):
        return _ExecuteCall(self._client, "batchGetSheetRanges", _without_spreadsheet_id(params), "GET")

    def batchUpdate(self, **params):
        return _ExecuteCall(self._client, "batchUpdateSheetRanges", _write_payload(params), "POST")


class _SpreadsheetsResource:
    def __init__(self, client: AppsScriptApiClient):
        self._client = client

    def get(self, **params):
        return _ExecuteCall(self._client, "getSheetMetadata", _without_spreadsheet_id(params), "GET")

    def batchUpdate(self, **params):
        return _ExecuteCall(self._client, "batchUpdateSpreadsheet", _write_payload(params), "POST")

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


def create_apps_script_sheet_service(
    root_dir: Path,
    *,
    opener: Callable = urlopen,
    expected_role: Optional[str] = None,
):
    config, status = load_apps_script_api_config(root_dir, expected_role=expected_role)
    if not config:
        return {"ok": False, "status": status}
    client = AppsScriptApiClient(config, opener=opener)
    return {
        "ok": True,
        "service": AppsScriptSheetsService(client),
        "client": client,
        "status": status,
    }

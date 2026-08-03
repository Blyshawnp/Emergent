from __future__ import annotations

import json
import time
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from .base import DataProvider, ProviderHealth, RESOURCE_TABLES


class SupabaseProviderError(RuntimeError):
    """A redacted Supabase provider failure."""


class SupabaseDataProvider(DataProvider):
    name = "supabase"

    def __init__(self, url: str, service_role_key: str, *, timeout: float = 10.0, retries: int = 2):
        self._url = str(url or "").rstrip("/")
        self._key = str(service_role_key or "")
        self._timeout = max(1.0, float(timeout))
        self._retries = max(0, int(retries))
        if not self._url.startswith("https://") or not self._key:
            raise ValueError("Supabase backend configuration is incomplete")

    def __repr__(self) -> str:
        return "SupabaseDataProvider(configured=True)"

    def _request(self, path: str, *, query: Mapping[str, Any] | None = None, method="GET", body=None, prefer=None):
        url = f"{self._url}/rest/v1/{quote(path, safe='')}"
        if query:
            url += "?" + urlencode({str(k): str(v) for k, v in query.items()})
        headers = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            "Accept": "application/json",
            "Accept-Profile": "mts_sam",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        if method in ("POST", "PATCH", "DELETE") or body is not None:
            headers["Content-Profile"] = "mts_sam"
        if prefer:
            headers["Prefer"] = prefer
        encoded_body = json.dumps(body, separators=(",", ":"), default=str).encode("utf-8") if body is not None else None
        request = Request(url, method=method, headers=headers, data=encoded_body)
        for attempt in range(self._retries + 1):
            try:
                with urlopen(request, timeout=self._timeout) as response:
                    return json.loads(response.read().decode("utf-8-sig"))
            except HTTPError as exc:
                try:
                    err_body = exc.read().decode("utf-8-sig")
                except Exception:
                    err_body = "Unable to read error body"
                if exc.code < 500 or attempt >= self._retries:
                    raise SupabaseProviderError(f"Supabase request failed with HTTP {exc.code}: {err_body}") from exc
            except (TimeoutError, URLError) as exc:
                if attempt >= self._retries:
                    raise SupabaseProviderError("Supabase request timed out or was unavailable") from exc
            time.sleep(0.15 * (2**attempt))
        raise SupabaseProviderError("Supabase request failed")

    def upsert_rows(self, table: str, rows, *, on_conflict: str, resolution: str = "merge-duplicates"):
        ALLOWED_WRITE_TABLES = {
            "import_batches", "import_staging_rows", "import_row_results", "reconciliation_results",
            "app_users", "app_roles", "user_role_assignments", "application_settings", "sync_state",
            "audit_events", "data_source_lineage", "candidates", "candidate_sessions", "session_attempts",
            "candidate_status_actions", "candidate_corrections", "extra_attempt_grants", "supervisor_transfers",
            "newbie_shift_requests", "newbie_shift_reschedules", "headset_catalog", "headset_reviews",
            "headset_review_actions", "pending_requests", "notifications", "notification_deliveries",
            "activity_events", "synchronization_events"
        }
        if table not in ALLOWED_WRITE_TABLES:
            raise ValueError(f"Unsupported Supabase write table: {table}")
        if not rows:
            return []
        if table == "data_source_lineage":
            resolution = "ignore-duplicates"
        result = self._request(
            table,
            query={"on_conflict": on_conflict},
            method="POST",
            body=list(rows),
            prefer=f"resolution={resolution},return=representation",
        )
        if not isinstance(result, list):
            raise SupabaseProviderError("Supabase returned an invalid upsert response")
        return result

    def delete_rows(self, table: str, query_params: Mapping[str, Any], *, max_expected: int | None = None) -> int:
        ALLOWED_DELETE_TABLES = {
            "import_batches", "import_staging_rows", "import_row_results", "reconciliation_results",
            "app_users", "app_roles", "user_role_assignments", "application_settings", "sync_state",
            "audit_events", "data_source_lineage", "candidates", "candidate_sessions", "session_attempts",
            "candidate_status_actions", "candidate_corrections", "extra_attempt_grants", "supervisor_transfers",
            "newbie_shift_requests", "newbie_shift_reschedules", "headset_catalog", "headset_reviews",
            "headset_review_actions", "pending_requests", "notifications", "notification_deliveries",
            "activity_events", "synchronization_events"
        }
        if table not in ALLOWED_DELETE_TABLES:
            raise ValueError(f"Unsupported Supabase delete table: {table}")
        if not query_params:
            raise ValueError("Empty delete query filters are rejected to prevent broad deletions")
        try:
            result = self._request(
                table,
                query=query_params,
                method="DELETE",
                prefer="return=representation"
            )
        except Exception as exc:
            raise SupabaseProviderError(f"Supabase delete failed on {table}: {exc}") from exc
        if not isinstance(result, list):
            raise SupabaseProviderError(f"Supabase delete returned invalid response format for {table}")
        deleted_count = len(result)
        if max_expected is not None and deleted_count > max_expected:
            raise SupabaseProviderError(
                f"Delete safety check failed: deleted {deleted_count} rows, which exceeds max expected of {max_expected}"
            )
        return deleted_count

    def health(self) -> ProviderHealth:
        try:
            self._request("sync_state", query={"select": "provider", "limit": 1})
            return ProviderHealth(True, self.name, "ready")
        except SupabaseProviderError as exc:
            return ProviderHealth(False, self.name, str(exc))

    def list_resource(self, resource, *, filters=None, limit=1000, offset=0):
        table = RESOURCE_TABLES.get(str(resource))
        if not table:
            raise ValueError(f"Unsupported canonical resource: {resource}")
        if limit < 1 or limit > 5000 or offset < 0:
            raise ValueError("Invalid pagination")
        query = {"select": "*", "limit": limit, "offset": offset}
        for key, value in (filters or {}).items():
            if not str(key).replace("_", "").isalnum():
                raise ValueError("Invalid filter field")
            query[str(key)] = f"eq.{value}"
        result = self._request(table, query=query)
        if not isinstance(result, list):
            raise SupabaseProviderError("Supabase returned an invalid resource response")
        return result

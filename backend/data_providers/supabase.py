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
                if exc.code < 500 or attempt >= self._retries:
                    raise SupabaseProviderError(f"Supabase request failed with HTTP {exc.code}") from exc
            except (TimeoutError, URLError) as exc:
                if attempt >= self._retries:
                    raise SupabaseProviderError("Supabase request timed out or was unavailable") from exc
            time.sleep(0.15 * (2**attempt))
        raise SupabaseProviderError("Supabase request failed")

    def upsert_rows(self, table: str, rows, *, on_conflict: str):
        if table not in set(RESOURCE_TABLES.values()) | {
            "import_batches", "import_staging_rows", "import_row_results", "reconciliation_results"
        }:
            raise ValueError("Unsupported Supabase write table")
        if not rows:
            return []
        result = self._request(
            table,
            query={"on_conflict": on_conflict},
            method="POST",
            body=list(rows),
            prefer="resolution=merge-duplicates,return=representation",
        )
        if not isinstance(result, list):
            raise SupabaseProviderError("Supabase returned an invalid upsert response")
        return result

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

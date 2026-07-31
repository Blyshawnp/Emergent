from __future__ import annotations

import hashlib
import json
import logging

from .base import DataProvider, ProviderHealth

logger = logging.getLogger(__name__)


def _aggregate_digest(rows) -> str:
    normalized = [json.dumps(row, sort_keys=True, separators=(",", ":"), default=str) for row in rows]
    return hashlib.sha256("\n".join(sorted(normalized)).encode("utf-8")).hexdigest()


class ShadowCompareDataProvider(DataProvider):
    name = "shadow_compare"

    def __init__(self, primary: DataProvider, shadow: DataProvider):
        self._primary = primary
        self._shadow = shadow

    def health(self) -> ProviderHealth:
        primary = self._primary.health()
        return ProviderHealth(primary.ok, self.name, f"primary={primary.provider}:{primary.detail}")

    def list_resource(self, resource, *, filters=None, limit=1000, offset=0):
        primary_rows = self._primary.list_resource(resource, filters=filters, limit=limit, offset=offset)
        try:
            shadow_rows = self._shadow.list_resource(resource, filters=filters, limit=limit, offset=offset)
            mismatch = len(primary_rows) != len(shadow_rows) or _aggregate_digest(primary_rows) != _aggregate_digest(shadow_rows)
            logger.info(
                "[DATA-SHADOW] resource=%s primary_count=%s shadow_count=%s mismatch=%s",
                resource, len(primary_rows), len(shadow_rows), mismatch,
            )
        except Exception as exc:
            logger.warning("[DATA-SHADOW] resource=%s comparison_failed=%s", resource, exc.__class__.__name__)
        return primary_rows

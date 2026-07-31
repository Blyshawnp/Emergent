from __future__ import annotations

from .base import DataProvider, ProviderHealth


SHEET_ACTIONS = {
    "candidate_sessions": "getCandidateTracking",
    "candidate_tracking": "getCandidateTracking",
    "headset_catalog": "getHeadsets",
    "headset_reviews": "getHeadsetReviewLog",
    "pending_requests": "getPendingRequests",
    "notifications": "getAlerts",
    "history": "getCandidateTracking",
    "recent_activity": "getPendingRequests",
}


class SheetsDataProvider(DataProvider):
    name = "sheets"

    def __init__(self, client):
        self._client = client

    def health(self) -> ProviderHealth:
        try:
            self._client.get("ping")
            return ProviderHealth(True, self.name, "ready")
        except Exception:
            return ProviderHealth(False, self.name, "Apps Script provider unavailable")

    def list_resource(self, resource, *, filters=None, limit=1000, offset=0):
        action = SHEET_ACTIONS.get(str(resource))
        if not action:
            raise ValueError(f"Sheets resource adapter is not yet available: {resource}")
        result = self._client.get(action, dict(filters or {}))
        rows = result.get("rows", result) if isinstance(result, dict) else result
        if not isinstance(rows, list):
            return []
        return rows[offset:offset + limit]

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Mapping, Sequence


RESOURCE_TABLES = {
    "candidates": "candidates",
    "candidate_sessions": "candidate_sessions",
    "session_attempts": "session_attempts",
    "authoritative_candidate_status": "current_candidate_status_view",
    "candidate_tracking": "candidate_history_view",
    "headset_catalog": "headset_catalog",
    "headset_reviews": "headset_reviews",
    "pending_requests": "pending_requests_view",
    "supervisor_transfers": "supervisor_transfers",
    "newbie_shift_requests": "newbie_shift_requests",
    "newbie_shifts": "newbie_shift_requests",
    "candidate_corrections": "candidate_corrections",
    "status_actions": "candidate_status_actions",
    "extra_attempts": "extra_attempt_grants",
    "notifications": "notifications",
    "history": "candidate_sessions",
    "recent_activity": "recent_activity_view",
}


@dataclass(frozen=True)
class ProviderHealth:
    ok: bool
    provider: str
    detail: str = ""


class DataProvider(ABC):
    name: str

    @abstractmethod
    def health(self) -> ProviderHealth:
        raise NotImplementedError

    @abstractmethod
    def list_resource(
        self,
        resource: str,
        *,
        filters: Mapping[str, Any] | None = None,
        limit: int = 1000,
        offset: int = 0,
    ) -> Sequence[Mapping[str, Any]]:
        raise NotImplementedError

from __future__ import annotations

import datetime
import hashlib
import json
import random
import re
import time
import uuid

from .base import DataProvider, ProviderHealth


RESOURCE_ACTIONS = {domain: "batchGetSheetRanges" for domain in (
    "candidates", "candidate_sessions", "session_attempts",
    "authoritative_candidate_status", "candidate_tracking", "history",
    "headset_catalog", "headset_reviews", "supervisor_transfers",
    "newbie_shift_requests", "candidate_corrections", "pending_requests",
    "recent_activity", "notifications",
)}

SNAPSHOT_TABS = (
    "Candidate Sessions",
    "Pending Sup Transfers",
    "headsets",
    "headset-review-log",
    "newbie-shift-requests",
    "candidate-deletion-requests",
    "candidate-information-correction-requests",
    "sam-notifications",
)

SNAPSHOT_ACTIONS = ((
    "batchGetSheetRanges",
    {"ranges": json.dumps([f"'{title}'!A:ZZ" for title in SNAPSHOT_TABS])},
),)


def _text(value):
    return re.sub(r"\s+", " ", str(value or "").strip())


def _truthy(value):
    return str(value or "").strip().casefold() in {"true", "yes", "y", "1", "enabled", "approved"}


def _authoritative_status(row):
    def normalized(value):
        text = re.sub(r"[\u2013\u2014_-]+", " ", str(value or "").strip().upper())
        return re.sub(r"\s+", " ", text).strip()

    def public(value, final=False):
        value = normalized(value)
        if value in {"PASS", "PASSED", "RESUMED PASS"}:
            return "Pass"
        if value in {"FAIL FINAL ATTEMPT", "FAILED FINAL ATTEMPT"} or final:
            return "FAIL-Final Attempt"
        if value in {"FAIL", "FAILED"}:
            return "Fail"
        if value in {"WITHDREW FROM CERTIFICATION", "WITHDRAWN"}:
            return "WITHDREW FROM CERTIFICATION"
        if value in {"ARCHIVED", "REMOVED", "DELETED"}:
            return value
        if value in {"INCOMPLETE", "PENDING", "IN PROGRESS"}:
            return "INCOMPLETE"
        return str(value or "").strip()

    override = row.get("readiness_override_result") if _truthy(row.get("readiness_override_applied")) else ""
    if normalized(override) in {"PASS", "PASSED", "FAIL", "FAILED", "FAIL FINAL ATTEMPT", "FAILED FINAL ATTEMPT"}:
        return public(override, "FINAL ATTEMPT" in normalized(override))
    final_result = normalized(row.get("final_result"))
    if final_result in {"FAIL", "FAILED", "FAIL FINAL ATTEMPT", "FAILED FINAL ATTEMPT"}:
        return public(final_result, "FINAL ATTEMPT" in final_result)
    status = normalized(row.get("status") or row.get("latest_status"))
    if status in {"FAIL FINAL ATTEMPT", "FAILED FINAL ATTEMPT"}:
        return "FAIL-Final Attempt"
    failed_calls = sum(
        normalized(row.get(f"call_{index}_result")) in {"FAIL", "FAILED"}
        for index in (1, 2, 3)
    )
    failed_transfers = sum(
        normalized(row.get(f"sup_transfer_{index}_result")) in {"FAIL", "FAILED"}
        for index in (1, 2)
    )
    if _truthy(row.get("final_attempt")) and (failed_calls >= 2 or failed_transfers >= 2):
        return "FAIL-Final Attempt"
    if status in {"FAIL", "FAILED"}:
        return "Fail"
    if final_result in {"PASS", "PASSED", "RESUMED PASS"}:
        return public(final_result)
    return public(status or row.get("calculated_result")) or "INCOMPLETE"


def _tracking_category(row):
    if _truthy(row.get("archived")):
        return "archived"
    if _truthy(row.get("needs_sup_transfer")):
        return "pending_supervisor_transfer"
    request_status = str(row.get("newbie_shift_request_status") or "").strip().casefold()
    if request_status == "pending":
        return "newbie_shift"
    status = _authoritative_status(row).upper()
    if status == "FAIL-FINAL ATTEMPT":
        return "failed_final_attempt"
    if status in {"FAIL", "FAILED"}:
        return "failed_not_final"
    if status in {"PASS", "PASSED", "RESUMED-PASS"}:
        return "passed"
    if status == "WITHDREW FROM CERTIFICATION":
        return "withdrawn"
    return "incomplete"


def _deterministic_uuid(namespace, value):
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"mts-sam:{namespace}:{value}"))


def _stable_session_identity(row):
    """Return the persisted session/history identity hierarchy, never a name."""
    return _text(
        row.get("session_id")
        or row.get("history_id")
        or row.get("resume_source_history_id")
        or row.get("source_session_id")
    )


def _combine_datetime(date_value, time_value):
    date_text = str(date_value or "").strip()
    time_text = str(time_value or "").strip()
    if not date_text:
        return None
    date_part = re.split(r"[Tt]", date_text, maxsplit=1)[0]
    if not time_text:
        return date_text
    time_parts = re.split(r"[Tt]", time_text, maxsplit=1)
    time_part = time_parts[1] if len(time_parts) == 2 else time_parts[0]
    return f"{date_part}T{time_part}"


class SheetsDataProvider(DataProvider):
    name = "sheets"
    stable_identity_resolution_required = True

    def __init__(self, client, *, max_retries=4, base_delay=1.0):
        self._client = client
        self._max_retries = max(0, int(max_retries))
        self._base_delay = max(0.0, float(base_delay))
        self._snapshot = None
        self._snapshot_errors = {}
        self._tabs = {}
        self.snapshot_metadata = {}

    def health(self) -> ProviderHealth:
        try:
            self._client.get("ping")
            return ProviderHealth(True, self.name, "ready")
        except Exception:
            return ProviderHealth(False, self.name, "Apps Script provider unavailable")

    def _fetch_action(self, action, params):
        retries = 0
        for attempt in range(self._max_retries + 1):
            try:
                return self._client.get(action, dict(params)), retries
            except Exception as exc:
                text = str(exc).casefold()
                retryable = any(token in text for token in ("429", "quota", "rate", "timeout", "temporarily"))
                if not retryable or attempt >= self._max_retries:
                    raise
                retries += 1
                retry_after = 0.0
                headers = getattr(exc, "headers", None)
                if headers:
                    try:
                        retry_after = min(float(headers.get("Retry-After", 0) or 0), 60.0)
                    except (TypeError, ValueError):
                        retry_after = 0.0
                wait = retry_after or (self._base_delay * (2 ** attempt) + random.uniform(0, 0.5))
                time.sleep(min(wait, 60.0))
        raise RuntimeError("sheets_snapshot_retry_exhausted")

    def _ensure_snapshot(self):
        if self._snapshot is not None:
            return
        fetched = {}
        errors = {}
        retry_count = 0
        for action, params in SNAPSHOT_ACTIONS:
            try:
                fetched[action], retries = self._fetch_action(action, params)
                retry_count += retries
            except Exception as exc:
                errors[action] = "sheets_quota_exhausted" if any(
                    token in str(exc).casefold() for token in ("429", "quota", "rate")
                ) else "sheets_network_error"
        self._snapshot = fetched
        self._snapshot_errors = errors
        batch = fetched.get("batchGetSheetRanges") or {}
        value_ranges = batch.get("valueRanges") if isinstance(batch, dict) else None
        if not errors and (not isinstance(value_ranges, list) or len(value_ranges) != len(SNAPSHOT_TABS)):
            self._snapshot_errors["batchGetSheetRanges"] = "schema_mismatch"
            value_ranges = []
        for title, value_range in zip(SNAPSHOT_TABS, value_ranges or []):
            values = value_range.get("values", []) if isinstance(value_range, dict) else []
            headers = [str(value).strip() for value in (values[0] if values else [])]
            while headers and not headers[-1]:
                headers.pop()
            rows = []
            for raw in values[1:]:
                if not any(str(value).strip() for value in raw):
                    continue
                rows.append({
                    header: raw[index] if index < len(raw) else ""
                    for index, header in enumerate(headers) if header
                })
            self._tabs[title] = rows
        safe_manifest = {
            title: {
                "row_count": len(rows),
                "content_checksum": hashlib.sha256(
                    json.dumps(rows, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
                ).hexdigest(),
            }
            for title, rows in self._tabs.items()
        }
        timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
        self.snapshot_metadata = {
            "timestamp": timestamp,
            "checksum": hashlib.sha256(
                json.dumps(safe_manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest(),
            "fetch_count": len(SNAPSHOT_ACTIONS),
            "retry_count": retry_count,
            "tab_counts": {title: details["row_count"] for title, details in safe_manifest.items()},
            "source_row_count": sum(details["row_count"] for details in safe_manifest.values()),
            "errors": dict(self._snapshot_errors),
        }

    def _tab_rows(self, title):
        self._ensure_snapshot()
        if self._snapshot_errors:
            raise RuntimeError(next(iter(self._snapshot_errors.values())))
        if title not in self._tabs:
            raise RuntimeError("schema_mismatch")
        return [dict(row) for row in self._tabs[title]]

    def _candidate_rows(self):
        return self._tab_rows("Candidate Sessions")

    def _request_rows(self):
        rows = []
        for source_tab in (
            "newbie-shift-requests",
            "candidate-deletion-requests",
            "candidate-information-correction-requests",
        ):
            for raw in self._tab_rows(source_tab):
                request_type = raw.get("request_type") or (
                    "candidate_deletion" if source_tab == "candidate-deletion-requests"
                    else "candidate_information_correction" if source_tab == "candidate-information-correction-requests"
                    else "initial_newbie_shift"
                )
                rows.append({
                    **raw,
                    "request_id": _text(raw.get("request_id")),
                    "request_type": _text(request_type).casefold(),
                    "source_session_id": _text(raw.get("session_id") or raw.get("source_session_id")),
                    "candidate": _text(raw.get("candidate_name") or raw.get("candidate")),
                    "tester": _text(raw.get("tester_name") or raw.get("tester")),
                    "status": _text(raw.get("request_status") or raw.get("status") or "pending").casefold(),
                    "created_at": raw.get("request_created_at") or raw.get("created_at"),
                    "decision_at": raw.get("admin_decision_at"),
                    "decision_by": raw.get("admin_decision_by"),
                    "source_tab": source_tab,
                })
        return [row for row in rows if row.get("request_id")]

    def _project(self, resource):
        if resource == "candidate_sessions":
            return [{
                **row,
                "session_id": _stable_session_identity(row),
                # Candidate identity is resolved by the shared reconciliation-aware
                # comparison layer. Never synthesize it from a display name here.
                "persisted_candidate_id": _text(row.get("candidate_id")),
                "candidate_id": _text(row.get("candidate_id")),
                "authoritative_status": _authoritative_status(row),
                "category": _tracking_category(row),
            } for row in self._candidate_rows()]
        if resource == "candidates":
            projected = []
            for row in self._candidate_rows():
                name = _text(row.get("candidate_name"))
                session_id = _stable_session_identity(row)
                if not name or not session_id:
                    continue
                projected.append({
                    **row,
                    "display_name": name,
                    "source_candidate_id": "",
                    "comparison_source_session_id": session_id,
                    "latest_session_id": session_id,
                    "authoritative_status": _authoritative_status(row),
                    "lineage_identity": "",
                })
            return projected
        if resource == "session_attempts":
            attempts = []
            for row in self._candidate_rows():
                session_id = _stable_session_identity(row)
                if not session_id:
                    continue
                for number, field in ((1, "call_1_result"), (2, "call_2_result"), (3, "call_3_result")):
                    value = row.get(field)
                    if value not in (None, ""):
                        attempts.append({
                            "attempt_key": f"google_sheets:attempt:{session_id}:{number}",
                            "source_action_id": f"google_sheets:attempt:{session_id}:{number}",
                            "source_session_id": session_id,
                            "source_session_uuid": _deterministic_uuid("session", session_id),
                            "attempt_number": number,
                            "attempt_type": "mock_call",
                            "result": value,
                        })
            return attempts
        if resource == "authoritative_candidate_status":
            return [{
                "session_id": _stable_session_identity(row),
                "authoritative_status": _authoritative_status(row),
                "determining_session_id": _stable_session_identity(row),
                "final_attempt": _truthy(row.get("final_attempt")),
                "archived": _truthy(row.get("archived")),
            } for row in self._candidate_rows() if _stable_session_identity(row)]
        if resource in {"candidate_tracking", "history"}:
            projected = []
            for row in self._candidate_rows():
                session_id = _stable_session_identity(row)
                if not session_id:
                    continue
                projected.append({
                    **row,
                    "session_id": session_id,
                    "candidate_id": _text(row.get("candidate_id")),
                    "authoritative_status": _authoritative_status(row),
                    "category": _tracking_category(row),
                })
            return projected
        if resource == "supervisor_transfers":
            rows = self._tab_rows("Pending Sup Transfers")
            return [{
                **row,
                "source_session_uuid": _deterministic_uuid("session", row.get("original_session_id", ""))
                if _text(row.get("original_session_id")) else "",
            } for row in rows if isinstance(row, dict)]
        if resource == "headset_catalog":
            rows = self._tab_rows("headsets")
            return [{
                **row,
                "brand": row.get("Brand"),
                "model": row.get("Model"),
                "status": row.get("Status"),
                "note": row.get("Note"),
                "selectable": str(row.get("Status") or "").strip().casefold() == "approved",
                "archived": str(row.get("Status") or "").strip().casefold() == "archived",
                "deleted": str(row.get("Status") or "").strip().casefold() == "deleted",
            } for row in rows] if isinstance(rows, list) else []
        if resource == "headset_reviews":
            rows = self._tab_rows("headset-review-log")
            valid_sessions = {_stable_session_identity(row) for row in self._candidate_rows()}
            catalog_by_display = {
                _text(f"{row.get('Brand', '')} {row.get('Model', '')}").casefold(): row
                for row in self._tab_rows("headsets")
            }
            return [{
                **row,
                **self._normalize_headset_review(row, catalog_by_display),
                "canonical_session_id": _deterministic_uuid("session", row.get("source_session_id", ""))
                if _text(row.get("source_session_id")) in valid_sessions else "",
            } for row in rows] if isinstance(rows, list) else []
        if resource == "newbie_shift_requests":
            valid_sessions = {_stable_session_identity(row) for row in self._candidate_rows()}
            return [{
                **row,
                "canonical_session_id": _deterministic_uuid("session", row.get("source_session_id", ""))
                if _text(row.get("source_session_id")) in valid_sessions else "",
            } for row in self._request_rows() if row.get("source_tab") == "newbie-shift-requests"]
        if resource == "candidate_corrections":
            candidate_rows = self._candidate_rows()
            valid_sessions = {_stable_session_identity(row) for row in candidate_rows}
            return [{
                **row,
                "canonical_session_id": _deterministic_uuid("session", row.get("source_session_id", ""))
                if _text(row.get("source_session_id")) in valid_sessions else "",
                # Resolved from source_session_id by the comparison identity layer.
                "candidate_id": "",
            } for row in self._request_rows() if row.get("source_tab") == "candidate-information-correction-requests"]
        if resource == "pending_requests":
            return self._request_rows()
        if resource == "recent_activity":
            return [{
                **row,
                "event_key": _text(row.get("request_id")),
                "event_type": _text(row.get("request_type")),
                "source_session_id": _text(row.get("source_session_id")),
                "occurred_at": row.get("updated_at") or row.get("created_at"),
            } for row in self._request_rows() if _text(row.get("request_id"))]
        if resource == "notifications":
            rows = self._tab_rows("sam-notifications")
            return [{
                **row,
                "notification_id": row.get("ID"),
                "notification_type": row.get("Type"),
                "title": row.get("Title"),
                "message": row.get("Message"),
                "enabled": row.get("Enabled"),
                "show_ticker": row.get("ShowTicker"),
                "show_popup": row.get("ShowPopup"),
                "show_banner": row.get("ShowBanner"),
                "persistent": row.get("Persistent"),
                "starts_at": _combine_datetime(row.get("StartDate"), row.get("StartTime")),
                "ends_at": _combine_datetime(row.get("EndDate"), row.get("EndTime")),
                "action_text": row.get("ActionText"),
                "action_url": row.get("ActionURL"),
            } for row in rows] if isinstance(rows, list) else []
        raise ValueError(f"Sheets resource adapter is not available: {resource}")

    @staticmethod
    def _normalize_headset_review(row, catalog_by_display):
        brand = _text(row.get("Brand"))
        model = _text(row.get("Model"))
        if brand:
            return {"brand": brand, "model": model, "normalization_status": "canonical"}
        match = catalog_by_display.get(model.casefold())
        if match:
            return {
                "brand": _text(match.get("Brand")),
                "model": _text(match.get("Model")),
                "normalization_status": "deterministic_catalog_match",
            }
        return {
            "brand": None,
            "model": model,
            "normalization_status": "unresolved_legacy_brand" if model else "invalid",
        }

    def list_resource(self, resource, *, filters=None, limit=1000, offset=0):
        resource = str(resource)
        if resource not in RESOURCE_ACTIONS:
            raise ValueError(f"Sheets resource adapter is not available: {resource}")
        rows = self._project(resource)
        for key, value in (filters or {}).items():
            rows = [row for row in rows if str(row.get(key)) == str(value)]
        return rows[offset:offset + limit]

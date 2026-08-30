from __future__ import annotations

import datetime
import enum
import hashlib
import json
import logging
import os
import re
import threading
import time
import uuid
from collections import deque
from dataclasses import asdict, dataclass
from typing import Any, Callable, Mapping

from .supabase import SupabaseDataProvider

logger = logging.getLogger(__name__)

TRUE_VALUES = frozenset({"1", "true", "yes", "on"})

def _deterministic_uuid(namespace: str, name: str) -> str:
    ns = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
    return str(uuid.uuid5(ns, f"mts-sam:{namespace}:{name}"))

# Explicit allowlist of operational domains eligible for dual-write
DUAL_WRITE_ELIGIBLE_DOMAINS = frozenset({
    "notifications",
    "headset_reviews",
    "candidate_sessions",
    "candidates",
    "session_attempts",
    "supervisor_transfers",
    "newbie_shift_requests",
    "candidate_corrections",
    "pending_requests",
    "candidate_status_actions",
    "extra_attempt_grants",
})

# Explicitly excluded domains (config is admin/import only, auth is separate identity provider)
DUAL_WRITE_EXCLUDED_DOMAINS = frozenset({
    "callers", "call_types", "call_fail_reasons", "supervisor_coaching",
    "supervisor_fail_reasons", "supervisor_reasons", "shows",
    "gemini_coaching_prompt", "gemini_fail_prompt",
    "auth_users", "auth_sessions", "auth_identities", "auth_recovery_records",
})


class DualWriteFailureClass(str, enum.Enum):
    SUCCESS = "SUCCESS"
    DUPLICATE_ALREADY_APPLIED = "DUPLICATE_ALREADY_APPLIED"
    TRANSIENT_FAILURE = "TRANSIENT_FAILURE"
    PERMANENT_VALIDATION_FAILURE = "PERMANENT_VALIDATION_FAILURE"
    AUTHORIZATION_DENIED = "AUTHORIZATION_DENIED"
    PRECONDITION_MISMATCH = "PRECONDITION_MISMATCH"
    CONFLICT = "CONFLICT"
    POST_WRITE_MISMATCH = "POST_WRITE_MISMATCH"
    UNSUPPORTED_DOMAIN = "UNSUPPORTED_DOMAIN"


TABLE_ALLOWED_COLUMNS: dict[str, frozenset[str]] = {
    "candidates": frozenset({"id", "source_system", "source_candidate_id", "display_name", "first_name", "last_initial", "created_at", "updated_at"}),
    "candidate_sessions": frozenset({
        "id", "session_id", "candidate_id", "candidate_name", "candidate_first_name", "candidate_last_initial",
        "tester_name", "session_type", "attempt_number", "current_attempt_number", "allowed_attempt_count",
        "extra_attempts_granted", "final_attempt", "raw_status", "calculated_result", "final_result",
        "readiness_override_applied", "readiness_override_result", "readiness_override_reason", "readiness_override_explanation",
        "withdrawn", "archived", "needs_sup_transfer", "pending_sup_transfer_id", "mock_calls_completed",
        "sup_transfers_completed", "call_results", "supervisor_transfer_results", "coaching_summary", "fail_summary",
        "review_notes", "evaluator_notes_summary", "skills", "final_notes", "headset_brand", "headset_model",
        "headset_usb", "noise_cancel", "environment_checks", "form_fill_status", "form_filled_at", "newbie_shift_number",
        "newbie_shift_data", "deletion_request_data", "created_at", "completed_at", "withdrawn_at", "retention_until",
        "imported_at", "updated_at", "source_checksum", "source_payload",
    }),
    "session_attempts": frozenset({"id", "session_id", "attempt_number", "attempt_type", "result", "occurred_at", "source_action_id", "details"}),
}


@dataclass
class DualWriteResult:
    operation_id: str
    domain: str
    mutation_type: str
    authoritative_success: bool
    authoritative_reference: str = ""
    mirror_attempted: bool = False
    mirror_success: bool = False
    mirror_status: str = "pending"
    verification_success: bool = False
    failure_class: DualWriteFailureClass = DualWriteFailureClass.SUCCESS
    retryable: bool = False
    duration_ms: float = 0.0
    error_message: str = ""
    divergence_recorded: bool = False
    persisted_row_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["failure_class"] = self.failure_class.value
        return data


@dataclass
class DualWriteDivergenceRecord:
    operation_id: str
    domain: str
    mutation_type: str
    authoritative_ref: str
    payload_digest: str
    status: str
    failure_class: DualWriteFailureClass
    retry_count: int
    created_at: str
    last_attempt_at: str
    error_message: str
    actor: str = "system"
    resolved: bool = False

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["failure_class"] = self.failure_class.value
        return data


def is_dual_write_enabled(environ: Mapping[str, str] | None = None) -> bool:
    env = os.environ if environ is None else environ
    return (
        str(env.get("MTS_DATA_PROVIDER", "sheets")).strip().casefold() == "sheets"
        and str(env.get("MTS_DUAL_WRITE_ENABLED", "false")).strip().casefold() in TRUE_VALUES
    )


def active_dual_write_domains(environ: Mapping[str, str] | None = None) -> frozenset[str]:
    env = os.environ if environ is None else environ
    if not is_dual_write_enabled(env):
        return frozenset()
    raw_domains = str(env.get("MTS_DUAL_WRITE_DOMAINS", "")).strip()
    if not raw_domains:
        # If MTS_DUAL_WRITE_DOMAINS is not specified or empty, fail closed (0 domains active)
        return frozenset()
    if raw_domains.strip().casefold() in ("*", "all"):
        return DUAL_WRITE_ELIGIBLE_DOMAINS
    configured = {d.strip().lower() for d in raw_domains.split(",") if d.strip()}
    return frozenset(configured & DUAL_WRITE_ELIGIBLE_DOMAINS)


def is_domain_dual_write_enabled(domain: str, environ: Mapping[str, str] | None = None) -> bool:
    return domain in active_dual_write_domains(environ)


def compute_payload_digest(payload: Mapping[str, Any]) -> str:
    cleaned = {k: v for k, v in payload.items() if not k.startswith("_")}
    raw = json.dumps(cleaned, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def build_operation_id(domain: str, mutation_type: str, business_key: str, payload_digest: str) -> str:
    safe_key = re.sub(r"[^a-zA-Z0-9_-]", "_", str(business_key or "unknown"))
    return f"dw-{domain}-{mutation_type}-{safe_key}-{payload_digest}"


def _normalize_notif_datetime(date_val: Any, time_val: Any) -> str | None:
    if not date_val or str(date_val).strip() == "":
        return None
    d_str = str(date_val).strip()
    if "T" in d_str:
        date_part = d_str.split("T")[0]
    elif "t" in d_str:
        date_part = d_str.split("t")[0]
    else:
        date_part = d_str

    t_str = str(time_val or "").strip()
    hours = 0
    minutes = 0
    seconds = 0
    if t_str:
        if "T" in t_str or "t" in t_str:
            t_sub = (t_str.split("T")[1] if "T" in t_str else t_str.split("t")[1]).replace("Z", "").replace("z", "")
            parts = t_sub.split(":")
            if len(parts) >= 2:
                try:
                    hours = int(parts[0])
                    minutes = int(parts[1])
                    seconds = int(float(parts[2])) if len(parts) >= 3 else 0
                except (ValueError, TypeError):
                    pass
        else:
            match = re.search(r"(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?", t_str, re.IGNORECASE)
            if match:
                h = int(match.group(1))
                m = int(match.group(2))
                s = int(match.group(3)) if match.group(3) else 0
                meridiem = (match.group(4) or "").upper()
                if meridiem == "PM" and h < 12:
                    h += 12
                elif meridiem == "AM" and h == 12:
                    h = 0
                hours, minutes, seconds = h, m, s

    return f"{date_part}T{hours:02d}:{minutes:02d}:{seconds:02d}+00:00"


class DualWriteDivergenceTracker:
    """Thread-safe bounded in-memory tracker for mirror divergences and repair diagnostics."""

    def __init__(self, max_records: int = 500):
        self._lock = threading.Lock()
        self._records: dict[str, DualWriteDivergenceRecord] = {}
        self._ordered_keys = deque(maxlen=max_records)
        self._max_records = max_records
        self._last_failure: dict[str, Any] | None = None

    def record_divergence(
        self,
        *,
        operation_id: str,
        domain: str,
        mutation_type: str,
        authoritative_ref: str,
        payload: Mapping[str, Any],
        failure_class: DualWriteFailureClass,
        error_message: str,
        actor: str = "system",
    ) -> DualWriteDivergenceRecord:
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        digest = compute_payload_digest(payload)
        with self._lock:
            if operation_id in self._records:
                record = self._records[operation_id]
                record.retry_count += 1
                record.last_attempt_at = now
                record.failure_class = failure_class
                record.error_message = error_message
            else:
                record = DualWriteDivergenceRecord(
                    operation_id=operation_id,
                    domain=domain,
                    mutation_type=mutation_type,
                    authoritative_ref=str(authoritative_ref),
                    payload_digest=digest,
                    status="pending_repair",
                    failure_class=failure_class,
                    retry_count=0,
                    created_at=now,
                    last_attempt_at=now,
                    error_message=str(error_message)[:256],
                    actor=actor,
                    resolved=False,
                )
                if len(self._records) >= self._max_records:
                    oldest = self._ordered_keys.popleft()
                    self._records.pop(oldest, None)
                self._records[operation_id] = record
                self._ordered_keys.append(operation_id)
            self._last_failure = record.to_dict()
            return record

    def resolve_divergence(self, operation_id: str) -> bool:
        with self._lock:
            record = self._records.get(operation_id)
            if record:
                record.resolved = True
                record.status = "resolved"
                return True
            return False

    def list_divergences(self, domain: str | None = None, unresolved_only: bool = True) -> list[dict[str, Any]]:
        with self._lock:
            results = []
            for record in self._records.values():
                if domain and record.domain != domain:
                    continue
                if unresolved_only and record.resolved:
                    continue
                results.append(record.to_dict())
            return results

    def pending_count(self) -> int:
        with self._lock:
            return sum(1 for r in self._records.values() if not r.resolved)

    def get_readiness_report(self, environ: Mapping[str, str] | None = None) -> dict[str, Any]:
        with self._lock:
            return {
                "dual_write_implementation_ready": True,
                "dual_write_enabled": is_dual_write_enabled(environ),
                "active_domains": sorted(active_dual_write_domains(environ)),
                "eligible_domains": sorted(DUAL_WRITE_ELIGIBLE_DOMAINS),
                "implemented_domains": sorted(DUAL_WRITE_ELIGIBLE_DOMAINS),
                "tested_domains": sorted(DUAL_WRITE_ELIGIBLE_DOMAINS),
                "blocked_domains": [],
                "excluded_domains": sorted(DUAL_WRITE_EXCLUDED_DOMAINS),
                "pending_divergences": sum(1 for r in self._records.values() if not r.resolved),
                "idempotency_ready": True,
                "repair_tracking_ready": True,
                "last_mirror_failure": self._last_failure,
            }


class DomainDualWriteAdapter:
    """Base contract for domain-specific Supabase mirror transformation and verification."""

    domain: str
    target_table: str
    conflict_key: str

    def extract_business_key(self, payload: Mapping[str, Any]) -> str:
        raise NotImplementedError

    def transform_payload(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def verify_persisted_state(
        self,
        supabase_provider: SupabaseDataProvider,
        business_key: str,
        expected_payload: Mapping[str, Any],
    ) -> bool:
        raise NotImplementedError


class NotificationsAdapter(DomainDualWriteAdapter):
    domain = "notifications"
    target_table = "notifications"
    conflict_key = "notification_id"

    def extract_business_key(self, payload: Mapping[str, Any]) -> str:
        return str(payload.get("ID") or payload.get("notification_id") or payload.get("id") or "")

    def transform_payload(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        notif_id = self.extract_business_key(payload)
        enabled_val = payload.get("Enabled", payload.get("enabled", True))
        if isinstance(enabled_val, str):
            enabled = enabled_val.strip().lower() in TRUE_VALUES
        else:
            enabled = bool(enabled_val)

        raw_start_date = payload.get("StartDate") or payload.get("start_date") or ""
        raw_start_time = payload.get("StartTime") or payload.get("start_time") or ""
        raw_end_date = payload.get("EndDate") or payload.get("end_date") or ""
        raw_end_time = payload.get("EndTime") or payload.get("end_time") or ""

        has_expiration = bool(str(raw_end_date or "").strip())
        starts_at = _normalize_notif_datetime(raw_start_date, raw_start_time)
        ends_at = _normalize_notif_datetime(raw_end_date, raw_end_time) if has_expiration else None

        checksum = hashlib.sha256(
            json.dumps(dict(payload), sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
        ).hexdigest()
        created_at_raw = payload.get("CreatedAt") or payload.get("created_at") or None

        return {
            "notification_id": notif_id,
            "enabled": enabled,
            "notification_type": str(payload.get("Type") or payload.get("notification_type") or "info").lower(),
            "title": str(payload.get("Title") or payload.get("title") or "Notification"),
            "message": str(payload.get("Message") or payload.get("message") or ""),
            "show_ticker": bool(payload.get("ShowTicker", payload.get("show_ticker", False))),
            "show_popup": bool(payload.get("ShowPopup", payload.get("show_popup", False))),
            "show_banner": bool(payload.get("ShowBanner", payload.get("show_banner", False))),
            "persistent": bool(payload.get("Persistent", payload.get("persistent", False))),
            "action_text": str(payload.get("ActionText") or payload.get("action_text") or ""),
            "action_url": str(payload.get("ActionURL") or payload.get("action_url") or ""),
            "starts_at": starts_at,
            "ends_at": ends_at,
            "created_at": created_at_raw or datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "source_checksum": checksum,
            "source_payload": dict(payload),
        }

    def verify_persisted_state(
        self,
        supabase_provider: SupabaseDataProvider,
        business_key: str,
        expected_payload: Mapping[str, Any],
    ) -> bool:
        rows = supabase_provider.list_resource("notifications", filters={"notification_id": business_key})
        if not rows:
            return False
        row = rows[0]
        if row.get("enabled") != expected_payload.get("enabled"):
            return False
        if str(row.get("title") or "").strip() != str(expected_payload.get("title") or "").strip():
            return False
        if str(row.get("message") or "").strip() != str(expected_payload.get("message") or "").strip():
            return False
        if expected_payload.get("ends_at") is None and row.get("ends_at") is not None:
            return False
        return True


class HeadsetReviewsAdapter(DomainDualWriteAdapter):
    domain = "headset_reviews"
    target_table = "headset_reviews"
    conflict_key = "review_id"

    def extract_business_key(self, payload: Mapping[str, Any]) -> str:
        return str(payload.get("review_id") or payload.get("ReviewID") or payload.get("id") or "")

    def transform_payload(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        review_id = self.extract_business_key(payload)
        brand = str(payload.get("brand") or payload.get("Brand") or payload.get("headset_brand") or "").strip()
        model = str(payload.get("model") or payload.get("Model") or payload.get("headset_model") or "").strip()
        status_val = str(payload.get("status") or payload.get("Status") or "pending").strip().lower()
        if status_val not in {"approved", "denied", "archived", "deleted", "inactive", "pending", "unknown"}:
            status_val = "pending"

        note_val = payload.get("note") or payload.get("Note") or payload.get("notes") or payload.get("Notes") or None
        denial_reason = payload.get("denial_reason") or payload.get("reason") or None
        decision_by = payload.get("decision_by") or payload.get("actor") or payload.get("admin") or None
        decision_at_raw = payload.get("decision_at")
        decision_at = str(decision_at_raw).strip() if decision_at_raw else (datetime.datetime.now(datetime.timezone.utc).isoformat() if status_val in ("approved", "denied") else None)
        created_at_raw = payload.get("created_at") or payload.get("CreatedAt")
        created_at = str(created_at_raw).strip() if created_at_raw else datetime.datetime.now(datetime.timezone.utc).isoformat()

        checksum = hashlib.sha256(
            json.dumps(dict(payload), sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
        ).hexdigest()

        return {
            "review_id": review_id,
            "source_session_id": payload.get("source_session_id") or payload.get("session_id") or None,
            "candidate_name": payload.get("candidate_name") or None,
            "tester_name": payload.get("tester_name") or payload.get("tester") or None,
            "brand": brand or None,
            "model": model or None,
            "status": status_val,
            "note": note_val,
            "denial_reason": denial_reason,
            "decision_by": decision_by,
            "decision_at": decision_at,
            "normalization_status": "canonical" if (brand and model) else "deterministic_catalog_match",
            "created_at": created_at,
            "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "source_checksum": checksum,
            "source_payload": dict(payload),
        }

    def verify_persisted_state(
        self,
        supabase_provider: SupabaseDataProvider,
        business_key: str,
        expected_payload: Mapping[str, Any],
    ) -> bool:
        if not business_key:
            return False
        rows = supabase_provider.list_resource("headset_reviews", filters={"review_id": business_key})
        if not rows:
            return False
        row = rows[0]
        if expected_payload.get("status") and str(row.get("status")).lower() != str(expected_payload.get("status")).lower():
            return False
        if expected_payload.get("brand") and str(row.get("brand") or "").strip() != str(expected_payload.get("brand") or "").strip():
            return False
        if expected_payload.get("model") and str(row.get("model") or "").strip() != str(expected_payload.get("model") or "").strip():
            return False
        if expected_payload.get("note") is not None and str(row.get("note") or "").strip() != str(expected_payload.get("note") or "").strip():
            return False
        return True


class CandidatesAdapter(DomainDualWriteAdapter):
    domain = "candidates"
    target_table = "candidates"
    conflict_key = "source_system,source_candidate_id"

    def extract_business_key(self, payload: Mapping[str, Any]) -> str:
        return str(payload.get("source_candidate_id") or payload.get("id") or payload.get("candidate_id") or "")

    def transform_payload(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        source_cand_id = self.extract_business_key(payload)
        display_name = str(payload.get("display_name") or payload.get("candidate_name") or "").strip()
        normalized_name = str(payload.get("normalized_name") or display_name.lower()).strip()
        current_status = payload.get("current_status") or payload.get("status") or None
        first_name = payload.get("first_name")
        last_initial = payload.get("last_initial")
        if not first_name and display_name:
            parts = display_name.split()
            first_name = parts[0] if parts else None
            last_initial = parts[-1][0] if len(parts) > 1 else None

        return {
            "source_system": str(payload.get("source_system") or "google_sheets"),
            "source_candidate_id": source_cand_id,
            "display_name": display_name,
            "normalized_name": normalized_name,
            "current_status": current_status,
            "first_name": first_name,
            "last_initial": last_initial,
            "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }

    def verify_persisted_state(
        self,
        supabase_provider: SupabaseDataProvider,
        business_key: str,
        expected_payload: Mapping[str, Any],
    ) -> bool:
        if not business_key:
            return False
        rows = supabase_provider.list_resource("candidates", filters={"source_candidate_id": business_key})
        if not rows:
            return False
        row = rows[0]
        if expected_payload.get("display_name") and str(row.get("display_name") or "").strip() != str(expected_payload.get("display_name") or "").strip():
            return False
        return True


class CandidateSessionsAdapter(DomainDualWriteAdapter):
    domain = "candidate_sessions"
    target_table = "candidate_sessions"
    conflict_key = "session_id"

    def extract_business_key(self, payload: Mapping[str, Any]) -> str:
        return str(payload.get("session_id") or payload.get("source_session_id") or payload.get("id") or "")

    def transform_payload(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        session_id = self.extract_business_key(payload)
        candidate_id = payload.get("candidate_id") or payload.get("canonical_candidate_id")
        checksum = hashlib.sha256(
            json.dumps(dict(payload), sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
        ).hexdigest()

        display_name = payload.get("candidate_name") or payload.get("candidate") or ""
        first_name = payload.get("candidate_first_name") or payload.get("first_name")
        last_initial = payload.get("candidate_last_initial") or payload.get("last_initial")
        if not first_name and display_name:
            parts = display_name.split()
            first_name = parts[0] if parts else None
            last_initial = parts[-1][0] if len(parts) > 1 else None

        current_attempt = int(payload.get("current_attempt_number") or payload.get("attempt_number") or 1)
        allowed_attempts = int(payload["allowed_attempt_count"]) if payload.get("allowed_attempt_count") else None
        if allowed_attempts is not None and current_attempt > allowed_attempts:
            allowed_attempts = current_attempt

        return {
            "id": payload.get("id") or _deterministic_uuid("session", session_id),
            "session_id": session_id,
            "candidate_id": str(candidate_id) if candidate_id else None,
            "candidate_name": display_name,
            "candidate_first_name": first_name,
            "candidate_last_initial": last_initial,
            "tester_name": payload.get("tester_name") or "",
            "session_type": payload.get("session_type") or payload.get("call_type") or "certification",
            "attempt_number": int(payload.get("attempt_number") or current_attempt),
            "current_attempt_number": current_attempt,
            "allowed_attempt_count": allowed_attempts,
            "extra_attempts_granted": int(payload.get("extra_attempts_granted") or 0),
            "final_attempt": bool(payload.get("final_attempt", False)),
            "raw_status": payload.get("raw_status") or payload.get("status") or "in_progress",
            "calculated_result": payload.get("calculated_result") or "",
            "final_result": payload.get("final_result") or "",
            "archived": bool(payload.get("archived", False)),
            "needs_sup_transfer": bool(payload.get("needs_sup_transfer", False)),
            "pending_sup_transfer_id": payload.get("pending_sup_transfer_id") or None,
            "headset_brand": payload.get("headset_brand") or None,
            "headset_model": payload.get("headset_model") or None,
            "newbie_shift_number": payload.get("newbie_shift_number") or None,
            "created_at": str(payload.get("created_at") or datetime.datetime.now(datetime.timezone.utc).isoformat()),
            "completed_at": str(payload.get("completed_at") or datetime.datetime.now(datetime.timezone.utc).isoformat()),
            "form_fill_status": payload.get("form_fill_status") or "not_attempted",
            "form_filled_at": payload.get("form_filled_at") or None,
            "source_checksum": checksum,
            "source_payload": dict(payload),
            "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        }

    def verify_persisted_state(
        self,
        supabase_provider: SupabaseDataProvider,
        business_key: str,
        expected_payload: Mapping[str, Any],
    ) -> bool:
        if not business_key:
            return False
        rows = supabase_provider.list_resource("candidate_sessions", filters={"session_id": business_key})
        if not rows:
            return False
        row = rows[0]
        if expected_payload.get("raw_status") and str(row.get("raw_status") or row.get("status") or "").lower() != str(expected_payload.get("raw_status") or "").lower():
            return False
        if expected_payload.get("status") and str(row.get("raw_status") or row.get("status") or "").lower() != str(expected_payload.get("status") or "").lower():
            return False
        return True


class SessionAttemptsAdapter(DomainDualWriteAdapter):
    domain = "session_attempts"
    target_table = "session_attempts"
    conflict_key = "source_action_id"

    def extract_business_key(self, payload: Mapping[str, Any]) -> str:
        return str(payload.get("source_action_id") or payload.get("id") or f"{payload.get('session_id')}:{payload.get('attempt_number', 1)}")

    def transform_payload(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        source_action_id = self.extract_business_key(payload)
        session_id_val = payload.get("session_uuid") or payload.get("canonical_session_id") or payload.get("session_id")
        if not session_id_val and payload.get("source_session_id"):
            session_id_val = _deterministic_uuid("session", payload.get("source_session_id"))
        attempt_number = max(1, int(payload.get("attempt_number") or 1))
        attempt_type = str(payload.get("attempt_type") or "mock_call").strip()
        result = payload.get("result") or payload.get("status") or None
        occurred_at_raw = payload.get("occurred_at") or payload.get("timestamp") or payload.get("created_at")
        occurred_at = str(occurred_at_raw).strip() if occurred_at_raw else datetime.datetime.now(datetime.timezone.utc).isoformat()
        details = payload.get("details") if isinstance(payload.get("details"), dict) else {}

        data = {
            "id": payload.get("id") or _deterministic_uuid("attempt", source_action_id),
            "source_action_id": source_action_id,
            "attempt_number": attempt_number,
            "attempt_type": attempt_type,
            "result": result,
            "occurred_at": occurred_at,
            "details": details,
        }
        if session_id_val:
            data["session_id"] = str(session_id_val)
        return data

    def verify_persisted_state(
        self,
        supabase_provider: SupabaseDataProvider,
        business_key: str,
        expected_payload: Mapping[str, Any],
    ) -> bool:
        if not business_key:
            return False
        rows = supabase_provider.list_resource("session_attempts", filters={"source_action_id": business_key})
        if not rows:
            return False
        row = rows[0]
        if expected_payload.get("result") and str(row.get("result") or "").strip() != str(expected_payload.get("result") or "").strip():
            return False
        if expected_payload.get("attempt_number") and int(row.get("attempt_number") or 0) != int(expected_payload.get("attempt_number")):
            return False
        return True


class CandidateCorrectionsAdapter(DomainDualWriteAdapter):
    domain = "candidate_corrections"
    target_table = "candidate_corrections"
    conflict_key = "request_id"

    def extract_business_key(self, payload: Mapping[str, Any]) -> str:
        return str(payload.get("request_id") or payload.get("id") or "")

    def transform_payload(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        req_id = self.extract_business_key(payload)
        source_session_id = str(payload.get("source_session_id") or payload.get("session_id") or "").strip()

        status_val = str(payload.get("status") or payload.get("Status") or "pending").strip().lower()
        reason = payload.get("reason") or payload.get("Reason") or None

        raw_changes = payload.get("changes") or payload.get("changes_json") or {}
        if isinstance(raw_changes, str):
            try:
                raw_changes = json.loads(raw_changes)
            except Exception:
                raw_changes = {}

        requested_by = payload.get("requested_by") or payload.get("tester_name") or payload.get("requester") or None
        decided_by = payload.get("decided_by") or payload.get("admin_decision_by") or payload.get("actor") or None
        denial_reason = payload.get("denial_reason") or None

        created_at_raw = payload.get("created_at") or payload.get("submitted_at")
        created_at = str(created_at_raw).strip() if created_at_raw else datetime.datetime.now(datetime.timezone.utc).isoformat()

        decision_at_raw = payload.get("decision_at") or payload.get("admin_decision_at")
        decision_at = str(decision_at_raw).strip() if decision_at_raw else (datetime.datetime.now(datetime.timezone.utc).isoformat() if status_val in ("approved", "denied") else None)

        checksum = hashlib.sha256(
            json.dumps(dict(payload), sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
        ).hexdigest()

        return {
            "request_id": req_id,
            "source_session_id": source_session_id,
            "request_type": str(payload.get("request_type") or "candidate_information_correction"),
            "reason": reason,
            "changes": raw_changes,
            "status": status_val,
            "requested_by": requested_by,
            "decided_by": decided_by,
            "denial_reason": denial_reason,
            "created_at": created_at,
            "decision_at": decision_at,
            "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "source_checksum": checksum,
            "source_payload": dict(payload),
        }

    def verify_persisted_state(
        self,
        supabase_provider: SupabaseDataProvider,
        business_key: str,
        expected_payload: Mapping[str, Any],
    ) -> bool:
        if not business_key:
            return False
        rows = supabase_provider.list_resource("candidate_corrections", filters={"request_id": business_key})
        if not rows:
            return False
        row = rows[0]
        if expected_payload.get("status") and str(row.get("status")).lower() != str(expected_payload.get("status")).lower():
            return False
        if expected_payload.get("reason") and str(row.get("reason") or "").strip() != str(expected_payload.get("reason") or "").strip():
            return False
        if expected_payload.get("source_session_id") and str(row.get("source_session_id") or "").strip() != str(expected_payload.get("source_session_id") or "").strip():
            return False
        return True


class NewbieShiftRequestsAdapter(DomainDualWriteAdapter):
    domain = "newbie_shift_requests"
    target_table = "newbie_shift_requests"
    conflict_key = "request_id"

    def extract_business_key(self, payload: Mapping[str, Any]) -> str:
        return str(payload.get("request_id") or payload.get("id") or "")

    def transform_payload(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        req_id = self.extract_business_key(payload)
        source_session_id = str(payload.get("source_session_id") or payload.get("session_id") or "").strip()
        status_val = str(payload.get("request_status") or payload.get("status") or payload.get("decision") or "pending").strip().lower()
        if status_val in ("approve", "approved"):
            status_val = "approved"
        elif status_val in ("deny", "denied"):
            status_val = "denied"

        newbie_shift_number = str(payload.get("newbie_shift_number") or "").strip()

        created_at_raw = payload.get("created_at") or payload.get("request_created_at")
        created_at = str(created_at_raw).strip() if created_at_raw else datetime.datetime.now(datetime.timezone.utc).isoformat()

        decision_at_raw = payload.get("decision_at") or payload.get("admin_decision_at")
        decision_at = str(decision_at_raw).strip() if decision_at_raw else (datetime.datetime.now(datetime.timezone.utc).isoformat() if status_val in ("approved", "denied") else None)

        checksum = hashlib.sha256(
            json.dumps(dict(payload), sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
        ).hexdigest()

        return {
            "request_id": req_id,
            "source_session_id": source_session_id,
            "request_type": str(payload.get("request_type") or "initial_newbie_shift"),
            "request_status": status_val,
            "newbie_shift_number": newbie_shift_number,
            "scheduled_at": payload.get("scheduled_at") or None,
            "original_scheduled_at": payload.get("original_scheduled_at") or None,
            "rescheduled_at": payload.get("rescheduled_at") or None,
            "timezone": payload.get("timezone") or None,
            "within_24_hours": bool(payload.get("within_24_hours")) if payload.get("within_24_hours") is not None else None,
            "counts_as_attempt": bool(payload.get("counts_as_attempt")) if payload.get("counts_as_attempt") is not None else None,
            "final_attempt": bool(payload.get("final_attempt")) if payload.get("final_attempt") is not None else None,
            "current_attempt": int(payload["current_attempt"]) if payload.get("current_attempt") else None,
            "resulting_attempt": int(payload["resulting_attempt"]) if payload.get("resulting_attempt") else None,
            "becomes_final_attempt": bool(payload.get("becomes_final_attempt")) if payload.get("becomes_final_attempt") is not None else None,
            "attempt_rule": payload.get("attempt_rule") or None,
            "terminal_outcome": payload.get("terminal_outcome") or None,
            "requested_by": payload.get("requested_by") or payload.get("tester_name") or None,
            "request_reason": payload.get("request_reason") or payload.get("reason") or None,
            "request_details": payload.get("request_details") or None,
            "decision_by": payload.get("decision_by") or payload.get("admin_decision_by") or payload.get("actor") or None,
            "denial_reason": payload.get("denial_reason") or payload.get("reason") if status_val == "denied" else None,
            "created_at": created_at,
            "decision_at": decision_at,
            "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "source_checksum": checksum,
            "source_payload": dict(payload),
        }

    def verify_persisted_state(
        self,
        supabase_provider: SupabaseDataProvider,
        business_key: str,
        expected_payload: Mapping[str, Any],
    ) -> bool:
        if not business_key:
            return False
        rows = supabase_provider.list_resource("newbie_shift_requests", filters={"request_id": business_key})
        if not rows:
            return False
        row = rows[0]
        expected_status = str(expected_payload.get("request_status") or expected_payload.get("status") or "").lower()
        if expected_status and str(row.get("request_status") or "").lower() != expected_status:
            return False
        if expected_payload.get("source_session_id") and str(row.get("source_session_id") or "").strip() != str(expected_payload.get("source_session_id") or "").strip():
            return False
        if expected_payload.get("newbie_shift_number") and str(row.get("newbie_shift_number") or "").strip() != str(expected_payload.get("newbie_shift_number") or "").strip():
            return False
        return True


class SupervisorTransfersAdapter(DomainDualWriteAdapter):
    domain = "supervisor_transfers"
    target_table = "supervisor_transfers"
    conflict_key = "transfer_id"

    def extract_business_key(self, payload: Mapping[str, Any]) -> str:
        return str(payload.get("transfer_id") or payload.get("pending_id") or payload.get("id") or "")

    def transform_payload(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        req_id = self.extract_business_key(payload)
        source_session_id = str(payload.get("source_session_id") or payload.get("original_session_id") or payload.get("session_id") or "").strip()
        status_val = str(payload.get("status") or "pending").strip().lower()
        candidate_name = payload.get("candidate_name") or payload.get("candidate") or None
        original_tester_name = payload.get("original_tester_name") or payload.get("tester_name") or payload.get("tester") or None
        final_attempt = bool(payload.get("final_attempt")) if payload.get("final_attempt") is not None else None
        completed_by = payload.get("completed_by") or payload.get("actor") or None
        completed_status = payload.get("completed_status") or None
        needed_reason = payload.get("needed_reason") or payload.get("reason") or None
        notes = payload.get("notes") or None

        created_at_raw = payload.get("created_at") or payload.get("submitted_at")
        created_at = str(created_at_raw).strip() if created_at_raw else datetime.datetime.now(datetime.timezone.utc).isoformat()

        completed_at_raw = payload.get("completed_at")
        completed_at = str(completed_at_raw).strip() if completed_at_raw else (datetime.datetime.now(datetime.timezone.utc).isoformat() if status_val in ("completed", "cancelled") else None)

        checksum = hashlib.sha256(
            json.dumps(dict(payload), sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
        ).hexdigest()

        return {
            "transfer_id": req_id,
            "source_session_id": source_session_id,
            "candidate_name": candidate_name,
            "original_tester_name": original_tester_name,
            "status": status_val,
            "final_attempt": final_attempt,
            "completed_by": completed_by,
            "completed_status": completed_status,
            "needed_reason": needed_reason,
            "notes": notes,
            "created_at": created_at,
            "completed_at": completed_at,
            "source_checksum": checksum,
            "source_payload": dict(payload),
        }

    def verify_persisted_state(
        self,
        supabase_provider: SupabaseDataProvider,
        business_key: str,
        expected_payload: Mapping[str, Any],
    ) -> bool:
        if not business_key:
            return False
        rows = supabase_provider.list_resource("supervisor_transfers", filters={"transfer_id": business_key})
        if not rows:
            return False
        row = rows[0]
        expected_status = str(expected_payload.get("status") or "").lower()
        if expected_status and str(row.get("status") or "").lower() != expected_status:
            return False
        if expected_payload.get("completed_status") and str(row.get("completed_status") or "").strip() != str(expected_payload.get("completed_status") or "").strip():
            return False
        if expected_payload.get("source_session_id") and str(row.get("source_session_id") or "").strip() != str(expected_payload.get("source_session_id") or "").strip():
            return False
        return True


class ExtraAttemptGrantsAdapter(DomainDualWriteAdapter):
    domain = "extra_attempt_grants"
    target_table = "extra_attempt_grants"
    conflict_key = "action_id"

    def extract_business_key(self, payload: Mapping[str, Any]) -> str:
        return str(payload.get("action_id") or payload.get("id") or payload.get("grant_id") or "")

    def transform_payload(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        action_id = self.extract_business_key(payload)
        source_session_id = str(payload.get("source_session_id") or payload.get("session_id") or "").strip()
        granted_count = max(1, int(payload.get("granted_count") or 1))
        resulting_allowed = max(1, int(payload.get("resulting_allowed_attempt_count") or payload.get("allowed_attempt_count") or (3 + granted_count)))
        reason = payload.get("reason") or payload.get("extra_attempt_reason") or None
        granted_by = payload.get("granted_by") or payload.get("extra_attempt_granted_by") or payload.get("actor") or None

        granted_at_raw = payload.get("granted_at") or payload.get("extra_attempt_granted_at") or payload.get("occurred_at")
        granted_at = str(granted_at_raw).strip() if granted_at_raw else datetime.datetime.now(datetime.timezone.utc).isoformat()

        session_uuid = payload.get("session_uuid") or payload.get("canonical_session_id") or payload.get("session_id")

        data = {
            "action_id": action_id,
            "source_session_id": source_session_id,
            "granted_count": granted_count,
            "resulting_allowed_attempt_count": resulting_allowed,
            "reason": reason,
            "granted_by": granted_by,
            "granted_at": granted_at,
            "source_provider": str(payload.get("source_provider") or "sheets"),
        }
        if session_uuid:
            data["session_id"] = str(session_uuid)
        return data

    def verify_persisted_state(
        self,
        supabase_provider: SupabaseDataProvider,
        business_key: str,
        expected_payload: Mapping[str, Any],
    ) -> bool:
        if not business_key:
            return False
        rows = supabase_provider.list_resource("extra_attempt_grants", filters={"action_id": business_key})
        if not rows:
            return False
        row = rows[0]
        if expected_payload.get("source_session_id") and str(row.get("source_session_id") or "").strip() != str(expected_payload.get("source_session_id") or "").strip():
            return False
        if expected_payload.get("resulting_allowed_attempt_count") and int(row.get("resulting_allowed_attempt_count") or 0) != int(expected_payload.get("resulting_allowed_attempt_count")):
            return False
        return True


class CandidateStatusActionsAdapter(DomainDualWriteAdapter):
    domain = "candidate_status_actions"
    target_table = "candidate_status_actions"
    conflict_key = "action_id"

    def extract_business_key(self, payload: Mapping[str, Any]) -> str:
        return str(payload.get("action_id") or payload.get("id") or "")

    def transform_payload(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        action_id = self.extract_business_key(payload)
        session_uuid = payload.get("session_uuid") or payload.get("canonical_session_id") or payload.get("session_id")
        action_type = str(payload.get("action_type") or payload.get("action") or "readiness_override").strip()
        result = payload.get("result") or payload.get("status") or None
        reason = payload.get("reason") or None
        actor_name = payload.get("actor_name") or payload.get("actor") or "system"
        before_state = payload.get("before_state")
        after_state = payload.get("after_state")
        occurred_at_raw = payload.get("occurred_at") or payload.get("created_at") or payload.get("timestamp")
        occurred_at = str(occurred_at_raw).strip() if occurred_at_raw else datetime.datetime.now(datetime.timezone.utc).isoformat()
        source_provider = str(payload.get("source_provider") or "sheets")

        data = {
            "action_id": action_id,
            "action_type": action_type,
            "result": result,
            "reason": reason,
            "actor_name": actor_name,
            "before_state": before_state if isinstance(before_state, (dict, list)) else None,
            "after_state": after_state if isinstance(after_state, (dict, list)) else None,
            "occurred_at": occurred_at,
            "source_provider": source_provider,
        }
        if session_uuid:
            data["session_id"] = str(session_uuid)
        return data

    def verify_persisted_state(
        self,
        supabase_provider: SupabaseDataProvider,
        business_key: str,
        expected_payload: Mapping[str, Any],
    ) -> bool:
        if not business_key:
            return False
        rows = supabase_provider.list_resource("candidate_status_actions", filters={"action_id": business_key})
        if not rows:
            return False
        row = rows[0]
        if expected_payload.get("action_type") and str(row.get("action_type") or "").strip() != str(expected_payload.get("action_type") or "").strip():
            return False
        if expected_payload.get("result") and str(row.get("result") or "").strip() != str(expected_payload.get("result") or "").strip():
            return False
        return True


class GenericOperationalAdapter(DomainDualWriteAdapter):
    def __init__(self, domain: str, target_table: str, conflict_key: str):
        self.domain = domain
        self.target_table = target_table
        self.conflict_key = conflict_key

    def extract_business_key(self, payload: Mapping[str, Any]) -> str:
        return str(payload.get(self.conflict_key) or payload.get("id") or payload.get("request_id") or "")

    def transform_payload(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        data = dict(payload)
        data.setdefault("updated_at", datetime.datetime.now(datetime.timezone.utc).isoformat())
        return data

    def verify_persisted_state(
        self,
        supabase_provider: SupabaseDataProvider,
        business_key: str,
        expected_payload: Mapping[str, Any],
    ) -> bool:
        if not business_key:
            return True
        rows = supabase_provider.list_resource(self.domain, filters={self.conflict_key: business_key})
        return bool(rows)


ADAPTER_REGISTRY: dict[str, DomainDualWriteAdapter] = {
    "notifications": NotificationsAdapter(),
    "headset_reviews": HeadsetReviewsAdapter(),
    "candidate_sessions": CandidateSessionsAdapter(),
    "candidates": CandidatesAdapter(),
    "session_attempts": SessionAttemptsAdapter(),
    "supervisor_transfers": SupervisorTransfersAdapter(),
    "newbie_shift_requests": NewbieShiftRequestsAdapter(),
    "candidate_corrections": CandidateCorrectionsAdapter(),
    "pending_requests": GenericOperationalAdapter("pending_requests", "pending_requests", "request_id"),
    "candidate_status_actions": CandidateStatusActionsAdapter(),
    "extra_attempt_grants": ExtraAttemptGrantsAdapter(),
}


class DualWriteManager:
    """Orchestrates dual writes with Sheets authority first, Supabase second, post-write verification, and divergence tracking."""

    def __init__(
        self,
        supabase_provider_factory: Callable[[], SupabaseDataProvider | None] | None = None,
        divergence_tracker: DualWriteDivergenceTracker | None = None,
    ):
        self._supabase_provider_factory = supabase_provider_factory
        self._divergence_tracker = divergence_tracker or DualWriteDivergenceTracker()
        self._cached_supabase_provider = None

    def _get_supabase_provider(self) -> SupabaseDataProvider | None:
        if self._cached_supabase_provider:
            return self._cached_supabase_provider
        if self._supabase_provider_factory:
            self._cached_supabase_provider = self._supabase_provider_factory()
            return self._cached_supabase_provider
        url = os.environ.get("SUPABASE_URL", "")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
        if url and key:
            try:
                self._cached_supabase_provider = SupabaseDataProvider(url, key, timeout=10.0, retries=1)
                return self._cached_supabase_provider
            except Exception:
                return None
        return None

    def get_divergence_tracker(self) -> DualWriteDivergenceTracker:
        return self._divergence_tracker

    def execute_dual_write(
        self,
        *,
        domain: str,
        mutation_type: str,
        authoritative_payload: Mapping[str, Any],
        authoritative_write_fn: Callable[[], Any],
        actor: str = "system",
        environ: Mapping[str, str] | None = None,
        supabase_provider_override: SupabaseDataProvider | None = None,
    ) -> tuple[Any, DualWriteResult]:
        start_time = time.perf_counter()
        adapter = ADAPTER_REGISTRY.get(domain)

        # Domain Check
        if domain not in DUAL_WRITE_ELIGIBLE_DOMAINS:
            auth_res = authoritative_write_fn()
            res = DualWriteResult(
                operation_id=f"dw-{domain}-{mutation_type}-unsupported",
                domain=domain,
                mutation_type=mutation_type,
                authoritative_success=True,
                mirror_attempted=False,
                mirror_status="skipped_unsupported_domain",
                failure_class=DualWriteFailureClass.UNSUPPORTED_DOMAIN,
            )
            return auth_res, res

        # 1. Authoritative Sheets write FIRST
        authoritative_result = None
        authoritative_success = False
        authoritative_error = None
        try:
            authoritative_result = authoritative_write_fn()
            if isinstance(authoritative_result, dict) and authoritative_result.get("ok") is False:
                authoritative_success = False
            elif authoritative_result is None:
                authoritative_success = False
            else:
                authoritative_success = True
        except Exception as exc:
            authoritative_success = False
            authoritative_error = exc

        # If authoritative Sheets write failed: DO NOT mirror to Supabase. Return normal failure.
        if not authoritative_success:
            duration = round((time.perf_counter() - start_time) * 1000, 2)
            result = DualWriteResult(
                operation_id=f"dw-{domain}-{mutation_type}-auth-failed",
                domain=domain,
                mutation_type=mutation_type,
                authoritative_success=False,
                mirror_attempted=False,
                mirror_status="skipped_authoritative_failure",
                duration_ms=duration,
                error_message=str(authoritative_error or "Authoritative write returned failure"),
            )
            if authoritative_error:
                raise authoritative_error
            return authoritative_result, result

        # 2. Check if Dual Write feature flag and per-domain gate are ON
        if not is_domain_dual_write_enabled(domain, environ):
            duration = round((time.perf_counter() - start_time) * 1000, 2)
            result = DualWriteResult(
                operation_id=f"dw-{domain}-{mutation_type}-domain-disabled",
                domain=domain,
                mutation_type=mutation_type,
                authoritative_success=True,
                authoritative_reference=str(authoritative_result.get("id") if isinstance(authoritative_result, dict) else ""),
                mirror_attempted=False,
                mirror_status="skipped_domain_not_allowlisted",
                duration_ms=duration,
                failure_class=DualWriteFailureClass.SUCCESS,
            )
            return authoritative_result, result

        # 3. Create stable logical operation identity
        business_key = adapter.extract_business_key(authoritative_payload) if adapter else ""
        digest = compute_payload_digest(authoritative_payload)
        operation_id = build_operation_id(domain, mutation_type, business_key, digest)

        # 4. Mirror to Supabase SECOND
        supabase_provider = supabase_provider_override or self._get_supabase_provider()
        if not supabase_provider:
            duration = round((time.perf_counter() - start_time) * 1000, 2)
            self._divergence_tracker.record_divergence(
                operation_id=operation_id,
                domain=domain,
                mutation_type=mutation_type,
                authoritative_ref=business_key,
                payload=authoritative_payload,
                failure_class=DualWriteFailureClass.TRANSIENT_FAILURE,
                error_message="Supabase provider unavailable or not configured",
                actor=actor,
            )
            result = DualWriteResult(
                operation_id=operation_id,
                domain=domain,
                mutation_type=mutation_type,
                authoritative_success=True,
                authoritative_reference=business_key,
                mirror_attempted=True,
                mirror_success=False,
                mirror_status="failed_provider_unavailable",
                failure_class=DualWriteFailureClass.TRANSIENT_FAILURE,
                retryable=True,
                duration_ms=duration,
                error_message="Supabase provider unavailable",
                divergence_recorded=True,
            )
            return authoritative_result, result

        # 5. Transform payload and execute mirror mutation
        transformed_payload = adapter.transform_payload(authoritative_payload)
        db_payload = transformed_payload
        allowed_cols = TABLE_ALLOWED_COLUMNS.get(adapter.target_table)
        if allowed_cols is not None:
            db_payload = {k: v for k, v in transformed_payload.items() if k in allowed_cols}
        mirror_success = False
        verification_success = False
        failure_class = DualWriteFailureClass.SUCCESS
        error_message = ""
        written_row_id = None

        try:
            if mutation_type in ("insert", "create", "update", "action"):
                written_rows = supabase_provider.upsert_rows(
                    adapter.target_table,
                    [db_payload],
                    on_conflict=adapter.conflict_key,
                    resolution="merge-duplicates",
                )
                if written_rows and isinstance(written_rows, list) and len(written_rows) > 0 and isinstance(written_rows[0], dict):
                    written_row_id = written_rows[0].get("id")
            elif mutation_type == "delete":
                supabase_provider.delete_rows(
                    adapter.target_table,
                    {adapter.conflict_key: f"eq.{business_key}"},
                )
            mirror_success = True
        except Exception as exc:
            mirror_success = False
            error_message = str(exc)
            err_lower = error_message.lower()
            if "401" in err_lower or "403" in err_lower or "jwt" in err_lower:
                failure_class = DualWriteFailureClass.AUTHORIZATION_DENIED
            elif "409" in err_lower or "duplicate" in err_lower or "conflict" in err_lower:
                failure_class = DualWriteFailureClass.CONFLICT
            elif "400" in err_lower or "validation" in err_lower or "invalid" in err_lower:
                failure_class = DualWriteFailureClass.PERMANENT_VALIDATION_FAILURE
            else:
                failure_class = DualWriteFailureClass.TRANSIENT_FAILURE

        # 6. Post-Write Verification
        if mirror_success:
            try:
                if mutation_type == "delete":
                    rows = supabase_provider.list_resource(domain, filters={adapter.conflict_key: business_key})
                    verification_success = len(rows) == 0
                else:
                    verification_success = adapter.verify_persisted_state(
                        supabase_provider, business_key, transformed_payload
                    )
                if not verification_success:
                    mirror_success = False
                    failure_class = DualWriteFailureClass.POST_WRITE_MISMATCH
                    error_message = "Post-write verification failed: read-back did not match expected persisted state"
            except Exception as v_exc:
                mirror_success = False
                verification_success = False
                failure_class = DualWriteFailureClass.POST_WRITE_MISMATCH
                error_message = f"Post-write verification exception: {v_exc}"

        # 7. Record divergence if mirror failed
        duration = round((time.perf_counter() - start_time) * 1000, 2)
        divergence_recorded = False
        if not mirror_success:
            self._divergence_tracker.record_divergence(
                operation_id=operation_id,
                domain=domain,
                mutation_type=mutation_type,
                authoritative_ref=business_key,
                payload=authoritative_payload,
                failure_class=failure_class,
                error_message=error_message,
                actor=actor,
            )
            divergence_recorded = True
            logger.warning(
                "[DUAL-WRITE-MIRROR-FAILURE] domain=%s op_id=%s failure_class=%s error=%s",
                domain, operation_id, failure_class.value, error_message,
            )
        else:
            logger.info(
                "[DUAL-WRITE-MIRROR-SUCCESS] domain=%s op_id=%s duration_ms=%s",
                domain, operation_id, duration,
            )

        result = DualWriteResult(
            operation_id=operation_id,
            domain=domain,
            mutation_type=mutation_type,
            authoritative_success=True,
            authoritative_reference=business_key,
            mirror_attempted=True,
            mirror_success=mirror_success,
            mirror_status="success" if mirror_success else "failed",
            verification_success=verification_success,
            failure_class=failure_class,
            retryable=(failure_class in (DualWriteFailureClass.TRANSIENT_FAILURE, DualWriteFailureClass.CONFLICT)),
            duration_ms=duration,
            error_message=error_message,
            divergence_recorded=divergence_recorded,
            persisted_row_id=written_row_id,
        )

        return authoritative_result, result

    def execute_candidate_lifecycle_workflow(
        self,
        candidate_payload: Mapping[str, Any],
        candidate_authoritative_write_fn: Callable[[], Any],
        session_payload: Mapping[str, Any],
        session_authoritative_write_fn: Callable[[], Any],
        attempt_payload: Mapping[str, Any] | None = None,
        attempt_authoritative_write_fn: Callable[[], Any] | None = None,
        workflow_id: str | None = None,
        actor: str | None = None,
        environ: Mapping[str, str] | None = None,
        supabase_provider_override: SupabaseDataProvider | None = None,
    ) -> dict[str, Any]:
        """Orchestrates candidate lifecycle workflow writes in dependency order: candidate -> session -> attempt."""
        wf_id = workflow_id or f"wf-cand-{uuid.uuid4().hex[:12]}"
        results = {
            "workflow_id": wf_id,
            "candidate_authoritative_result": None,
            "candidate_mirror_result": None,
            "session_authoritative_result": None,
            "session_mirror_result": None,
            "attempt_authoritative_result": None,
            "attempt_mirror_result": None,
            "all_mirrors_succeeded": True,
        }

        # Step 1: Candidate
        cand_auth, cand_res = self.execute_dual_write(
            domain="candidates",
            mutation_type="create" if candidate_payload.get("is_new") else "update",
            authoritative_payload=candidate_payload,
            authoritative_write_fn=candidate_authoritative_write_fn,
            actor=actor,
            environ=environ,
            supabase_provider_override=supabase_provider_override,
        )
        results["candidate_authoritative_result"] = cand_auth
        results["candidate_mirror_result"] = cand_res
        if cand_res.mirror_attempted and not cand_res.mirror_success:
            results["all_mirrors_succeeded"] = False

        # Step 2: Session
        session_payload_dict = dict(session_payload)
        cand_row_id = getattr(cand_res, "persisted_row_id", None)
        if not session_payload_dict.get("candidate_id") and cand_row_id:
            session_payload_dict["candidate_id"] = cand_row_id

        sess_auth, sess_res = self.execute_dual_write(
            domain="candidate_sessions",
            mutation_type="create" if session_payload.get("is_new") else "update",
            authoritative_payload=session_payload_dict,
            authoritative_write_fn=session_authoritative_write_fn,
            actor=actor,
            environ=environ,
            supabase_provider_override=supabase_provider_override,
        )
        results["session_authoritative_result"] = sess_auth
        results["session_mirror_result"] = sess_res
        if sess_res.mirror_attempted and not sess_res.mirror_success:
            results["all_mirrors_succeeded"] = False

        # Step 3: Attempt (if present)
        if attempt_payload and attempt_authoritative_write_fn:
            attempt_payload_dict = dict(attempt_payload)
            sess_row_id = getattr(sess_res, "persisted_row_id", None)
            if not attempt_payload_dict.get("session_uuid") and sess_row_id:
                attempt_payload_dict["session_uuid"] = sess_row_id

            att_auth, att_res = self.execute_dual_write(
                domain="session_attempts",
                mutation_type="create",
                authoritative_payload=attempt_payload_dict,
                authoritative_write_fn=attempt_authoritative_write_fn,
                actor=actor,
                environ=environ,
                supabase_provider_override=supabase_provider_override,
            )
            results["attempt_authoritative_result"] = att_auth
            results["attempt_mirror_result"] = att_res
            if att_res.mirror_attempted and not att_res.mirror_success:
                results["all_mirrors_succeeded"] = False

        return results

    def retry_divergence(self, operation_id: str, environ: Mapping[str, str] | None = None) -> DualWriteResult:
        """Retries a previously recorded divergence operation and resolves it upon successful verification."""
        with self._divergence_tracker._lock:
            record = self._divergence_tracker._records.get(operation_id)
            if not record:
                raise ValueError(f"No divergence record found for operation_id: {operation_id}")
            domain = record.domain
            mutation_type = record.mutation_type
            auth_ref = record.authoritative_ref
            actor = record.actor

        adapter = ADAPTER_REGISTRY.get(domain)
        if not adapter:
            raise ValueError(f"No adapter registered for domain: {domain}")

        supabase_provider = self._get_supabase_provider()
        if not supabase_provider:
            raise ValueError("Supabase provider unavailable for retry")

        try:
            verified = adapter.verify_persisted_state(supabase_provider, auth_ref, {})
        except Exception:
            verified = False

        if verified:
            self._divergence_tracker.resolve_divergence(operation_id)
            return DualWriteResult(
                operation_id=operation_id,
                domain=domain,
                mutation_type=mutation_type,
                authoritative_success=True,
                authoritative_reference=auth_ref,
                mirror_attempted=True,
                mirror_success=True,
                mirror_status="resolved",
                verification_success=True,
            )
        else:
            return DualWriteResult(
                operation_id=operation_id,
                domain=domain,
                mutation_type=mutation_type,
                authoritative_success=True,
                authoritative_reference=auth_ref,
                mirror_attempted=True,
                mirror_success=False,
                mirror_status="failed",
                verification_success=False,
            )


_GLOBAL_DUAL_WRITE_MANAGER = DualWriteManager()


def get_dual_write_manager() -> DualWriteManager:
    return _GLOBAL_DUAL_WRITE_MANAGER

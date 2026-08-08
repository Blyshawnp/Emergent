from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import uuid
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from .core import (
    EXPECTED_SUPABASE_PROJECT_REF,
    SHADOW_DOMAIN_SPECS,
    _mismatched_fields,
    stable_checksum,
)


PLAN_TTL_SECONDS = 15 * 60
EXECUTION_ACK_ENV = "MTS_SUPABASE_RECONCILIATION_EXECUTION_ACK"
EXECUTION_ACK_VALUE = "I_UNDERSTAND_THIS_WRITES_HOSTED_DATA"

CLASSIFICATIONS = {
    "insert_new", "update_existing", "already_current", "expected_historical",
    "expected_duplicate", "unresolved", "ambiguous", "conflict", "unsupported",
    "derived_only",
}

CANONICAL_DOMAINS = (
    "candidates", "candidate_sessions", "session_attempts", "headset_catalog",
    "headset_reviews", "supervisor_transfers", "newbie_shift_requests",
    "candidate_corrections", "pending_requests", "notifications",
)

DERIVED_DOMAINS = (
    "authoritative_candidate_status", "candidate_tracking", "history", "recent_activity",
)

HOSTED_COUNT_TABLES = (
    "import_batches", "candidates", "candidate_sessions", "session_attempts",
    "data_source_lineage", "headset_catalog", "headset_reviews",
    "supervisor_transfers", "newbie_shift_requests", "candidate_corrections",
    "pending_requests",
)


@dataclass(frozen=True)
class DomainRule:
    source_tab: str
    identity_field: str
    identity_aliases: tuple[str, ...]
    entity_namespace: str
    update_fields: tuple[str, ...] = ()
    derived_effects: tuple[str, ...] = ()
    parent_identity_aliases: tuple[str, ...] = ()
    lineage: bool = True


RULES = {
    # Candidate names are intentionally absent. A candidate can only reuse an
    # existing canonical identity established by session relationship/lineage.
    "candidates": DomainRule(
        "Candidate Sessions", "source_candidate_id", ("source_candidate_id",), "candidate",
        derived_effects=("candidate_tracking", "history"),
    ),
    "candidate_sessions": DomainRule(
        "Candidate Sessions", "session_id", ("session_id",), "session",
        update_fields=(
            "raw_status", "calculated_result", "final_result", "archived", "withdrawn",
            "final_attempt", "current_attempt_number", "allowed_attempt_count",
            "needs_sup_transfer", "pending_sup_transfer_id", "newbie_shift_number",
        ),
        derived_effects=("authoritative_candidate_status", "candidate_tracking", "history"),
    ),
    "session_attempts": DomainRule(
        "Candidate Sessions", "source_action_id", ("source_action_id", "attempt_key"),
        "attempt", parent_identity_aliases=("source_session_id",),
    ),
    "headset_catalog": DomainRule(
        "headsets", "brand_model", ("brand", "Brand", "model", "Model"), "headset",
        update_fields=("status", "note", "archived_at", "deleted_at"),
    ),
    "headset_reviews": DomainRule(
        "headset-review-log", "review_id", ("review_id",), "review",
        update_fields=("status", "denial_reason", "decision_by", "decision_at", "updated_at"),
        parent_identity_aliases=("source_session_id",),
    ),
    "supervisor_transfers": DomainRule(
        "Pending Sup Transfers", "transfer_id", ("transfer_id", "pending_id"), "transfer",
        update_fields=("status", "completed_status", "completed_by", "completed_at", "final_attempt"),
        parent_identity_aliases=("source_session_id", "original_session_id"),
    ),
    "newbie_shift_requests": DomainRule(
        "newbie-shift-requests", "request_id", ("request_id",), "shift_request",
        update_fields=(
            "request_status", "scheduled_at", "original_scheduled_at", "rescheduled_at",
            "timezone", "within_24_hours", "counts_as_attempt", "final_attempt",
            "current_attempt", "resulting_attempt", "becomes_final_attempt", "attempt_rule",
            "terminal_outcome", "decision_by", "denial_reason", "decision_at", "updated_at",
        ),
        derived_effects=("pending_requests", "recent_activity", "candidate_tracking", "history"),
        parent_identity_aliases=("source_session_id", "session_id"),
    ),
    "candidate_corrections": DomainRule(
        "candidate-information-correction-requests", "request_id", ("request_id",), "correction",
        update_fields=("status", "changes", "decided_by", "denial_reason", "decision_at", "updated_at"),
        derived_effects=("pending_requests", "recent_activity"),
        parent_identity_aliases=("source_session_id",),
    ),
    "pending_requests": DomainRule(
        "candidate-deletion-requests", "tab_request_id", ("source_tab", "category", "request_id"),
        "pending-request",
        update_fields=("status", "decision_by", "denial_reason", "decision_at", "updated_at"),
        derived_effects=("recent_activity",), parent_identity_aliases=("source_session_id",),
    ),
    "notifications": DomainRule(
        "sam-notifications", "notification_id", ("notification_id", "ID"), "notification",
        update_fields=(
            "enabled", "notification_type", "title", "message", "show_ticker", "show_popup",
            "show_banner", "persistent", "starts_at", "ends_at", "action_text", "action_url",
        ),
    ),
}


def _utcnow(now: datetime.datetime | None = None) -> datetime.datetime:
    value = now or datetime.datetime.now(datetime.timezone.utc)
    if value.tzinfo is None:
        value = value.replace(tzinfo=datetime.timezone.utc)
    return value.astimezone(datetime.timezone.utc)


def _first(row: Mapping[str, Any], aliases: Sequence[str]) -> Any:
    for alias in aliases:
        value = row.get(alias)
        if value is not None and str(value).strip() != "":
            return value
    return None


def _safe_identity_hash(domain: str, identity: str) -> str:
    return hashlib.sha256(f"{domain}:{identity}".encode("utf-8")).hexdigest()


def _canonical_uuid(namespace: str, identity: str) -> str:
    if namespace == "headset":
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"mts-sam:headset-catalog:{identity}"))
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"mts-sam:{namespace}:{identity}"))


def _project_ref(provider) -> str | None:
    match = re.search(r"https://([a-z0-9]+)\.supabase\.co", str(getattr(provider, "_url", "")))
    return match.group(1) if match else None


def _domain_identity(domain: str, row: Mapping[str, Any]) -> str:
    if domain == "headset_catalog":
        brand = str(_first(row, ("brand", "Brand")) or "").strip().casefold()
        model = str(_first(row, ("model", "Model")) or "").strip().casefold()
        return f"{brand}|{model}" if brand and model else ""
    if domain == "pending_requests":
        tab = str(_first(row, ("source_tab", "category")) or "").strip()
        request_id = str(row.get("request_id") or "").strip()
        return f"{tab}|{request_id}" if tab and request_id else ""
    return str(_first(row, RULES[domain].identity_aliases) or "").strip()


def _source_row_key(domain: str, identity: str) -> str:
    if domain == "headset_catalog":
        brand, model = identity.split("|", 1)
        return f"headset:{brand}:{model}"
    field = "pending_id" if domain == "supervisor_transfers" else RULES[domain].identity_field
    if domain == "pending_requests":
        _tab, request_id = identity.split("|", 1)
        return f"request_id:{request_id}"
    return f"{field}:{identity}"


def _target_checksum(domain: str, row: Mapping[str, Any]) -> str:
    spec = SHADOW_DOMAIN_SPECS[domain]
    fields = spec.identity + spec.values + spec.statuses + spec.relationships + spec.attempts
    payload = {aliases[0]: _first(row, aliases) for aliases in fields}
    return stable_checksum(payload)


def _source_checksum(domain: str, row: Mapping[str, Any]) -> str:
    # This checksum is deliberately reproducible from the one-fetch provider
    # projection. Execution must re-fetch and reproduce it before any write.
    return _target_checksum(domain, row)


def _index_rows(domain: str, rows: Sequence[Mapping[str, Any]]):
    index: dict[str, Mapping[str, Any]] = {}
    duplicates: set[str] = set()
    missing = 0
    for row in rows:
        identity = _domain_identity(domain, row)
        if not identity:
            missing += 1
            continue
        if identity in index:
            duplicates.add(identity)
        else:
            index[identity] = row
    return index, duplicates, missing


def _lineage_index(provider):
    rows = provider._request("data_source_lineage", query={
        "select": "entity_type,entity_id,source_system,source_tab,source_row_key,source_checksum,import_batch_id",
        "limit": 5000,
    })
    by_source = {}
    by_entity = {}
    for row in rows or []:
        source = (
            str(row.get("source_system") or ""), str(row.get("source_tab") or ""),
            str(row.get("source_row_key") or ""),
        )
        entity = (
            str(row.get("entity_type") or ""), str(row.get("entity_id") or ""),
            str(row.get("source_system") or ""), str(row.get("source_tab") or ""),
        )
        by_source[source] = row
        by_entity[entity] = row
    return by_source, by_entity


def hosted_count_snapshot(provider) -> dict[str, int]:
    counts = {}
    for table in HOSTED_COUNT_TABLES:
        rows = provider._request(table, query={"select": "id", "limit": 5000})
        if not isinstance(rows, list):
            raise RuntimeError(f"hosted_count_read_failed:{table}")
        counts[table] = len(rows)
    return counts


def _lineage_outcome(
    domain: str,
    identity: str,
    entity_id: str,
    by_source: Mapping[tuple[str, str, str], Mapping[str, Any]],
    by_entity: Mapping[tuple[str, str, str, str], Mapping[str, Any]],
) -> str:
    rule = RULES[domain]
    source_key = ("google_sheets", rule.source_tab, _source_row_key(domain, identity))
    entity_key = (domain, entity_id, "google_sheets", rule.source_tab)
    source = by_source.get(source_key)
    if source:
        if str(source.get("entity_type")) == domain and str(source.get("entity_id")) == entity_id:
            return "already_exists_same_mapping"
        return "conflict_source_maps_to_different_entity"
    entity = by_entity.get(entity_key)
    if entity:
        if str(entity.get("source_row_key")) == source_key[2]:
            return "already_exists_same_mapping"
        return "conflict_entity_maps_to_different_source"
    return "inserted"


def _existing_lineage_outcome(
    domain: str, identity: str, entity_id: str,
    by_source: Mapping[tuple[str, str, str], Mapping[str, Any]],
) -> str:
    """Never reinterpret historical entity-side lineage for an existing row."""
    rule = RULES[domain]
    source = by_source.get(("google_sheets", rule.source_tab, _source_row_key(domain, identity)))
    if not source:
        return "not_required_existing_canonical"
    if str(source.get("entity_type")) == domain and str(source.get("entity_id")) == entity_id:
        return "already_exists_same_mapping"
    return "conflict_source_maps_to_different_entity"


def _candidate_session_raw(row: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in row.items() if key != "candidate_id"}


SESSION_SOURCE_TO_CANONICAL = {
    "status": "raw_status", "raw_status": "raw_status",
    "calculated_result": "calculated_result", "final_result": "final_result",
    "archived": "archived", "withdrawn": "withdrawn", "final_attempt": "final_attempt",
    "current_attempt_number": "current_attempt_number", "allowed_attempt_count": "allowed_attempt_count",
    "needs_sup_transfer": "needs_sup_transfer", "pending_sup_transfer_id": "pending_sup_transfer_id",
    "newbie_shift_number": "newbie_shift_number",
}


def _raw_changed_fields(
    source: Mapping[str, Any], target: Mapping[str, Any], fields: Sequence[str] | None = None,
) -> list[str]:
    keys = set(fields or (set(source) | set(target)))
    def comparable(value):
        return None if value is None or str(value).strip() == "" else value
    return sorted(
        key for key in keys
        if stable_checksum({"value": comparable(source.get(key))})
        != stable_checksum({"value": comparable(target.get(key))})
    )


def _candidate_items(source_rows, target_rows):
    """Reuse canonical candidate IDs only; never construct identity from a name."""
    target_by_id = {str(row.get("id") or ""): row for row in target_rows if row.get("id")}
    source_sessions = {str(row.get("session_id") or ""): row for row in source_rows}
    items = []
    seen = set()
    for session_id, row in source_sessions.items():
        canonical_id = str(row.get("candidate_id") or "")
        if canonical_id and canonical_id in target_by_id:
            if canonical_id in seen:
                continue
            seen.add(canonical_id)
            items.append({
                "entity_type": "candidates", "classification": "already_current",
                "safe_identity_hash": _safe_identity_hash("candidates", canonical_id),
                "source_checksum": _source_checksum("candidate_sessions", row),
                "target_checksum": _target_checksum("candidates", target_by_id[canonical_id]),
                "proposed_checksum": _target_checksum("candidates", target_by_id[canonical_id]),
                "changed_fields": [], "dependencies": [], "lineage_outcome": "already_exists_same_mapping",
                "blocking_reason": None, "derived_effects": [],
            })
        elif session_id:
            # The Sheet has no approved candidate ID. A name is private and is
            # explicitly forbidden as identity, so this must remain blocked.
            key = _safe_identity_hash("candidate-session-fallback", session_id)
            if key in seen:
                continue
            seen.add(key)
            items.append({
                "entity_type": "candidates", "classification": "ambiguous",
                "safe_identity_hash": key,
                "source_checksum": _source_checksum("candidate_sessions", row),
                "target_checksum": None, "proposed_checksum": None,
                "changed_fields": [], "dependencies": [], "lineage_outcome": "unresolved",
                "blocking_reason": "approved_candidate_identity_unavailable_name_fallback_forbidden",
                "derived_effects": ["candidate_tracking", "history"],
            })
    return items


def generate_reconciliation_plan(
    sheets_provider,
    supabase_provider,
    *,
    comparison_result: Mapping[str, Any] | None = None,
    now: datetime.datetime | None = None,
) -> dict[str, Any]:
    generated = _utcnow(now)
    project_ref = _project_ref(supabase_provider)
    if project_ref != EXPECTED_SUPABASE_PROJECT_REF:
        raise RuntimeError("project_ref_mismatch")

    source_by_domain = {
        domain: list(sheets_provider.list_resource(domain, limit=5000))
        for domain in CANONICAL_DOMAINS
    }
    target_by_domain = {
        domain: list(supabase_provider.list_resource(domain, limit=5000))
        for domain in CANONICAL_DOMAINS
    }
    # The logical pending/activity projections union three canonical request
    # tables. Only candidate-deletion requests are physically owned by
    # pending_requests; Newbie Shift and correction rows are derived effects.
    source_by_domain["pending_requests"] = [
        row for row in source_by_domain["pending_requests"]
        if str(row.get("source_tab") or row.get("category") or "") == "candidate-deletion-requests"
    ]
    target_by_domain["pending_requests"] = [
        row for row in target_by_domain["pending_requests"]
        if str(row.get("category") or row.get("source_tab") or "") == "candidate-deletion-requests"
    ]
    metadata = dict(getattr(sheets_provider, "snapshot_metadata", {}) or {})
    if metadata.get("fetch_count") != 1 or metadata.get("errors"):
        raise RuntimeError("snapshot_contract_incomplete")
    snapshot_checksum = str(metadata.get("checksum") or "")
    if not re.fullmatch(r"[0-9a-f]{64}", snapshot_checksum):
        raise RuntimeError("snapshot_checksum_invalid")

    by_source, by_entity = _lineage_index(supabase_provider)
    items = _candidate_items(source_by_domain["candidate_sessions"], target_by_domain["candidates"])
    private_before_images = []

    for domain in CANONICAL_DOMAINS:
        if domain == "candidates":
            continue
        rule = RULES[domain]
        source_index, source_duplicates, source_missing = _index_rows(domain, source_by_domain[domain])
        target_index, target_duplicates, _target_missing = _index_rows(domain, target_by_domain[domain])

        for number in range(source_missing):
            items.append({
                "entity_type": domain, "classification": "unresolved",
                "safe_identity_hash": _safe_identity_hash(domain, f"missing:{number}"),
                "source_checksum": None, "target_checksum": None, "proposed_checksum": None,
                "changed_fields": [], "dependencies": [], "lineage_outcome": "unresolved",
                "blocking_reason": "stable_source_identity_missing", "derived_effects": list(rule.derived_effects),
            })

        for identity in sorted(source_index):
            source = source_index[identity]
            safe_hash = _safe_identity_hash(domain, identity)
            dependencies = []
            parent = str(_first(source, rule.parent_identity_aliases) or "").strip()
            if parent:
                dependencies.append({
                    "entity_type": "candidate_sessions",
                    "safe_identity_hash": _safe_identity_hash("candidate_sessions", parent),
                })
            if identity in source_duplicates or identity in target_duplicates:
                items.append({
                    "entity_type": domain, "classification": "conflict",
                    "safe_identity_hash": safe_hash, "source_checksum": _source_checksum(domain, source),
                    "target_checksum": None, "proposed_checksum": None, "changed_fields": [],
                    "dependencies": dependencies, "lineage_outcome": "unresolved",
                    "blocking_reason": "duplicate_stable_identity", "derived_effects": list(rule.derived_effects),
                })
                continue

            target = target_index.get(identity)
            source_checksum = _source_checksum(domain, source)
            if target is None:
                classification = "insert_new"
                blocking_reason = None
                if domain == "candidate_sessions":
                    parent_candidate = str(source.get("candidate_id") or "")
                    target_candidate_ids = {
                        str(row.get("id") or "") for row in target_by_domain["candidates"]
                    }
                    if not parent_candidate or parent_candidate not in target_candidate_ids:
                        blocking_reason = "parent_candidate_identity_unresolved"
                        dependencies.append({
                            "entity_type": "candidates",
                            "safe_identity_hash": _safe_identity_hash(
                                "candidate-session-fallback", identity
                            ),
                        })
                if domain == "headset_catalog":
                    timestamp = _first(source, ("created_at", "updated_at", "CreatedAt", "UpdatedAt"))
                    if not timestamp:
                        classification = "ambiguous"
                        blocking_reason = "catalog_provenance_and_recency_unavailable"
                entity_id = _canonical_uuid(rule.entity_namespace, identity)
                lineage_outcome = _lineage_outcome(domain, identity, entity_id, by_source, by_entity) if rule.lineage else "not_required"
                if classification in {"ambiguous", "unresolved", "unsupported"}:
                    lineage_outcome = "unresolved"
                if lineage_outcome.startswith("conflict_"):
                    classification = "conflict"
                    blocking_reason = lineage_outcome
                items.append({
                    "entity_type": domain, "classification": classification,
                    "safe_identity_hash": safe_hash, "source_checksum": source_checksum,
                    "target_checksum": None, "proposed_checksum": source_checksum,
                    "changed_fields": [], "dependencies": dependencies,
                    "lineage_outcome": lineage_outcome, "blocking_reason": blocking_reason,
                    "derived_effects": list(rule.derived_effects),
                })
                continue

            spec = SHADOW_DOMAIN_SPECS[domain]
            if domain == "candidate_sessions" and isinstance(target.get("source_payload"), Mapping):
                source_raw = _candidate_session_raw(source)
                raw_changes = _raw_changed_fields(
                    source_raw, dict(target.get("source_payload") or {}),
                    tuple(SESSION_SOURCE_TO_CANONICAL),
                )
                mismatches = sorted({SESSION_SOURCE_TO_CANONICAL.get(field, field) for field in raw_changes})
                source_checksum = stable_checksum(source_raw)
            else:
                mismatches = []
                for fields in (spec.values, spec.statuses, spec.relationships, spec.attempts):
                    mismatches.extend(_mismatched_fields(fields, source, target))
                mismatches = sorted(set(mismatches))
            target_checksum = _target_checksum(domain, target)
            if domain == "candidate_sessions" and isinstance(target.get("source_payload"), Mapping):
                proposed_target = dict(target)
                for source_field in raw_changes:
                    proposed_target[SESSION_SOURCE_TO_CANONICAL[source_field]] = source_raw.get(source_field)
                proposed_checksum = _target_checksum(domain, proposed_target)
            else:
                proposed_checksum = source_checksum
            disallowed = sorted(set(mismatches) - set(rule.update_fields))
            if domain == "headset_reviews" and not target.get("session_id"):
                classification = "expected_historical"
                blocking_reason = None
                mismatches = []
            elif not mismatches:
                classification = "already_current"
                blocking_reason = None
            elif not rule.update_fields or disallowed:
                classification = "conflict"
                blocking_reason = "non_allowlisted_change:" + ",".join(disallowed or mismatches)
            else:
                classification = "update_existing"
                blocking_reason = None
            entity_id = str(target.get("id") or _canonical_uuid(rule.entity_namespace, identity))
            lineage_outcome = _existing_lineage_outcome(
                domain, identity, entity_id, by_source
            ) if rule.lineage else "not_required"
            if lineage_outcome.startswith("conflict_"):
                classification = "conflict"
                blocking_reason = lineage_outcome
            if classification == "update_existing":
                private_before_images.append({
                    "entity_type": domain,
                    "safe_identity_hash": safe_hash,
                    "fields": {field: target.get(field) for field in mismatches},
                    "original_checksum": target_checksum,
                    "proposed_checksum": proposed_checksum,
                })
            items.append({
                "entity_type": domain, "classification": classification,
                "safe_identity_hash": safe_hash, "source_checksum": source_checksum,
                "target_checksum": target_checksum, "proposed_checksum": proposed_checksum,
                "changed_fields": mismatches, "dependencies": dependencies,
                "lineage_outcome": lineage_outcome, "blocking_reason": blocking_reason,
                "derived_effects": list(rule.derived_effects),
            })

        if domain == "headset_reviews":
            for identity in sorted(set(target_index) - set(source_index)):
                target = target_index[identity]
                historical = not target.get("source_session_id") and not target.get("session_id")
                unresolved_historical = target.get("source_session_id") and not target.get("session_id")
                if historical or unresolved_historical:
                    items.append({
                        "entity_type": domain, "classification": "expected_historical",
                        "safe_identity_hash": _safe_identity_hash(domain, identity),
                        "source_checksum": None, "target_checksum": _target_checksum(domain, target),
                        "proposed_checksum": None, "changed_fields": [], "dependencies": [],
                        "lineage_outcome": "not_required", "blocking_reason": None,
                        "derived_effects": [],
                    })

    classification_counts = {key: 0 for key in sorted(CLASSIFICATIONS)}
    entity_counts = {}
    canonical_inserts = 0
    canonical_updates = 0
    blockers = []
    derived_effects = {domain: 0 for domain in DERIVED_DOMAINS + ("pending_requests",)}
    lineage_counts = {
        "expected_new": 0, "expected_same_mapping": 0,
        "potential_source_conflict": 0, "potential_entity_conflict": 0, "unresolved": 0,
    }
    for item in items:
        classification_counts[item["classification"]] += 1
        entity = entity_counts.setdefault(item["entity_type"], {
            "starting_count": len(target_by_domain[item["entity_type"]]),
            "inserts": 0, "updates": 0, "expected_ending_count": len(target_by_domain[item["entity_type"]]),
        })
        if item["classification"] == "insert_new":
            entity["inserts"] += 1
            entity["expected_ending_count"] += 1
            canonical_inserts += 1
        elif item["classification"] == "update_existing":
            entity["updates"] += 1
            canonical_updates += 1
        if item.get("blocking_reason"):
            blockers.append({
                "entity_type": item["entity_type"], "safe_identity_hash": item["safe_identity_hash"],
                "reason": item["blocking_reason"],
            })
        for derived in item.get("derived_effects") or []:
            if item["classification"] in {"insert_new", "update_existing"}:
                derived_effects[derived] = derived_effects.get(derived, 0) + 1
        outcome = item.get("lineage_outcome")
        if outcome == "inserted":
            lineage_counts["expected_new"] += 1
        elif outcome == "already_exists_same_mapping":
            lineage_counts["expected_same_mapping"] += 1
        elif outcome == "conflict_source_maps_to_different_entity":
            lineage_counts["potential_source_conflict"] += 1
        elif outcome == "conflict_entity_maps_to_different_source":
            lineage_counts["potential_entity_conflict"] += 1
        elif outcome == "unresolved":
            lineage_counts["unresolved"] += 1

    safe_items = sorted(items, key=lambda item: (
        item["entity_type"], item["safe_identity_hash"], item["classification"]
    ))
    plan_basis = {
        "version": 1, "project_ref": project_ref, "source_snapshot_checksum": snapshot_checksum,
        "items": safe_items,
    }
    plan_checksum = stable_checksum(plan_basis)
    expires = generated + datetime.timedelta(seconds=PLAN_TTL_SECONDS)
    comparison_summary = {
        "completed": bool((comparison_result or {}).get("completed")),
        "overall_readiness": (comparison_result or {}).get("overall_readiness"),
        "total_unexplained": (comparison_result or {}).get("total_unexplained"),
        "categories": {
            domain: {
                "sheets_count": values.get("sheets_count"),
                "supabase_count": values.get("supabase_count"),
                "unexplained_difference_count": values.get("unexplained_difference_count"),
            }
            for domain, values in ((comparison_result or {}).get("categories") or {}).items()
        },
    }
    return {
        "version": 1,
        "mode": "dry_run",
        "status": "blocked" if blockers else "ready",
        "project_ref": project_ref,
        "generated_at": generated.isoformat(),
        "expires_at": expires.isoformat(),
        "source_snapshot_timestamp": metadata.get("timestamp"),
        "source_snapshot_checksum": snapshot_checksum,
        "sheets_fetch_count": metadata.get("fetch_count"),
        "sheets_retry_count": metadata.get("retry_count"),
        "plan_checksum": plan_checksum,
        "provider_state": {
            "provider": os.environ.get("MTS_DATA_PROVIDER", "sheets"),
            "shadow_compare": os.environ.get("MTS_SHADOW_COMPARE", "false"),
            "dual_write": os.environ.get("MTS_DUAL_WRITE_ENABLED", "false"),
        },
        "source_rows_considered": metadata.get("source_row_count"),
        "source_tab_counts": metadata.get("tab_counts") or {},
        "canonical_projection_rows_considered": sum(len(rows) for rows in source_by_domain.values()),
        "canonical_operations": {"inserts": canonical_inserts, "updates": canonical_updates},
        "classification_counts": classification_counts,
        "entity_counts": entity_counts,
        "lineage_operations": lineage_counts,
        "derived_domain_effects": derived_effects,
        "blockers": blockers,
        "before_image_count": len(private_before_images),
        "created_entity_count": canonical_inserts,
        "rollback": {
            "eligible": not blockers,
            "migration_required": True,
            "delete_order": [
                "newbie_shift_reschedules", "session_attempts", "supervisor_transfers",
                "headset_reviews", "newbie_shift_requests", "candidate_corrections",
                "pending_requests", "candidate_sessions", "headset_catalog", "candidates",
            ],
            "guard": "exact_batch_ownership_and_post_sync_checksum_required",
        },
        "comparison": comparison_summary,
        "items": safe_items,
        "_private_before_images": private_before_images,
    }


def public_plan(plan: Mapping[str, Any], *, diagnostic: bool = False) -> dict[str, Any]:
    safe = {
        key: value for key, value in plan.items()
        if not key.startswith("_") and key not in {"items", "blockers"}
    }
    blocker_counts = {}
    for blocker in plan.get("blockers") or []:
        key = f"{blocker.get('entity_type')}:{blocker.get('reason')}"
        blocker_counts[key] = blocker_counts.get(key, 0) + 1
    safe["blocker_counts"] = blocker_counts
    if diagnostic:
        safe["items"] = list(plan.get("items") or [])
        safe["blockers"] = list(plan.get("blockers") or [])
    return safe


def validate_execution_request(
    plan: Mapping[str, Any], *, project_ref: str | None, plan_checksum: str | None,
    confirmation: str | None, environ: Mapping[str, str] | None = None,
    now: datetime.datetime | None = None,
) -> list[str]:
    env = environ if environ is not None else os.environ
    errors = []
    if project_ref != EXPECTED_SUPABASE_PROJECT_REF or plan.get("project_ref") != project_ref:
        errors.append("project_ref_mismatch")
    if not plan_checksum or plan.get("plan_checksum") != plan_checksum:
        errors.append("plan_checksum_mismatch")
    items = list(plan.get("items") or [])
    recomputed = stable_checksum({
        "version": plan.get("version"), "project_ref": plan.get("project_ref"),
        "source_snapshot_checksum": plan.get("source_snapshot_checksum"), "items": items,
    }) if "items" in plan else None
    if recomputed is None or recomputed != plan.get("plan_checksum"):
        errors.append("plan_content_checksum_mismatch")
    expected_confirmation = f"EXECUTE:{project_ref}:{plan_checksum}"
    if confirmation != expected_confirmation:
        errors.append("confirmation_token_invalid")
    if env.get(EXECUTION_ACK_ENV) != EXECUTION_ACK_VALUE:
        errors.append("task_level_execution_ack_missing")
    if env.get("MTS_DATA_PROVIDER", "sheets").strip().casefold() != "sheets":
        errors.append("provider_not_sheets")
    if env.get("MTS_SHADOW_COMPARE", "false").strip().casefold() in {"1", "true", "yes", "on"}:
        errors.append("shadow_compare_enabled")
    if env.get("MTS_DUAL_WRITE_ENABLED", "false").strip().casefold() in {"1", "true", "yes", "on"}:
        errors.append("dual_write_enabled")
    try:
        expires = datetime.datetime.fromisoformat(str(plan.get("expires_at") or "").replace("Z", "+00:00"))
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=datetime.timezone.utc)
        if _utcnow(now) >= expires:
            errors.append("plan_expired")
    except (TypeError, ValueError):
        errors.append("plan_expiration_invalid")
    if plan.get("status") != "ready" or plan.get("blockers"):
        errors.append("plan_not_ready")
    if (plan.get("lineage_operations") or {}).get("potential_source_conflict") or (plan.get("lineage_operations") or {}).get("potential_entity_conflict"):
        errors.append("lineage_conflict")
    # The forward schema is deliberately not applied in this task. Even with all
    # operator acknowledgements, execution remains impossible until it exists.
    if (plan.get("rollback") or {}).get("migration_required", True):
        errors.append("reconciliation_migration_not_applied")
    return errors


def validate_plan_freshness(
    plan: Mapping[str, Any], *, current_snapshot_checksum: str,
    current_source_checksums: Mapping[str, str], current_target_checksums: Mapping[str, str | None],
) -> list[str]:
    errors = []
    if current_snapshot_checksum != plan.get("source_snapshot_checksum"):
        errors.append("source_snapshot_changed")
    for item in plan.get("items") or []:
        safe_id = str(item.get("safe_identity_hash") or "")
        if current_source_checksums.get(safe_id) != item.get("source_checksum"):
            errors.append(f"source_checksum_changed:{safe_id}")
        expected_target = item.get("target_checksum")
        if current_target_checksums.get(safe_id) != expected_target:
            errors.append(f"target_checksum_changed:{safe_id}")
    return errors


def rollback_preview(batch: Mapping[str, Any], *, current_checksums: Mapping[str, str], later_dependencies=()) -> dict[str, Any]:
    batch = dict(batch or {})
    guards = []
    if not batch or not batch.get("batch_id"):
        guards.append("batch_not_found")
    if batch.get("status") not in {"succeeded", "partially_failed"}:
        guards.append("batch_not_rollback_eligible")
    if later_dependencies:
        guards.append("later_batch_dependency_exists")
    for item in batch.get("created_items", ()):
        safe_id = item.get("safe_identity_hash")
        if current_checksums.get(safe_id) != item.get("post_sync_checksum"):
            guards.append(f"post_sync_checksum_changed:{safe_id}")
    return {
        "mode": "dry_run",
        "eligible": not guards,
        "guards": guards,
        "restore_updates": len(batch.get("before_images", ())) if not guards else 0,
        "delete_created": len(batch.get("created_items", ())) if not guards else 0,
        "delete_order": list((batch.get("rollback") or {}).get("delete_order") or ()),
        "preserve_audit_evidence": True,
    }

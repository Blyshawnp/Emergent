from __future__ import annotations

from copy import deepcopy
import datetime
from typing import Any, Mapping

from data_providers.supabase import SupabaseDataProvider

from .core import REQUIRED_SHADOW_DOMAINS, parse_boolean
from .execution import _integer, _payload
from .reconciliation import SESSION_SOURCE_TO_CANONICAL


class ProjectedSupabaseProvider:
    """Read-only in-memory provider for a planned reconciliation."""

    name = "supabase_projected"
    lineage_write_mode = "rpc_only"

    def __init__(self, source_provider, resources, lineage_rows):
        self._url = str(getattr(source_provider, "_url", "") or "")
        self._resources = deepcopy(resources)
        self._lineage_rows = deepcopy(lineage_rows)

    def insert_lineage_if_absent(self, _row):
        raise RuntimeError("simulation_provider_is_read_only")

    def _request(self, path, *, query=None, **_kwargs):
        if path != "data_source_lineage":
            return []
        rows = list(self._lineage_rows)
        entity_type = str((query or {}).get("entity_type") or "")
        if entity_type.startswith("eq."):
            rows = [row for row in rows if str(row.get("entity_type") or "") == entity_type[3:]]
        return rows

    def list_resource(self, resource, *, filters=None, limit=1000, offset=0):
        rows = [dict(row) for row in self._resources.get(str(resource), [])]
        for key, value in (filters or {}).items():
            rows = [row for row in rows if str(row.get(key)) == str(value)]
        return rows[offset:offset + limit]


def _canonical_status(row):
    # The Sheets comparison helper mirrors the application and SQL view rules.
    from data_providers.sheets import _authoritative_status

    source = dict(row)
    calls = row.get("call_results") if isinstance(row.get("call_results"), Mapping) else {}
    transfers = row.get("supervisor_transfer_results") if isinstance(row.get("supervisor_transfer_results"), Mapping) else {}
    for number in (1, 2, 3):
        source.setdefault(f"call_{number}_result", calls.get(f"call_{number}"))
    for number in (1, 2):
        source.setdefault(f"sup_transfer_{number}_result", transfers.get(f"transfer_{number}"))
    source.setdefault("status", row.get("raw_status"))
    return _authoritative_status(source)


def _tracking_category(row):
    enriched = {**row, "authoritative_status": _canonical_status(row)}
    return SupabaseDataProvider._tracking_category(enriched)


def _replace_or_append(rows, payload, identity_field="id"):
    identity = str(payload.get(identity_field) or "")
    for index, row in enumerate(rows):
        if str(row.get(identity_field) or "") == identity:
            rows[index] = dict(payload)
            return
    rows.append(dict(payload))


def _hosted_timestamp_values(payload):
    """Model timestamptz round-tripping through the hosted REST API."""
    projected = dict(payload)
    for field, value in list(projected.items()):
        if not (field.endswith("_at") and value not in (None, "")):
            continue
        try:
            parsed = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=datetime.timezone.utc)
        projected[field] = parsed.astimezone(datetime.timezone.utc).isoformat()
    return projected


def project_reconciliation_plan(sheets_provider, supabase_provider, plan):
    """Apply a dry-run plan to in-memory canonical projections only."""
    resources = {
        domain: list(supabase_provider.list_resource(domain, limit=5000) or [])
        for domain in REQUIRED_SHADOW_DOMAINS
    }
    try:
        lineage_rows = supabase_provider._request("data_source_lineage", query={
            "select": "entity_type,entity_id,source_system,source_tab,source_row_key,source_checksum,import_batch_id",
            "limit": 5000,
        })
        lineage_rows = list(lineage_rows) if isinstance(lineage_rows, list) else []
    except Exception:
        lineage_rows = []

    private_rows = plan.get("_private_source_rows") or {}
    inserted_newbie = []
    inserted_pending = []
    for item in plan.get("items") or []:
        operation = item.get("operation")
        if operation not in {"insert", "update"}:
            continue
        entity = str(item.get("entity_type") or "")
        raw = private_rows.get(item.get("safe_identity_hash"))
        if not isinstance(raw, Mapping):
            raise ValueError("projected_source_row_missing")
        if operation == "insert":
            payload = _hosted_timestamp_values(_payload(entity, item, raw))
            if entity == "headset_catalog":
                payload["selectable"] = (
                    payload.get("status") == "approved"
                    and not payload.get("archived_at")
                    and not payload.get("deleted_at")
                )
                payload["archived"] = bool(payload.get("archived_at")) or payload.get("status") == "archived"
                payload["deleted"] = bool(payload.get("deleted_at")) or payload.get("status") == "deleted"
            _replace_or_append(resources[entity], payload)
            if entity == "newbie_shift_requests":
                inserted_newbie.append(payload)
            elif entity == "pending_requests":
                inserted_pending.append(payload)
            if item.get("lineage_required"):
                lineage_rows.append({
                    "entity_type": entity,
                    "entity_id": item.get("canonical_entity_id"),
                    "source_system": "google_sheets",
                    "source_tab": item.get("source_tab"),
                    "source_row_key": item.get("source_row_key"),
                    "source_checksum": item.get("source_checksum"),
                    "import_batch_id": "simulation-only",
                })
        elif entity == "candidate_sessions":
            target_id = str(item.get("canonical_entity_id") or "")
            target = next(
                (row for row in resources[entity] if str(row.get("id") or "") == target_id),
                None,
            )
            if target is None:
                raise ValueError("projected_update_target_missing")
            source_values = dict(raw)
            source_values["raw_status"] = raw.get("status") if raw.get("status") is not None else raw.get("raw_status")
            for field in item.get("changed_fields") or []:
                canonical_field = SESSION_SOURCE_TO_CANONICAL.get(field, field)
                value = source_values.get(field)
                if canonical_field in {"archived", "withdrawn", "final_attempt", "needs_sup_transfer"}:
                    value = parse_boolean(value)
                elif canonical_field in {"current_attempt_number", "allowed_attempt_count"}:
                    value = _integer(value)
                elif canonical_field == "completed_at":
                    value = _hosted_timestamp_values({"completed_at": value})["completed_at"]
                elif canonical_field == "session_type":
                    value = str(value or "").strip().casefold()
                target[canonical_field] = value
        elif entity == "candidate_corrections":
            if list(item.get("changed_fields") or []) != ["candidate_id"]:
                raise ValueError("projected_candidate_correction_update_fields_not_allowed")
            target_id = str(item.get("canonical_entity_id") or "")
            target = next(
                (row for row in resources[entity] if str(row.get("id") or "") == target_id),
                None,
            )
            if target is None:
                raise ValueError("projected_update_target_missing")
            target["candidate_id"] = raw.get("candidate_id")
        elif operation == "update":
            raise ValueError(f"projected_update_entity_not_supported:{entity}")

    sessions = resources["candidate_sessions"]
    status_rows = []
    history_rows = []
    for session in sessions:
        source_payload = session.get("source_payload") if isinstance(session.get("source_payload"), Mapping) else {}
        session = {
            **session,
            "newbie_shift_request_status": session.get("newbie_shift_request_status")
            or source_payload.get("newbie_shift_request_status"),
        }
        authoritative = _canonical_status(session)
        status_rows.append({
            "id": session.get("id"),
            "session_id": session.get("session_id"),
            "determining_session_id": session.get("session_id"),
            "candidate_id": session.get("candidate_id"),
            "authoritative_status": authoritative,
            "final_attempt": session.get("final_attempt"),
            "archived": session.get("archived"),
        })
        history_rows.append({
            **session,
            "authoritative_status": authoritative,
            "category": _tracking_category(session),
        })
    resources["authoritative_candidate_status"] = status_rows
    resources["candidate_tracking"] = [dict(row) for row in history_rows]
    resources["history"] = [dict(row) for row in history_rows]

    latest_by_candidate = {}
    for session in history_rows:
        candidate_id = str(session.get("candidate_id") or "")
        stamp = str(session.get("completed_at") or session.get("updated_at") or "")
        current = latest_by_candidate.get(candidate_id)
        if candidate_id and (current is None or stamp >= current[0]):
            latest_by_candidate[candidate_id] = (stamp, session)
    candidates = []
    for candidate in resources["candidates"]:
        candidate_id = str(candidate.get("id") or "")
        latest = latest_by_candidate.get(candidate_id, ("", {}))[1]
        candidates.append({
            **candidate,
            "latest_session_id": latest.get("session_id"),
            "authoritative_status": latest.get("authoritative_status"),
            "archived": latest.get("archived"),
            "comparison_candidate_id": candidate_id,
        })
    resources["candidates"] = candidates

    combined_requests = list(resources["pending_requests"])
    for row in inserted_newbie:
        combined_requests.append({
            **row,
            "request_type": row.get("request_type") or "initial_newbie_shift",
            "category": "newbie-shift-requests",
            "status": row.get("request_status"),
        })
    for row in inserted_pending:
        request_type = row.get("request_type") or "candidate_deletion"
        combined_requests.append({
            **row,
            "request_type": request_type,
            "category": row.get("category") or "candidate-deletion-requests",
            "request_status": row.get("status"),
        })
    by_request = {}
    for row in combined_requests:
        key = (str(row.get("category") or ""), str(row.get("request_id") or ""))
        if all(key):
            by_request[key] = row
    resources["pending_requests"] = list(by_request.values())
    resources["recent_activity"] = [{
        **row,
        "event_id": row.get("request_id"),
        "event_key": row.get("request_id"),
        "event_type": row.get("request_type"),
        "occurred_at": row.get("updated_at") or row.get("created_at"),
        "source_entity_id": row.get("source_session_id"),
    } for row in resources["pending_requests"]]

    provider = ProjectedSupabaseProvider(supabase_provider, resources, lineage_rows)
    provider.simulation_metadata = {
        "simulation_only": True,
        "canonical_operations": dict(plan.get("canonical_operations") or {}),
        "projected_lineage_count": len(lineage_rows),
        "source_snapshot_checksum": plan.get("source_snapshot_checksum"),
        "plan_checksum": plan.get("plan_checksum"),
    }
    return provider


def projected_readiness_summary(comparison, provider_state=None):
    """Evaluate mapped readiness without claiming hosted production health."""
    categories = comparison.get("categories") or {}
    mapped_ready = bool(
        comparison.get("completed")
        and comparison.get("overall_readiness") == "ready"
        and categories
        and all(item.get("readiness") == "ready" for item in categories.values())
    )
    state = dict(provider_state or {})
    blockers = []
    if not mapped_ready:
        blockers.append("projected_mapped_domains_not_ready")
    if str(state.get("provider", "sheets")).casefold() != "sheets":
        blockers.append("provider_not_sheets")
    if str(state.get("shadow_compare", "false")).casefold() != "false":
        blockers.append("shadow_mode_not_disabled")
    if str(state.get("dual_write", "false")).casefold() != "false":
        blockers.append("dual_write_not_disabled")
    if bool(state.get("reconciliation_migration_required")):
        blockers.append("reconciliation_migration_not_applied")
    blockers.extend(["auth_migration_not_approved", "full_cutover_not_approved"])
    return {
        "evidence_class": "simulation_only",
        "production_verified": False,
        "shadow_read_mapped_domains_ready": mapped_ready,
        "full_cutover_ready": False,
        "blockers": blockers,
    }

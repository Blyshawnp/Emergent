from __future__ import annotations

import json
from typing import Any, Mapping

from .core import parse_boolean, parse_date
from .reconciliation import SESSION_SOURCE_TO_CANONICAL, _canonical_uuid, _first, _normalized_uuid


SUPPORTED_INSERTS = (
    "candidates", "headset_catalog", "candidate_sessions", "session_attempts",
    "headset_reviews", "supervisor_transfers", "newbie_shift_requests", "pending_requests",
)
INSERT_ORDER = {name: index for index, name in enumerate(SUPPORTED_INSERTS)}
APPROVED_INSERT_COUNTS = {
    "candidates": 4, "candidate_sessions": 4, "session_attempts": 8,
    "headset_catalog": 2, "headset_reviews": 1, "supervisor_transfers": 1,
    "newbie_shift_requests": 5, "pending_requests": 3,
}
APPROVED_UPDATE_COUNTS = {"candidate_sessions": 1}


def _integer(value: Any, default=None):
    if value is None or str(value).strip() == "":
        return default
    return int(value)


def _json(value: Any, default):
    if isinstance(value, (dict, list)):
        return value
    if value in (None, ""):
        return default
    try:
        return json.loads(str(value))
    except (TypeError, ValueError, json.JSONDecodeError):
        return default


def _session_uuid(source_id: Any) -> str | None:
    value = str(source_id or "").strip()
    return _canonical_uuid("session", value) if value else None


def _payload(entity: str, item: Mapping[str, Any], raw: Mapping[str, Any]) -> dict[str, Any]:
    entity_id = item["canonical_entity_id"]
    checksum = item["source_checksum"]
    if entity == "candidates":
        return {
            "id": entity_id, "source_system": "google_sheets",
            "source_candidate_id": f"legacy_session:{str(raw.get('session_id') or '').strip()}",
            "display_name": str(raw.get("candidate_name") or "").strip(),
            "first_name": raw.get("candidate_first_name"), "last_initial": raw.get("candidate_last_initial"),
        }
    if entity == "candidate_sessions":
        return {
            "id": entity_id, "session_id": str(raw.get("session_id") or "").strip(),
            "candidate_id": raw.get("candidate_id"), "candidate_name": raw.get("candidate_name") or "",
            "candidate_first_name": raw.get("candidate_first_name"), "candidate_last_initial": raw.get("candidate_last_initial"),
            "tester_name": raw.get("tester_name"), "session_type": raw.get("session_type"),
            "attempt_number": _integer(raw.get("attempt_number")), "current_attempt_number": _integer(raw.get("current_attempt_number")),
            "allowed_attempt_count": _integer(raw.get("allowed_attempt_count")), "extra_attempts_granted": _integer(raw.get("extra_attempts_granted"), 0),
            "final_attempt": parse_boolean(raw.get("final_attempt")), "raw_status": raw.get("status") or raw.get("raw_status"),
            "calculated_result": raw.get("calculated_result"), "final_result": raw.get("final_result"),
            "readiness_override_applied": parse_boolean(raw.get("readiness_override_applied")),
            "readiness_override_result": raw.get("readiness_override_result"), "readiness_override_reason": raw.get("readiness_override_reason"),
            "readiness_override_explanation": raw.get("readiness_override_explanation"),
            "withdrawn": parse_boolean(raw.get("withdrawn")), "archived": parse_boolean(raw.get("archived")),
            "needs_sup_transfer": parse_boolean(raw.get("needs_sup_transfer")), "pending_sup_transfer_id": raw.get("pending_sup_transfer_id"),
            "mock_calls_completed": _integer(raw.get("mock_calls_completed"), 0), "sup_transfers_completed": _integer(raw.get("sup_transfers_completed"), 0),
            "call_results": {"call_1": raw.get("call_1_result"), "call_2": raw.get("call_2_result"), "call_3": raw.get("call_3_result")},
            "supervisor_transfer_results": {"transfer_1": raw.get("sup_transfer_1_result"), "transfer_2": raw.get("sup_transfer_2_result")},
            "coaching_summary": raw.get("coaching_summary"), "fail_summary": raw.get("fail_summary"), "review_notes": raw.get("review_notes"),
            "evaluator_notes_summary": raw.get("evaluator_notes_summary"), "skills": _json(raw.get("skills"), {}),
            "final_notes": {"strengths": raw.get("final_notes_strengths"), "needs_coaching": raw.get("final_notes_needs_coaching"), "other": raw.get("final_notes_other"), "history_only": raw.get("final_notes_history_only")},
            "headset_brand": raw.get("headset_brand"), "headset_model": raw.get("headset_model"),
            "headset_usb": parse_boolean(raw.get("headset_usb")), "noise_cancel": parse_boolean(raw.get("noise_cancel")), "environment_checks": {},
            "form_fill_status": raw.get("form_fill_status"), "form_filled_at": parse_date(raw.get("form_filled_at")),
            "newbie_shift_number": raw.get("newbie_shift_number"),
            "newbie_shift_data": {"scheduled_at": parse_date(raw.get("newbie_shift_scheduled_at")), "timezone": raw.get("newbie_shift_timezone"), "request_id": raw.get("newbie_shift_request_id")},
            "deletion_request_data": {"id": raw.get("deletion_request_id"), "status": raw.get("deletion_request_status"), "created_at": parse_date(raw.get("deletion_request_created_at"))},
            "created_at": parse_date(raw.get("created_at")), "completed_at": parse_date(raw.get("completed_at")),
            "withdrawn_at": parse_date(raw.get("withdrawn_at")), "retention_until": parse_date(raw.get("retention_until")),
            "source_checksum": checksum, "source_payload": dict(raw),
        }
    if entity == "session_attempts":
        parent = raw.get("source_session_id") or raw.get("session_id")
        return {
            "id": entity_id, "session_id": _session_uuid(parent),
            "attempt_number": _integer(raw.get("attempt_number")), "attempt_type": raw.get("attempt_type") or "mock_call",
            "result": raw.get("result"), "occurred_at": parse_date(raw.get("occurred_at")),
            "source_action_id": raw.get("source_action_id") or raw.get("attempt_key"), "details": _json(raw.get("details"), {}),
        }
    if entity == "headset_catalog":
        brand = str(_first(raw, ("brand", "Brand")) or "").strip()
        model = str(_first(raw, ("model", "Model")) or "").strip()
        return {"id": entity_id, "catalog_id": raw.get("catalog_id") or entity_id, "source_row_key": item["source_row_key"],
                "brand": brand, "model": model, "status": str(_first(raw, ("status", "Status")) or "unknown").strip().lower(),
                "note": _first(raw, ("note", "Note")), "legacy_source_value": raw.get("legacy_source_value"),
                "archived_at": parse_date(raw.get("archived_at")), "deleted_at": parse_date(raw.get("deleted_at")),
                "source_checksum": checksum, "source_payload": dict(raw)}
    if entity == "headset_reviews":
        source_session = raw.get("source_session_id")
        brand = _first(raw, ("brand", "Brand")); model = _first(raw, ("model", "Model"))
        return {"id": entity_id, "review_id": raw.get("review_id"), "source_session_id": source_session,
                "session_id": _session_uuid(source_session), "catalog_id": _normalized_uuid(raw.get("catalog_id")) or None,
                "candidate_name": raw.get("candidate_name"), "tester_name": raw.get("tester_name"), "brand": brand, "model": model,
                "status": str(_first(raw, ("status", "Status")) or "pending").strip().lower(), "note": _first(raw, ("note", "Note")),
                "denial_reason": raw.get("denial_reason"), "decision_by": raw.get("decision_by"), "legacy_source_value": raw.get("legacy_source_value"),
                "normalization_status": raw.get("normalization_status") or "canonical", "normalization_rule": raw.get("normalization_rule"),
                "created_at": parse_date(raw.get("created_at")), "updated_at": parse_date(raw.get("updated_at")), "decision_at": parse_date(raw.get("decision_at")),
                "source_checksum": checksum, "source_payload": dict(raw)}
    if entity == "supervisor_transfers":
        source_session = raw.get("original_session_id") or raw.get("source_session_id")
        return {"id": entity_id, "transfer_id": raw.get("pending_id") or raw.get("transfer_id"), "source_session_id": source_session,
                "session_id": _session_uuid(source_session), "candidate_name": raw.get("candidate_name"), "original_tester_name": raw.get("original_tester_name"),
                "status": raw.get("status"), "final_attempt": parse_boolean(raw.get("final_attempt")), "completed_by": raw.get("completed_by"),
                "completed_status": raw.get("completed_status"), "needed_reason": raw.get("needed_reason"), "notes": raw.get("notes"),
                "created_at": parse_date(raw.get("created_at")), "completed_at": parse_date(raw.get("completed_at")), "source_checksum": checksum, "source_payload": dict(raw)}
    if entity == "newbie_shift_requests":
        source_session = raw.get("source_session_id") or raw.get("session_id")
        return {"id": entity_id, "request_id": raw.get("request_id"), "source_session_id": source_session, "session_id": _session_uuid(source_session),
                "request_type": raw.get("request_type"), "request_status": raw.get("request_status"), "newbie_shift_number": str(raw.get("newbie_shift_number") or "").strip(),
                "scheduled_at": parse_date(raw.get("scheduled_at")), "original_scheduled_at": parse_date(raw.get("original_scheduled_at")), "rescheduled_at": parse_date(raw.get("rescheduled_at")),
                "timezone": raw.get("timezone"), "within_24_hours": parse_boolean(raw.get("within_24_hours")), "counts_as_attempt": parse_boolean(raw.get("counts_as_attempt")),
                "final_attempt": parse_boolean(raw.get("final_attempt")), "current_attempt": _integer(raw.get("current_attempt")), "resulting_attempt": _integer(raw.get("resulting_attempt")),
                "becomes_final_attempt": parse_boolean(raw.get("becomes_final_attempt")), "attempt_rule": raw.get("attempt_rule"), "terminal_outcome": raw.get("terminal_outcome"),
                "requested_by": raw.get("requested_by"), "request_reason": raw.get("request_reason"), "request_details": raw.get("request_details"),
                "decision_by": raw.get("admin_decision_by") or raw.get("decision_by"), "denial_reason": raw.get("denial_reason"),
                "created_at": parse_date(raw.get("request_created_at") or raw.get("created_at")), "decision_at": parse_date(raw.get("admin_decision_at") or raw.get("decision_at")),
                "updated_at": parse_date(raw.get("updated_at")), "source_checksum": checksum, "source_payload": dict(raw)}
    if entity == "pending_requests":
        source_session = raw.get("session_id") or raw.get("source_session_id")
        return {"id": entity_id, "request_id": raw.get("request_id"), "request_type": raw.get("request_type") or "candidate_deletion",
                "source_session_id": source_session or None, "session_id": _session_uuid(source_session),
                "status": raw.get("request_status") or raw.get("status") or "pending", "candidate_name": raw.get("candidate_name") or raw.get("candidate"),
                "tester_name": raw.get("tester_name") or raw.get("tester"), "request_reason": raw.get("request_reason") or raw.get("reason"),
                "request_details": raw.get("request_details") if isinstance(raw.get("request_details"), dict) else {},
                "requested_by": raw.get("requested_by") or raw.get("tester_name"), "decision_by": raw.get("admin_decision_by") or raw.get("decision_by"),
                "denial_reason": raw.get("denial_reason"), "created_at": parse_date(raw.get("request_created_at") or raw.get("created_at")),
                "decision_at": parse_date(raw.get("admin_decision_at") or raw.get("decision_at")), "updated_at": parse_date(raw.get("updated_at")),
                "source_checksum": checksum, "source_payload": dict(raw)}
    raise ValueError(f"unsupported_reconciliation_entity:{entity}")


def approved_plan_errors(plan: Mapping[str, Any]) -> list[str]:
    insert_counts: dict[str, int] = {}
    update_counts: dict[str, int] = {}
    for item in plan.get("items") or []:
        if item.get("classification") == "insert_new":
            insert_counts[item["entity_type"]] = insert_counts.get(item["entity_type"], 0) + 1
        elif item.get("classification") == "update_existing":
            update_counts[item["entity_type"]] = update_counts.get(item["entity_type"], 0) + 1
    errors = []
    if insert_counts != APPROVED_INSERT_COUNTS:
        errors.append("approved_insert_shape_mismatch")
    if update_counts != APPROVED_UPDATE_COUNTS:
        errors.append("approved_update_shape_mismatch")
    if (plan.get("lineage_operations") or {}).get("expected_new") != 28:
        errors.append("approved_lineage_shape_mismatch")
    if plan.get("canonical_operations") != {"inserts": 28, "updates": 1}:
        errors.append("canonical_operation_count_mismatch")
    if plan.get("created_entity_count") != 28 or plan.get("before_image_count") != 1:
        errors.append("rollback_evidence_shape_mismatch")
    for item in plan.get("items") or []:
        if item.get("classification") in {"insert_new", "update_existing"} and not all(
            item.get(key) not in (None, "") for key in ("canonical_entity_id", "source_tab", "source_row_key", "source_checksum")
        ):
            errors.append("executable_item_binding_incomplete")
            break
    return errors


def _insert_expected_values(entity: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    identity_fields = {
        "candidates": ("id", "source_system", "source_candidate_id"),
        "candidate_sessions": ("id", "session_id", "candidate_id", "source_checksum"),
        "session_attempts": ("id", "session_id", "attempt_number", "attempt_type", "source_action_id"),
        "headset_catalog": ("id", "catalog_id", "source_row_key", "brand", "model", "status", "source_checksum"),
        "headset_reviews": ("id", "review_id", "source_session_id", "status", "source_checksum"),
        "supervisor_transfers": ("id", "transfer_id", "source_session_id", "status", "source_checksum"),
        "newbie_shift_requests": ("id", "request_id", "source_session_id", "request_status", "source_checksum"),
        "pending_requests": ("id", "request_id", "request_type", "source_session_id", "status", "source_checksum"),
    }
    return {key: payload.get(key) for key in identity_fields[entity]}


def execute_plan(provider, plan: Mapping[str, Any]) -> dict[str, Any]:
    executable = [dict(item) for item in plan.get("items") or [] if item.get("operation") in {"insert", "update"}]
    executable.sort(key=lambda item: (0 if item["operation"] == "insert" else 1, INSERT_ORDER.get(item["entity_type"], 99), item["safe_identity_hash"]))
    start = provider.begin_reconciliation_execution(plan, executable)
    batch_id = start["batch_id"]
    ids = {row["safe_identity_hash"]: row["id"] for row in start.get("items") or []}
    sources = plan.get("_private_source_rows") or {}
    completed = []
    current_id = None
    try:
        for item in executable:
            current_id = ids[item["safe_identity_hash"]]
            raw = sources[item["safe_identity_hash"]]
            if item["operation"] == "insert":
                payload = _payload(item["entity_type"], item, raw)
                expected = _insert_expected_values(item["entity_type"], payload)
                lineage = {"entity_type": item["entity_type"], "source_system": "google_sheets", "source_tab": item["source_tab"],
                           "source_row_key": item["source_row_key"], "source_checksum": item["source_checksum"], "metadata": {"identity_bound": True}}
                completed.append(provider.execute_reconciliation_insert(batch_id, current_id, payload, expected, lineage))
            else:
                source_values = dict(raw)
                source_values["raw_status"] = raw.get("status") if raw.get("status") is not None else raw.get("raw_status")
                changes = {SESSION_SOURCE_TO_CANONICAL.get(field, field): source_values.get(field) for field in item["changed_fields"]}
                for field in ("archived", "withdrawn", "final_attempt", "needs_sup_transfer"):
                    if field in changes:
                        changes[field] = parse_boolean(changes[field])
                for field in ("current_attempt_number", "allowed_attempt_count"):
                    if field in changes:
                        changes[field] = _integer(changes[field])
                before = next((image for image in plan.get("_private_before_images") or []
                               if image.get("safe_identity_hash") == item["safe_identity_hash"]), None)
                if before is None:
                    raise ValueError("planned_before_image_missing")
                precondition = (plan.get("_private_target_preconditions") or {}).get(item["safe_identity_hash"])
                if not precondition:
                    raise ValueError("target_precondition_missing")
                completed.append(provider.execute_reconciliation_candidate_session_update(batch_id, current_id, precondition, changes, changes))
        final = provider.finalize_reconciliation_batch(batch_id)
        return {"batch_id": batch_id, "completed": len(completed), "result": final}
    except Exception as exc:
        provider.fail_reconciliation_batch(batch_id, current_id, type(exc).__name__)
        raise

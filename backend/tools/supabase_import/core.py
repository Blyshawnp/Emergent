from __future__ import annotations

import datetime
import hashlib
import json
import logging
import re
import uuid
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence

logger = logging.getLogger(__name__)

IDENTITY_FIELDS = (
    "session_id", "review_id", "request_id", "pending_id", "ID", "VideoKey",
    "notification_id", "catalog_id",
)

TAB_IDENTITY_FIELDS = {
    "Candidate Sessions": ("session_id",),
    "headset-review-log": ("review_id",),
    "newbie-shift-requests": ("request_id",),
    "candidate-deletion-requests": ("request_id",),
    "candidate-information-correction-requests": ("request_id",),
    "Pending Sup Transfers": ("pending_id",),
    "sam-notifications": ("ID",),
}

EXPECTED_LAZY_CANDIDATE_HEADERS = (
    "extra_attempts_granted", "allowed_attempt_count", "current_attempt_number",
    "extra_attempt_last_action_id", "extra_attempt_granted_by", "extra_attempt_granted_at",
    "readiness_override_by", "readiness_override_at", "newbie_shift_number",
)


def normalized_text(value: Any) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value).strip()).casefold()


def stable_checksum(row: Mapping[str, Any]) -> str:
    payload = json.dumps(dict(row), sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def deterministic_source_key(tab: str, row_number: int, row: Mapping[str, Any]):
    if tab == "headsets":
        brand = str(row.get("Brand") or "").strip()
        model = str(row.get("Model") or "").strip()
        if brand and model:
            return f"headset:{brand}:{model}", None

    for field in TAB_IDENTITY_FIELDS.get(tab, IDENTITY_FIELDS):
        value = str(row.get(field) or "").strip()
        if value:
            return f"{field}:{value}", None
    checksum = stable_checksum(row)
    return f"row:{row_number}:{checksum}", "missing_exact_identity_used_row_number_and_checksum"


def deterministic_catalog_id(source_row_key: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"mts-sam:headset-catalog:{source_row_key}"))


def parse_boolean(value: Any):
    if value is None or str(value).strip() == "":
        return None
    normalized = normalized_text(value)
    if normalized in {"true", "yes", "y", "1", "enabled", "approved"}:
        return True
    if normalized in {"false", "no", "n", "0", "disabled", "denied"}:
        return False
    raise ValueError(f"unrecognized_boolean: {value!r}")


def parse_date(val: Any) -> str | None:
    if val is None or str(val).strip() == "":
        return None
    val_str = str(val).strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d"):
        try:
            dt = datetime.datetime.strptime(val_str, fmt)
            return dt.isoformat()
        except ValueError:
            continue
    if re.match(r"^\d{4}-\d{2}-\d{2}", val_str):
        return val_str
    return None


def parse_datetime(date_val: Any, time_val: Any) -> str | None:
    d = str(date_val or "").strip()
    t = str(time_val or "").strip()
    if not d:
        return None
    if not t:
        return parse_date(d)
    if "T" in d:
        date_part = d.split("T")[0]
    elif "t" in d:
        date_part = d.split("t")[0]
    else:
        date_part = d
    if "T" in t:
        time_part = t.split("T")[1]
    elif "t" in t:
        time_part = t.split("t")[1]
    else:
        time_part = t
    combined = f"{date_part}T{time_part}"
    return parse_date(combined)


def deterministic_uuid(namespace: str, name: str) -> str:
    ns = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
    return str(uuid.uuid5(ns, f"mts-sam:{namespace}:{name}"))


@dataclass(frozen=True)
class StagedRow:
    source_tab: str
    source_row_number: int
    source_row_key: str
    source_record_id: str | None
    source_checksum: str
    raw_row: Mapping[str, Any]
    header_presence: Mapping[str, bool]
    fallback_reason: str | None


def stage_rows(tab: str, headers: Sequence[str], rows: Iterable[Mapping[str, Any]]) -> list[StagedRow]:
    staged = []
    seen_keys = set()
    for row_number, row in enumerate(rows, start=2):
        row_copy = dict(row)
        key, fallback = deterministic_source_key(tab, row_number, row_copy)
        if key in seen_keys:
            key = f"{key}:dup:{row_number}"
            fallback = "duplicate_identity_in_source_tab"
        seen_keys.add(key)
        record_id = next((str(row_copy.get(field)).strip() for field in IDENTITY_FIELDS if str(row_copy.get(field) or "").strip()), None)
        staged.append(StagedRow(
            source_tab=tab,
            source_row_number=row_number,
            source_row_key=key,
            source_record_id=record_id,
            source_checksum=stable_checksum(row_copy),
            raw_row=row_copy,
            header_presence={header: header in headers for header in headers},
            fallback_reason=fallback,
        ))
    return staged


LINEAGE_RPC_OUTCOMES = {
    "inserted",
    "already_exists_same_mapping",
    "conflict_source_maps_to_different_entity",
    "conflict_entity_maps_to_different_source",
}


def safe_upsert_lineage(provider, lineage_rows) -> dict[str, Any]:
    """Insert lineage exclusively through the database-authoritative RPC."""
    rpc = getattr(provider, "insert_lineage_if_absent", None)
    if not callable(rpc):
        raise RuntimeError("lineage_rpc_unavailable")

    result: dict[str, Any] = {
        "processed": 0,
        "inserted": 0,
        "already_exists": 0,
        "already_exists_same_mapping": 0,
        "conflict_source_maps_to_different_entity": 0,
        "conflict_entity_maps_to_different_source": 0,
        "conflicts": [],
    }
    for row in lineage_rows:
        response = rpc(row)
        outcome = response.get("result") if isinstance(response, Mapping) else None
        if outcome not in LINEAGE_RPC_OUTCOMES:
            raise RuntimeError("lineage_rpc_malformed_response")
        result["processed"] += 1
        result[outcome] += 1
        if outcome == "already_exists_same_mapping":
            result["already_exists"] += 1
        elif outcome.startswith("conflict_"):
            safe_reference = stable_checksum({
                "source_system": row.get("source_system"),
                "source_tab": row.get("source_tab"),
                "source_row_key": row.get("source_row_key"),
                "entity_type": row.get("entity_type"),
                "entity_id": row.get("entity_id"),
            })
            result["conflicts"].append({
                "result": outcome,
                "import_batch_id": row.get("import_batch_id"),
                "entity_type": row.get("entity_type"),
                "safe_reference": safe_reference,
            })
    return result


def _merge_lineage_result(load_result: dict[str, Any], lineage_result: Mapping[str, Any]):
    summary = load_result.setdefault("lineage", {
        "processed": 0,
        "inserted": 0,
        "already_exists_same_mapping": 0,
        "conflict_source_maps_to_different_entity": 0,
        "conflict_entity_maps_to_different_source": 0,
        "conflicts": [],
    })
    for key in (
        "processed", "inserted", "already_exists_same_mapping",
        "conflict_source_maps_to_different_entity",
        "conflict_entity_maps_to_different_source",
    ):
        summary[key] += int(lineage_result.get(key, 0))
    summary["conflicts"].extend(lineage_result.get("conflicts") or [])


def catalog_display(brand: Any, model: Any) -> str:
    brand_text = re.sub(r"\s+", " ", str(brand or "").strip())
    model_text = re.sub(r"\s+", " ", str(model or "").strip())
    if brand_text and normalized_text(model_text).startswith(normalized_text(brand_text) + " "):
        return model_text
    return " ".join(part for part in (brand_text, model_text) if part)


def build_catalog_match_index(catalog_rows: Iterable[Mapping[str, Any]]):
    index: dict[str, list[tuple[str, str]]] = {}
    for row in catalog_rows:
        brand = str(row.get("Brand") or "").strip()
        model = str(row.get("Model") or "").strip()
        if not brand or not model:
            continue
        index.setdefault(normalized_text(catalog_display(brand, model)), []).append((brand, model))
    return index


def normalize_headset_review(row: Mapping[str, Any], catalog_index):
    result = dict(row)
    brand = str(row.get("Brand") or "").strip()
    model = str(row.get("Model") or "").strip()
    if brand:
        result.update({"brand": brand, "model": model, "normalization_status": "canonical", "normalization_rule": None})
        return result
    matches = catalog_index.get(normalized_text(model), [])
    if model and len(matches) == 1:
        matched_brand, matched_model = matches[0]
        result.update({
            "brand": matched_brand,
            "model": matched_model,
            "legacy_source_value": model,
            "normalization_status": "deterministic_catalog_match",
            "normalization_rule": "exact_normalized_catalog_display_match",
        })
        return result
    result.update({
        "brand": None,
        "model": model,
        "legacy_source_value": model or None,
        "normalization_status": "unresolved_legacy_brand" if model else "invalid",
        "normalization_rule": None,
    })
    return result


def missing_candidate_headers(headers: Sequence[str]) -> list[str]:
    present = set(headers)
    return [header for header in EXPECTED_LAZY_CANDIDATE_HEADERS if header not in present]


def validate_staged_rows(provider, batch_id: str):
    logger.info("Validating staged rows for batch_id: %s", batch_id)
    staged_rows = provider._request("import_staging_rows", query={"import_batch_id": f"eq.{batch_id}"})
    if not staged_rows:
        return

    updated_staged = []
    for row in staged_rows:
        tab = row["source_tab"]
        raw = row["raw_row"] or {}

        id_val = row["source_record_id"]
        if not id_val and tab != "headsets":
            status = "unresolved"
            fallback = "missing_exact_identity"
        else:
            status = "valid"
            fallback = None

        if tab == "Candidate Sessions":
            att = raw.get("attempt_number")
            allowed = raw.get("allowed_attempt_count") or 3
            try:
                if att is not None and int(str(att).strip()) <= 0:
                    status = "rejected"
                    fallback = "invalid_attempt_number"
                elif allowed is not None and int(str(allowed).strip()) <= 0:
                    status = "rejected"
                    fallback = "invalid_allowed_attempt_count"
            except ValueError:
                status = "rejected"
                fallback = "malformed_attempt_values"

        elif tab == "headsets":
            brand = str(raw.get("Brand") or "").strip()
            model = str(raw.get("Model") or "").strip()
            if not brand or not model:
                status = "rejected"
                fallback = "blank_brand_or_model"

        elif tab == "sam-authorized-users":
            name = str(raw.get("name") or "").strip()
            role = str(raw.get("role") or "").strip()
            if not name or role not in {"evaluator", "administrator", "viewer"}:
                status = "rejected"
                fallback = "invalid_user_or_role"

        elif tab == "sam-notifications":
            notif_id = str(raw.get("ID") or "").strip()
            if not notif_id:
                status = "rejected"
                fallback = "blank_notification_id"

        if row["unresolved_reason_code"] == "duplicate_identity_in_source_tab":
            status = "duplicate"
            fallback = "duplicate_identity_in_source_tab"

        updated_row = dict(row)
        updated_row["normalization_status"] = status
        updated_row["unresolved_reason_code"] = fallback
        updated_staged.append(updated_row)

    for start in range(0, len(updated_staged), 100):
        provider.upsert_rows("import_staging_rows", updated_staged[start:start+100], on_conflict="id")


def transform_and_load_batch(provider, batch_id: str, dry_run=False) -> dict[str, Any]:
    logger.info("Transforming and loading batch: %s (dry_run=%s)", batch_id, dry_run)
    staged_rows = provider._request("import_staging_rows", query={"import_batch_id": f"eq.{batch_id}"})

    catalog_rows = [r["raw_row"] for r in staged_rows if r["source_tab"] == "headsets" and r["normalization_status"] == "valid"]
    catalog_index = build_catalog_match_index(catalog_rows)
    valid_catalog_ids = {deterministic_catalog_id(f"{str(r.get('Brand') or '').strip()}:{str(r.get('Model') or '').strip()}") for r in catalog_rows}

    results = {
        "inserted": 0, "updated": 0, "skipped": 0, "unresolved": 0, "duplicate": 0, "rejected": 0, "failed": 0
    }

    # 1. users
    users_payload = []
    assignments_payload = []
    user_lineage = []
    for r in staged_rows:
        if r["source_tab"] != "sam-authorized-users" or r["normalization_status"] != "valid":
            continue
        raw = r["raw_row"]
        u_uuid = deterministic_uuid("user", raw["name"])
        users_payload.append({
            "id": u_uuid,
            "display_name": raw["name"],
            "active": parse_boolean(raw.get("enabled", True)),
            "source_system": "google_sheets",
            "source_user_id": raw["name"],
            "metadata": {"pin": raw.get("pin"), "installed": raw.get("installed"), "device_name": raw.get("device_name")}
        })
        assignments_payload.append({
            "user_id": u_uuid,
            "role_key": raw["role"],
        })
        user_lineage.append({
            "entity_type": "app_users",
            "entity_id": u_uuid,
            "source_system": "google_sheets",
            "source_tab": r["source_tab"],
            "source_row_key": r["source_row_key"],
            "source_checksum": r["source_checksum"],
            "import_batch_id": batch_id,
            "metadata": {"created_by_batch_id": batch_id}
        })

    if users_payload and not dry_run:
        provider.upsert_rows("app_users", users_payload, on_conflict="source_system,source_user_id")
        provider.upsert_rows("user_role_assignments", assignments_payload, on_conflict="user_id,role_key")
        _merge_lineage_result(results, safe_upsert_lineage(provider, user_lineage))
        results["inserted"] += len(users_payload)

    # 2. candidates & headset catalog
    cand_payload = []
    cand_lineage = []
    headset_payload = []
    headset_lineage = []

    for r in staged_rows:
        if r["source_tab"] == "Candidate Sessions" and r["normalization_status"] in {"valid", "unresolved"}:
            raw = r["raw_row"]
            name = str(raw.get("candidate_name") or "").strip()
            if name:
                c_uuid = deterministic_uuid("candidate", name)
                cand_payload.append({
                    "id": c_uuid,
                    "display_name": name,
                    "first_name": raw.get("candidate_first_name"),
                    "last_initial": raw.get("candidate_last_initial"),
                    "source_system": "google_sheets",
                    "source_candidate_id": name
                })
                cand_lineage.append({
                    "entity_type": "candidates",
                    "entity_id": c_uuid,
                    "source_system": "google_sheets",
                    "source_tab": r["source_tab"],
                    "source_row_key": f"candidate:{name}",
                    "source_checksum": r["source_checksum"],
                    "import_batch_id": batch_id,
                    "metadata": {"created_by_batch_id": batch_id}
                })
        elif r["source_tab"] == "headsets" and r["normalization_status"] == "valid":
            raw = r["raw_row"]
            brand = str(raw.get("Brand") or "").strip()
            model = str(raw.get("Model") or "").strip()
            h_uuid = deterministic_catalog_id(f"{brand}:{model}")
            headset_payload.append({
                "id": h_uuid,
                "catalog_id": raw.get("catalog_id") or h_uuid,
                "source_row_key": r["source_row_key"],
                "brand": brand,
                "model": model,
                "status": str(raw.get("Status") or "unknown").strip().lower(),
                "note": raw.get("Note"),
                "source_checksum": r["source_checksum"],
                "source_payload": raw
            })
            headset_lineage.append({
                "entity_type": "headset_catalog",
                "entity_id": h_uuid,
                "source_system": "google_sheets",
                "source_tab": r["source_tab"],
                "source_row_key": r["source_row_key"],
                "source_checksum": r["source_checksum"],
                "import_batch_id": batch_id,
                "metadata": {"created_by_batch_id": batch_id}
            })

    if cand_payload and not dry_run:
        unique_cand = {c["id"]: c for c in cand_payload}.values()
        provider.upsert_rows("candidates", unique_cand, on_conflict="source_system,source_candidate_id")
        _merge_lineage_result(results, safe_upsert_lineage(provider, list({l["entity_id"]: l for l in cand_lineage}.values())))
        results["inserted"] += len(unique_cand)
    if headset_payload and not dry_run:
        provider.upsert_rows("headset_catalog", headset_payload, on_conflict="brand,model")
        _merge_lineage_result(results, safe_upsert_lineage(provider, headset_lineage))
        results["inserted"] += len(headset_payload)

    # 3. candidate sessions & attempts
    sessions_payload = []
    attempts_payload = []
    sessions_lineage = []
    actions_payload = []
    grants_payload = []

    for r in staged_rows:
        if r["source_tab"] != "Candidate Sessions" or r["normalization_status"] not in {"valid", "unresolved"}:
            continue
        raw = r["raw_row"]
        sess_id = raw.get("session_id")
        if not sess_id:
            results["unresolved"] += 1
            continue

        s_uuid = deterministic_uuid("session", sess_id)
        c_uuid = deterministic_uuid("candidate", raw.get("candidate_name", ""))

        sessions_payload.append({
            "id": s_uuid,
            "session_id": sess_id,
            "candidate_id": c_uuid,
            "candidate_name": raw.get("candidate_name", ""),
            "candidate_first_name": raw.get("candidate_first_name"),
            "candidate_last_initial": raw.get("candidate_last_initial"),
            "tester_name": raw.get("tester_name"),
            "session_type": raw.get("session_type"),
            "attempt_number": int(raw["attempt_number"]) if raw.get("attempt_number") else None,
            "current_attempt_number": int(raw["current_attempt_number"]) if raw.get("current_attempt_number") else None,
            "allowed_attempt_count": int(raw["allowed_attempt_count"]) if raw.get("allowed_attempt_count") else None,
            "extra_attempts_granted": int(raw["extra_attempts_granted"]) if raw.get("extra_attempts_granted") else 0,
            "final_attempt": parse_boolean(raw.get("final_attempt")),
            "raw_status": raw.get("status"),
            "calculated_result": raw.get("calculated_result"),
            "final_result": raw.get("final_result"),
            "readiness_override_applied": parse_boolean(raw.get("readiness_override_applied")),
            "readiness_override_result": raw.get("readiness_override_result"),
            "readiness_override_reason": raw.get("readiness_override_reason"),
            "readiness_override_explanation": raw.get("readiness_override_explanation"),
            "withdrawn": parse_boolean(raw.get("withdrawn")),
            "archived": parse_boolean(raw.get("archived")),
            "needs_sup_transfer": parse_boolean(raw.get("needs_sup_transfer")),
            "pending_sup_transfer_id": raw.get("pending_sup_transfer_id"),
            "mock_calls_completed": int(raw["mock_calls_completed"]) if raw.get("mock_calls_completed") else 0,
            "sup_transfers_completed": int(raw["sup_transfers_completed"]) if raw.get("sup_transfers_completed") else 0,
            "coaching_summary": raw.get("coaching_summary"),
            "fail_summary": raw.get("fail_summary"),
            "review_notes": raw.get("review_notes"),
            "evaluator_notes_summary": raw.get("evaluator_notes_summary"),
            "skills": json.loads(raw["skills"]) if raw.get("skills") else {},
            "headset_brand": raw.get("headset_brand"),
            "headset_model": raw.get("headset_model"),
            "headset_usb": parse_boolean(raw.get("headset_usb")),
            "noise_cancel": parse_boolean(raw.get("noise_cancel")),
            "form_fill_status": raw.get("form_fill_status"),
            "form_filled_at": parse_date(raw.get("form_filled_at")),
            "newbie_shift_number": raw.get("newbie_shift_number"),
            "newbie_shift_data": {
                "scheduled_at": parse_date(raw.get("newbie_shift_scheduled_at")),
                "timezone": raw.get("newbie_shift_timezone"),
                "request_id": raw.get("newbie_shift_request_id")
            },
            "deletion_request_data": {
                "id": raw.get("deletion_request_id"),
                "status": raw.get("deletion_request_status"),
                "created_at": parse_date(raw.get("deletion_request_created_at"))
            },
            "created_at": parse_date(raw.get("created_at")),
            "completed_at": parse_date(raw.get("completed_at")),
            "withdrawn_at": parse_date(raw.get("withdrawn_at")),
            "retention_until": parse_date(raw.get("retention_until")),
            "source_checksum": r["source_checksum"],
            "source_payload": raw,
            "call_results": {
                "call_1": raw.get("call_1_result"),
                "call_2": raw.get("call_2_result"),
                "call_3": raw.get("call_3_result")
            },
            "supervisor_transfer_results": {
                "transfer_1": raw.get("sup_transfer_1_result"),
                "transfer_2": raw.get("sup_transfer_2_result")
            },
            "final_notes": {
                "strengths": raw.get("final_notes_strengths"),
                "needs_coaching": raw.get("final_notes_needs_coaching"),
                "other": raw.get("final_notes_other"),
                "history_only": raw.get("final_notes_history_only")
            }
        })

        for attempt_no, key in [(1, "call_1_result"), (2, "call_2_result"), (3, "call_3_result")]:
            val = raw.get(key)
            if val:
                attempts_payload.append({
                    "session_id": s_uuid,
                    "attempt_number": attempt_no,
                    "attempt_type": "mock_call",
                    "result": val,
                    "occurred_at": parse_date(raw.get("completed_at") or raw.get("created_at")),
                    "source_action_id": f"google_sheets:attempt:{sess_id}:{attempt_no}"
                })

        if parse_boolean(raw.get("readiness_override_applied")):
            actions_payload.append({
                "action_id": deterministic_uuid("override", sess_id),
                "session_id": s_uuid,
                "action_type": "readiness_override",
                "result": raw.get("readiness_override_result"),
                "reason": raw.get("readiness_override_reason"),
                "actor_name": raw.get("readiness_override_by") or "system",
                "occurred_at": parse_date(raw.get("readiness_override_at") or raw.get("completed_at") or raw.get("created_at")),
                "source_provider": "google_sheets"
            })

        if raw.get("extra_attempts_granted") and int(raw["extra_attempts_granted"]) > 0:
            grants_payload.append({
                "action_id": deterministic_uuid("grant", sess_id),
                "session_id": s_uuid,
                "source_session_id": sess_id,
                "granted_count": int(raw["extra_attempts_granted"]),
                "resulting_allowed_attempt_count": int(raw.get("allowed_attempt_count") or 3),
                "reason": raw.get("extra_attempt_reason"),
                "granted_by": raw.get("extra_attempt_granted_by") or "system",
                "granted_at": parse_date(raw.get("extra_attempt_granted_at") or raw.get("created_at")),
                "source_provider": "google_sheets"
            })

        sessions_lineage.append({
            "entity_type": "candidate_sessions",
            "entity_id": s_uuid,
            "source_system": "google_sheets",
            "source_tab": r["source_tab"],
            "source_row_key": r["source_row_key"],
            "source_checksum": r["source_checksum"],
            "import_batch_id": batch_id,
            "metadata": {"created_by_batch_id": batch_id}
        })

    if sessions_payload and not dry_run:
        provider.upsert_rows("candidate_sessions", sessions_payload, on_conflict="session_id")
        _merge_lineage_result(results, safe_upsert_lineage(provider, sessions_lineage))
        results["inserted"] += len(sessions_payload)
    if attempts_payload and not dry_run:
        provider.upsert_rows("session_attempts", attempts_payload, on_conflict="session_id,attempt_number,attempt_type")
    if actions_payload and not dry_run:
        provider.upsert_rows("candidate_status_actions", actions_payload, on_conflict="action_id", resolution="ignore-duplicates")
    if grants_payload and not dry_run:
        provider.upsert_rows("extra_attempt_grants", grants_payload, on_conflict="action_id", resolution="ignore-duplicates")

    # Fetch existing IDs for foreign key safety
    valid_session_ids = set()
    valid_candidate_ids = set()
    if not dry_run:
        valid_session_ids = {s["id"] for s in provider._request("candidate_sessions", query={"select": "id"})}
        valid_candidate_ids = {c["id"] for c in provider._request("candidates", query={"select": "id"})}

    # 4. headset reviews
    reviews_payload = []
    reviews_lineage = []
    for r in staged_rows:
        if r["source_tab"] != "headset-review-log" or r["normalization_status"] not in {"valid", "unresolved", "deterministic_catalog_match", "unresolved_legacy_brand"}:
            continue
        raw = r["raw_row"]
        rev_id = raw.get("review_id")
        if not rev_id:
            continue

        norm = normalize_headset_review(raw, catalog_index)

        s_uuid = deterministic_uuid("session", raw.get("source_session_id", ""))
        re_session_id = None
        if raw.get("source_session_id") and s_uuid in valid_session_ids:
            re_session_id = s_uuid
        h_uuid = None
        if norm["brand"] and norm["model"]:
            possible_id = deterministic_catalog_id(f"{norm['brand']}:{norm['model']}")
            if possible_id in valid_catalog_ids:
                h_uuid = possible_id

        re_uuid = deterministic_uuid("review", rev_id)
        reviews_payload.append({
            "id": re_uuid,
            "review_id": rev_id,
            "source_session_id": raw.get("source_session_id"),
            "session_id": re_session_id,
            "catalog_id": h_uuid,
            "candidate_name": raw.get("candidate_name"),
            "tester_name": raw.get("tester_name"),
            "brand": norm["brand"],
            "model": norm["model"],
            "status": str(raw.get("Status") or "pending").strip().lower(),
            "note": raw.get("Note"),
            "denial_reason": raw.get("denial_reason"),
            "decision_by": raw.get("decision_by"),
            "legacy_source_value": norm.get("legacy_source_value"),
            "normalization_status": norm["normalization_status"],
            "normalization_rule": norm.get("normalization_rule"),
            "created_at": parse_date(raw.get("created_at")),
            "updated_at": parse_date(raw.get("updated_at")),
            "decision_at": parse_date(raw.get("decision_at")),
            "source_checksum": r["source_checksum"],
            "source_payload": raw
        })
        reviews_lineage.append({
            "entity_type": "headset_reviews",
            "entity_id": re_uuid,
            "source_system": "google_sheets",
            "source_tab": r["source_tab"],
            "source_row_key": r["source_row_key"],
            "source_checksum": r["source_checksum"],
            "import_batch_id": batch_id,
            "metadata": {"created_by_batch_id": batch_id}
        })

    if reviews_payload and not dry_run:
        provider.upsert_rows("headset_reviews", reviews_payload, on_conflict="review_id")
        _merge_lineage_result(results, safe_upsert_lineage(provider, reviews_lineage))
        results["inserted"] += len(reviews_payload)

    # 5. supervisor transfers
    transfers_payload = []
    transfers_lineage = []
    for r in staged_rows:
        if r["source_tab"] != "Pending Sup Transfers" or r["normalization_status"] != "valid":
            continue
        raw = r["raw_row"]
        p_id = raw.get("pending_id")
        if not p_id:
            continue
        tr_uuid = deterministic_uuid("transfer", p_id)
        s_uuid = deterministic_uuid("session", raw.get("original_session_id", ""))
        tr_session_id = None
        if raw.get("original_session_id") and s_uuid in valid_session_ids:
            tr_session_id = s_uuid
        transfers_payload.append({
            "id": tr_uuid,
            "transfer_id": p_id,
            "source_session_id": raw.get("original_session_id"),
            "session_id": tr_session_id,
            "candidate_name": raw.get("candidate_name"),
            "original_tester_name": raw.get("original_tester_name"),
            "status": raw.get("status"),
            "final_attempt": parse_boolean(raw.get("final_attempt")),
            "completed_by": raw.get("completed_by"),
            "completed_status": raw.get("completed_status"),
            "needed_reason": raw.get("needed_reason"),
            "notes": raw.get("notes"),
            "created_at": parse_date(raw.get("created_at")),
            "completed_at": parse_date(raw.get("completed_at")),
            "source_checksum": r["source_checksum"],
            "source_payload": raw
        })
        transfers_lineage.append({
            "entity_type": "supervisor_transfers",
            "entity_id": tr_uuid,
            "source_system": "google_sheets",
            "source_tab": r["source_tab"],
            "source_row_key": r["source_row_key"],
            "source_checksum": r["source_checksum"],
            "import_batch_id": batch_id,
            "metadata": {"created_by_batch_id": batch_id}
        })

    if transfers_payload and not dry_run:
        provider.upsert_rows("supervisor_transfers", transfers_payload, on_conflict="transfer_id")
        _merge_lineage_result(results, safe_upsert_lineage(provider, transfers_lineage))
        results["inserted"] += len(transfers_payload)

    # 6. newbie shift requests
    shifts_payload = []
    shifts_lineage = []
    reschedules_payload = []
    for r in staged_rows:
        if r["source_tab"] != "newbie-shift-requests" or r["normalization_status"] != "valid":
            continue
        raw = r["raw_row"]
        req_id = raw.get("request_id")
        if not req_id:
            continue
        sh_uuid = deterministic_uuid("shift_request", req_id)
        s_uuid = deterministic_uuid("session", raw.get("session_id", ""))
        sh_session_id = None
        if raw.get("session_id") and s_uuid in valid_session_ids:
            sh_session_id = s_uuid
        shifts_payload.append({
            "id": sh_uuid,
            "request_id": req_id,
            "source_session_id": raw.get("session_id"),
            "session_id": sh_session_id,
            "request_type": raw.get("request_type"),
            "request_status": raw.get("request_status"),
            "newbie_shift_number": str(raw.get("newbie_shift_number") or "").strip(),
            "scheduled_at": parse_date(raw.get("scheduled_at")),
            "original_scheduled_at": parse_date(raw.get("original_scheduled_at")),
            "rescheduled_at": parse_date(raw.get("rescheduled_at")),
            "timezone": raw.get("timezone"),
            "within_24_hours": parse_boolean(raw.get("within_24_hours")),
            "counts_as_attempt": parse_boolean(raw.get("counts_as_attempt")),
            "final_attempt": parse_boolean(raw.get("final_attempt")),
            "current_attempt": int(raw["current_attempt"]) if raw.get("current_attempt") else None,
            "resulting_attempt": int(raw["resulting_attempt"]) if raw.get("resulting_attempt") else None,
            "becomes_final_attempt": parse_boolean(raw.get("becomes_final_attempt")),
            "attempt_rule": raw.get("attempt_rule"),
            "terminal_outcome": raw.get("terminal_outcome"),
            "requested_by": raw.get("requested_by"),
            "request_reason": raw.get("request_reason"),
            "request_details": raw.get("request_details"),
            "decision_by": raw.get("admin_decision_by"),
            "denial_reason": raw.get("denial_reason"),
            "created_at": parse_date(raw.get("request_created_at")),
            "decision_at": parse_date(raw.get("admin_decision_at")),
            "updated_at": parse_date(raw.get("updated_at")),
            "source_checksum": r["source_checksum"],
            "source_payload": raw
        })
        shifts_lineage.append({
            "entity_type": "newbie_shift_requests",
            "entity_id": sh_uuid,
            "source_system": "google_sheets",
            "source_tab": r["source_tab"],
            "source_row_key": r["source_row_key"],
            "source_checksum": r["source_checksum"],
            "import_batch_id": batch_id,
            "metadata": {"created_by_batch_id": batch_id}
        })

        if raw.get("rescheduled_at"):
            reschedules_payload.append({
                "reschedule_id": deterministic_uuid("reschedule", req_id),
                "request_id": sh_uuid,
                "previous_scheduled_at": parse_date(raw.get("original_scheduled_at")),
                "scheduled_at": parse_date(raw.get("scheduled_at")),
                "requested_by": raw.get("requested_by"),
                "reason": raw.get("request_reason"),
                "occurred_at": parse_date(raw.get("rescheduled_at") or raw.get("updated_at")),
                "source_provider": "google_sheets"
            })

    if shifts_payload and not dry_run:
        provider.upsert_rows("newbie_shift_requests", shifts_payload, on_conflict="request_id")
        _merge_lineage_result(results, safe_upsert_lineage(provider, shifts_lineage))
        results["inserted"] += len(shifts_payload)
    if reschedules_payload and not dry_run:
        provider.upsert_rows("newbie_shift_reschedules", reschedules_payload, on_conflict="reschedule_id", resolution="ignore-duplicates")

    # 7. candidate corrections
    corrections_payload = []
    corrections_lineage = []
    for r in staged_rows:
        if r["source_tab"] != "candidate-information-correction-requests" or r["normalization_status"] != "valid":
            continue
        raw = r["raw_row"]
        req_id = raw.get("request_id")
        if not req_id:
            continue
        co_uuid = deterministic_uuid("correction", req_id)
        s_uuid = deterministic_uuid("session", raw.get("source_session_id", ""))
        c_uuid = deterministic_uuid("candidate", raw.get("candidate_name", ""))
        co_session_id = None
        if raw.get("source_session_id") and s_uuid in valid_session_ids:
            co_session_id = s_uuid
        co_candidate_id = None
        if raw.get("candidate_name") and c_uuid in valid_candidate_ids:
            co_candidate_id = c_uuid

        changes = {}
        if raw.get("changes_json"):
            try:
                changes = json.loads(raw["changes_json"])
            except Exception:
                pass

        corrections_payload.append({
            "id": co_uuid,
            "request_id": req_id,
            "source_session_id": raw.get("source_session_id"),
            "session_id": co_session_id,
            "candidate_id": co_candidate_id,
            "request_type": raw.get("request_type"),
            "reason": raw.get("reason"),
            "changes": changes,
            "status": raw.get("status") or "pending",
            "requested_by": raw.get("requested_by") or raw.get("tester_name"),
            "decided_by": raw.get("admin_decision_by"),
            "denial_reason": raw.get("denial_reason"),
            "created_at": parse_date(raw.get("created_at")),
            "decision_at": parse_date(raw.get("admin_decision_at")),
            "updated_at": parse_date(raw.get("updated_at")),
            "source_checksum": r["source_checksum"],
            "source_payload": raw
        })
        corrections_lineage.append({
            "entity_type": "candidate_corrections",
            "entity_id": co_uuid,
            "source_system": "google_sheets",
            "source_tab": r["source_tab"],
            "source_row_key": r["source_row_key"],
            "source_checksum": r["source_checksum"],
            "import_batch_id": batch_id,
            "metadata": {"created_by_batch_id": batch_id}
        })

    if corrections_payload and not dry_run:
        provider.upsert_rows("candidate_corrections", corrections_payload, on_conflict="request_id")
        _merge_lineage_result(results, safe_upsert_lineage(provider, corrections_lineage))
        results["inserted"] += len(corrections_payload)

    # 8. generic requests (candidate deletion currently has no dedicated table)
    pending_payload = []
    pending_lineage = []
    for r in staged_rows:
        if r["source_tab"] != "candidate-deletion-requests" or r["normalization_status"] != "valid":
            continue
        raw = r["raw_row"]
        request_id = str(raw.get("request_id") or "").strip()
        if not request_id:
            continue
        pending_uuid = deterministic_uuid("pending-request", request_id)
        source_session_id = str(raw.get("session_id") or raw.get("source_session_id") or "").strip()
        session_uuid = deterministic_uuid("session", source_session_id) if source_session_id else None
        pending_payload.append({
            "id": pending_uuid,
            "request_id": request_id,
            "request_type": raw.get("request_type") or "candidate_deletion",
            "source_session_id": source_session_id or None,
            "session_id": session_uuid if session_uuid in valid_session_ids else None,
            "status": raw.get("request_status") or raw.get("status") or "pending",
            "candidate_name": raw.get("candidate_name") or raw.get("candidate"),
            "tester_name": raw.get("tester_name") or raw.get("tester"),
            "request_reason": raw.get("request_reason") or raw.get("reason"),
            "request_details": raw.get("request_details") if isinstance(raw.get("request_details"), dict) else {},
            "requested_by": raw.get("requested_by") or raw.get("tester_name"),
            "decision_by": raw.get("admin_decision_by") or raw.get("decision_by"),
            "denial_reason": raw.get("denial_reason"),
            "created_at": parse_date(raw.get("request_created_at") or raw.get("created_at")),
            "decision_at": parse_date(raw.get("admin_decision_at") or raw.get("decision_at")),
            "updated_at": parse_date(raw.get("updated_at")),
            "source_checksum": r["source_checksum"],
            "source_payload": raw,
        })
        pending_lineage.append({
            "entity_type": "pending_requests",
            "entity_id": pending_uuid,
            "source_system": "google_sheets",
            "source_tab": r["source_tab"],
            "source_row_key": r["source_row_key"],
            "source_checksum": r["source_checksum"],
            "import_batch_id": batch_id,
            "metadata": {"created_by_batch_id": batch_id},
        })

    if pending_payload and not dry_run:
        provider.upsert_rows("pending_requests", pending_payload, on_conflict="request_id")
        _merge_lineage_result(results, safe_upsert_lineage(provider, pending_lineage))
        results["inserted"] += len(pending_payload)

    # 9. notifications
    notif_payload = []
    notif_lineage = []
    for r in staged_rows:
        if r["source_tab"] != "sam-notifications" or r["normalization_status"] != "valid":
            continue
        raw = r["raw_row"]
        n_id = raw.get("ID")
        if not n_id:
            continue
        n_uuid = deterministic_uuid("notification", n_id)
        notif_payload.append({
            "id": n_uuid,
            "notification_id": n_id,
            "enabled": parse_boolean(raw.get("Enabled", True)),
            "notification_type": raw.get("Type"),
            "title": raw.get("Title") or "Notification",
            "message": raw.get("Message") or "",
            "show_ticker": parse_boolean(raw.get("ShowTicker", False)),
            "show_popup": parse_boolean(raw.get("ShowPopup", False)),
            "show_banner": parse_boolean(raw.get("ShowBanner", False)),
            "persistent": parse_boolean(raw.get("Persistent", False)),
            "starts_at": parse_datetime(raw.get("StartDate"), raw.get("StartTime")),
            "ends_at": parse_datetime(raw.get("EndDate"), raw.get("EndTime")),
            "action_text": raw.get("ActionText"),
            "action_url": raw.get("ActionURL"),
            "created_at": parse_date(raw.get("CreatedAt")),
            "updated_at": parse_date(raw.get("UpdatedAt")),
            "source_checksum": r["source_checksum"],
            "source_payload": raw
        })
        notif_lineage.append({
            "entity_type": "notifications",
            "entity_id": n_uuid,
            "source_system": "google_sheets",
            "source_tab": r["source_tab"],
            "source_row_key": r["source_row_key"],
            "source_checksum": r["source_checksum"],
            "import_batch_id": batch_id,
            "metadata": {"created_by_batch_id": batch_id}
        })

    if notif_payload and not dry_run:
        provider.upsert_rows("notifications", notif_payload, on_conflict="notification_id")
        _merge_lineage_result(results, safe_upsert_lineage(provider, notif_lineage))
        results["inserted"] += len(notif_payload)

    staging_results = []
    for r in staged_rows:
        if r["normalization_status"] in {"valid", "loaded", "canonical", "deterministic_catalog_match"}:
            status = "loaded"
            code = "ok"
        else:
            status = r["normalization_status"]
            code = r["unresolved_reason_code"] or "unknown_unresolved"

        staging_results.append({
            "import_batch_id": batch_id,
            "staging_row_id": r["id"],
            "result_status": status,
            "result_code": code,
        })

    if staging_results and not dry_run:
        provider.upsert_rows("import_row_results", staging_results, on_conflict="staging_row_id")

    return results


def reconcile_batch(provider, batch_id: str, dry_run=False) -> list[dict[str, Any]]:
    logger.info("Reconciling batch: %s (dry_run=%s)", batch_id, dry_run)
    staged_rows = provider._request("import_staging_rows", query={"import_batch_id": f"eq.{batch_id}"})

    tab_counts = {}
    for r in staged_rows:
        tab = r["source_tab"]
        status = r["normalization_status"]
        tab_counts.setdefault(tab, {"source": 0, "staged": 0, "normalized": 0, "unresolved": 0, "duplicate": 0, "rejected": 0, "legacy": 0})
        tab_counts[tab]["source"] += 1
        tab_counts[tab]["staged"] += 1
        if status in {"valid", "loaded", "canonical"}:
            tab_counts[tab]["normalized"] += 1
        elif status == "unresolved":
            tab_counts[tab]["unresolved"] += 1
        elif status == "duplicate":
            tab_counts[tab]["duplicate"] += 1
        elif status == "rejected":
            tab_counts[tab]["rejected"] += 1
        elif status in {"deterministic_catalog_match", "unresolved_legacy_brand"}:
            tab_counts[tab]["legacy"] += 1
            if status == "deterministic_catalog_match":
                tab_counts[tab]["normalized"] += 1
            else:
                tab_counts[tab]["unresolved"] += 1

    reconciliation_rows = []
    for tab, c in tab_counts.items():
        row = {
            "import_batch_id": batch_id,
            "source_tab": tab,
            "source_row_count": c["source"],
            "staged_row_count": c["staged"],
            "normalized_row_count": c["normalized"],
            "unresolved_row_count": c["unresolved"],
            "duplicate_row_count": c["duplicate"],
            "rejected_row_count": c["rejected"],
            "legacy_format_count": c["legacy"]
        }
        reconciliation_rows.append(row)

    if reconciliation_rows and not dry_run:
        provider.upsert_rows("reconciliation_results", reconciliation_rows, on_conflict="import_batch_id,source_tab")

    return reconciliation_rows


def rollback_batch(provider, batch_id: str, dry_run=False) -> dict[str, int]:
    logger.info("Executing rollback for batch: %s (dry_run=%s)", batch_id, dry_run)
    lineage = provider._request("data_source_lineage", query={"import_batch_id": f"eq.{batch_id}"})

    delete_order = [
        "extra_attempt_grants", "candidate_status_actions", "candidate_corrections",
        "newbie_shift_reschedules", "newbie_shift_requests", "supervisor_transfers",
        "headset_review_actions", "headset_reviews", "session_attempts", "candidate_sessions",
        "headset_catalog", "candidates", "user_role_assignments", "app_users"
    ]

    deleted_counts = {}
    if dry_run:
        for table in delete_order:
            tbl_lineage = [l for l in lineage if l["entity_type"] == table]
            if tbl_lineage:
                deleted_counts[table] = len(tbl_lineage)
        return deleted_counts

    for table in delete_order:
        tbl_lineage = [l for l in lineage if l["entity_type"] == table]
        if not tbl_lineage:
            continue

        entity_ids = [l["entity_id"] for l in tbl_lineage]
        for start in range(0, len(entity_ids), 100):
            chunk = entity_ids[start:start+100]
            ids_str = ",".join(chunk)
            provider.delete_rows(table, {"id": f"in.({ids_str})"})

        deleted_counts[table] = len(entity_ids)

    provider.delete_rows("data_source_lineage", {"import_batch_id": f"eq.{batch_id}"})
    provider.delete_rows("import_row_results", {"import_batch_id": f"eq.{batch_id}"})
    provider.delete_rows("reconciliation_results", {"import_batch_id": f"eq.{batch_id}"})
    provider.delete_rows("import_staging_rows", {"import_batch_id": f"eq.{batch_id}"})

    batches = provider._request("import_batches", query={"id": f"eq.{batch_id}"})
    if batches:
        provider.upsert_rows("import_batches", [{
            **batches[0],
            "status": "rolled_back"
        }], on_conflict="batch_key")

    return deleted_counts


def sync_incremental_data(sheets_client, provider, dry_run=False) -> dict[str, Any]:
    logger.info("Executing incremental sync (dry_run=%s)", dry_run)
    if not dry_run:
        raise RuntimeError("incremental_sync_execution_requires_separate_approved_implementation")
    existing_lineage = provider._request("data_source_lineage", query={"select": "source_system,source_tab,source_row_key,source_checksum"})
    lineage_map = {(l["source_system"], l["source_tab"], l["source_row_key"]): l["source_checksum"] for l in existing_lineage}

    from tools.supabase_import.cli import _read_sources
    sources = _read_sources(sheets_client)

    staged_payload = []
    new_count = 0
    changed_count = 0
    unchanged_count = 0

    for title, headers, rows in sources:
        for staged in stage_rows(title, headers, rows):
            key = ("google_sheets", staged.source_tab, staged.source_row_key)
            if key not in lineage_map:
                new_count += 1
                staged_payload.append(staged)
            elif lineage_map[key] != staged.source_checksum:
                changed_count += 1
                staged_payload.append(staged)
            else:
                unchanged_count += 1

    logger.info("Incremental Sync planning: new=%s, changed=%s, unchanged=%s", new_count, changed_count, unchanged_count)
    return {
        "new": new_count,
        "changed": changed_count,
        "unchanged": unchanged_count,
        "dry_run": dry_run
    }


def _fetch_with_retry(fetch_fn, resource_name, max_retries=4, base_delay=1.0):
    """Fetch with exponential backoff for 429/quota errors."""
    import time, random
    for attempt in range(max_retries + 1):
        try:
            return fetch_fn(), None
        except Exception as exc:
            err_str = str(exc)
            is_quota = '429' in err_str or 'quota' in err_str.lower() or 'rate' in err_str.lower()
            if attempt >= max_retries or not is_quota:
                return None, {'code': 'quota_exhausted' if is_quota else 'fetch_error',
                              'message': f'{resource_name}: {type(exc).__name__}'}
            wait = base_delay * (2 ** attempt) + random.uniform(0, 0.5)
            try:
                if hasattr(exc, 'headers'):
                    retry_after = int(exc.headers.get('Retry-After', 0))
                    if retry_after > 0:
                        wait = min(retry_after, 60.0)
            except Exception:
                pass
            time.sleep(wait)
    return None, {'code': 'fetch_error', 'message': f'{resource_name}: exhausted retries'}

def _empty_domain_result():
    return {
        'sheets_count': 0, 'supabase_count': 0,
        'exact_match_count': 0,
        'missing_in_supabase_count': 0, 'missing_in_sheets_count': 0,
        'identity_mismatch_count': 0, 'value_mismatch_count': 0,
        'status_mismatch_count': 0, 'relationship_mismatch_count': 0,
        'attempt_mismatch_count': 0,
        'duplicate_identity_count': 0, 'unresolved_identity_count': 0,
        'expected_difference_count': 0, 'unexplained_difference_count': 0,
        'error_count': 0, 'errors': [],
        'readiness': 'unknown',
    }

REQUIRED_SHADOW_DOMAINS = (
    "candidates", "candidate_sessions", "session_attempts",
    "authoritative_candidate_status", "candidate_tracking", "history",
    "headset_catalog", "headset_reviews", "supervisor_transfers",
    "newbie_shift_requests", "candidate_corrections", "pending_requests",
    "recent_activity", "notifications",
)

SHADOW_SNAPSHOT_MAX_AGE_SECONDS = 15 * 60
EXPECTED_SUPABASE_PROJECT_REF = "xyfhikikddcqcmzbdvbj"


@dataclass(frozen=True)
class ShadowDomainSpec:
    identity: tuple[tuple[str, ...], ...]
    values: tuple[tuple[str, ...], ...] = ()
    statuses: tuple[tuple[str, ...], ...] = ()
    relationships: tuple[tuple[str, ...], ...] = ()
    attempts: tuple[tuple[str, ...], ...] = ()


SHADOW_DOMAIN_SPECS = {
    "candidates": ShadowDomainSpec(
        identity=(("comparison_candidate_id", "id"),),
        values=(("display_name", "candidate_name"), ("first_name", "candidate_first_name"), ("last_initial", "candidate_last_initial")),
        statuses=(("authoritative_status",), ("archived",)),
        relationships=(("latest_session_id",),),
    ),
    "candidate_sessions": ShadowDomainSpec(
        identity=(("session_id",),),
        values=(("candidate_name",), ("tester_name",), ("session_type",), ("completed_at",), ("headset_brand",), ("headset_model",), ("newbie_shift_number",)),
        statuses=(("raw_status", "status"), ("calculated_result",), ("final_result",), ("archived",), ("withdrawn",)),
        relationships=(("candidate_id",), ("pending_sup_transfer_id",)),
        attempts=(("attempt_number",), ("current_attempt_number",), ("allowed_attempt_count",), ("final_attempt",)),
    ),
    "session_attempts": ShadowDomainSpec(
        identity=(("source_action_id", "attempt_key"),),
        values=(("result",), ("attempt_type",)),
        relationships=(("session_id", "source_session_uuid"),),
        attempts=(("attempt_number",),),
    ),
    "authoritative_candidate_status": ShadowDomainSpec(
        identity=(("session_id",),),
        statuses=(("authoritative_status",), ("archived",)),
        relationships=(("determining_session_id", "session_id"),),
        attempts=(("final_attempt",),),
    ),
    "candidate_tracking": ShadowDomainSpec(
        identity=(("session_id",),),
        values=(("candidate_name",), ("category",), ("newbie_shift_number",)),
        statuses=(("authoritative_status",), ("archived",)),
        relationships=(("candidate_id",),),
        attempts=(("current_attempt_number",), ("allowed_attempt_count",), ("final_attempt",)),
    ),
    "history": ShadowDomainSpec(
        identity=(("session_id",),),
        values=(("candidate_name",), ("tester_name",), ("completed_at",), ("newbie_shift_number",)),
        statuses=(("authoritative_status", "final_result"), ("archived",)),
        relationships=(("candidate_id",),),
        attempts=(("attempt_number",), ("current_attempt_number",), ("allowed_attempt_count",)),
    ),
    "headset_catalog": ShadowDomainSpec(
        identity=(("brand", "Brand"), ("model", "Model")),
        values=(("brand", "Brand"), ("model", "Model"), ("note", "Note"), ("selectable",)),
        statuses=(("status", "Status"), ("archived",), ("deleted",)),
    ),
    "headset_reviews": ShadowDomainSpec(
        identity=(("review_id",),),
        values=(("brand", "Brand"), ("model", "Model"), ("note", "Note"), ("normalization_status",)),
        statuses=(("status", "Status"),),
        relationships=(("source_session_id",), ("session_id", "canonical_session_id")),
    ),
    "supervisor_transfers": ShadowDomainSpec(
        identity=(("transfer_id", "pending_id"),),
        values=(("candidate_name",), ("original_tester_name",), ("completed_by",), ("completed_at",)),
        statuses=(("status",), ("completed_status",), ("final_attempt",)),
        relationships=(("source_session_id", "original_session_id"), ("session_id", "source_session_uuid")),
    ),
    "newbie_shift_requests": ShadowDomainSpec(
        identity=(("request_id",),),
        values=(("request_type",), ("newbie_shift_number",), ("scheduled_at", "requested_scheduled_at"), ("original_scheduled_at",), ("rescheduled_at",), ("timezone",), ("decision_by",), ("decision_at",)),
        statuses=(("request_status", "status"),),
        relationships=(("source_session_id",), ("canonical_session_id", "session_id")),
        attempts=(("current_attempt",), ("resulting_attempt",), ("final_attempt",), ("counts_as_attempt",)),
    ),
    "candidate_corrections": ShadowDomainSpec(
        identity=(("request_id",),),
        values=(("request_type",), ("changes", "changes_json"), ("decision_by", "decided_by"), ("decision_at",)),
        statuses=(("status",),),
        relationships=(("source_session_id",), ("canonical_session_id", "session_id"), ("candidate_id",)),
    ),
    "pending_requests": ShadowDomainSpec(
        identity=(("category", "source_tab"), ("request_id", "id")),
        values=(("request_type",), ("category", "source_tab"), ("created_at",)),
        statuses=(("status", "request_status"),),
        relationships=(("source_session_id", "session_id"),),
    ),
    "recent_activity": ShadowDomainSpec(
        identity=(("category", "source_tab"), ("event_id", "event_key", "request_id")),
        values=(("event_type", "request_type"), ("occurred_at", "updated_at", "created_at")),
        statuses=(("status", "request_status"),),
        relationships=(("source_entity_id", "source_session_id"),),
    ),
    "notifications": ShadowDomainSpec(
        identity=(("notification_id", "ID"),),
        values=(("notification_type", "Type"), ("title", "Title"), ("message", "Message"), ("starts_at", "StartDate"), ("ends_at", "EndDate"), ("action_text", "ActionText"), ("action_url", "ActionURL")),
        statuses=(("enabled", "Enabled"), ("show_ticker", "ShowTicker"), ("show_popup", "ShowPopup"), ("show_banner", "ShowBanner"), ("persistent", "Persistent")),
    ),
}


def _first_value(row, aliases):
    for alias in aliases:
        if alias in row:
            return row.get(alias)
    return None


def _normalized_compare_value(field, value):
    boolean_fields = {
        "enabled", "show_ticker", "show_popup", "show_banner", "persistent",
        "archived", "deleted", "withdrawn", "final_attempt", "counts_as_attempt",
    }
    if value is None or str(value).strip() == "":
        # Lazy Sheet boolean columns and absent canonical boolean projections both
        # represent the default false state. This equivalence is representational;
        # explicit true values remain distinct.
        return False if field in boolean_fields else ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    if field == "changes" and isinstance(value, str):
        try:
            parsed = json.loads(value)
            return json.dumps(parsed, sort_keys=True, separators=(",", ":"), default=str)
        except (TypeError, ValueError, json.JSONDecodeError):
            return re.sub(r"\s+", " ", value.strip())
    if field in boolean_fields:
        try:
            return bool(parse_boolean(value))
        except ValueError:
            return normalized_text(value)
    if field.endswith("_at") or field in {"completed_at", "created_at", "occurred_at", "scheduled_at", "rescheduled_at", "original_scheduled_at"}:
        text = str(value).strip()
        try:
            parsed = datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                parsed = parsed.astimezone(datetime.timezone.utc)
            return parsed.isoformat()
        except ValueError:
            return parse_date(value) or normalized_text(value)
    if field in {"status", "raw_status", "calculated_result", "final_result", "authoritative_status", "request_status", "completed_status", "normalization_status", "notification_type", "request_type", "event_type", "category", "attempt_type"}:
        normalized = normalized_text(value).replace("_", " ").replace("-", " ")
        normalized = re.sub(r"\s+", " ", normalized).strip()
        status_equivalents = {
            "passed": "pass",
            "resumed pass": "pass",
            "completed": "pass",
            "failed": "fail",
            "failed final attempt": "fail final attempt",
            "pending sup": "pending supervisor transfer",
            "pending supervisor": "pending supervisor transfer",
            "withdrawn": "withdrew from certification",
        }
        return status_equivalents.get(normalized, normalized)
    if field in {"brand", "model", "headset_brand", "headset_model", "selectable"}:
        return normalized_text(value)
    return re.sub(r"\s+", " ", str(value).strip())


def _identity_key(spec, row):
    parts = []
    for aliases in spec.identity:
        field = aliases[0]
        value = _first_value(row, aliases)
        normalized = _normalized_compare_value(field, value)
        if normalized == "":
            return ""
        parts.append(str(normalized).casefold())
    return "|".join(parts)


def _group_mismatch(spec_fields, sheets_row, supabase_row):
    return bool(_mismatched_fields(spec_fields, sheets_row, supabase_row))


def _mismatched_fields(spec_fields, sheets_row, supabase_row):
    mismatches = []
    for aliases in spec_fields:
        field = aliases[0]
        left = _normalized_compare_value(field, _first_value(sheets_row, aliases))
        right = _normalized_compare_value(field, _first_value(supabase_row, aliases))
        if left != right:
            mismatches.append(field)
    return mismatches


def _comparison_index(spec, rows):
    index = {}
    duplicates = 0
    unresolved = 0
    for row in rows:
        key = _identity_key(spec, row)
        if not key:
            unresolved += 1
            continue
        if key in index:
            duplicates += 1
        else:
            index[key] = row
    return index, duplicates, unresolved


def _candidate_comparison_context(sheets_provider, supabase_provider):
    """Resolve comparison candidate IDs through the reconciliation contract."""
    source_sessions = list(sheets_provider.list_resource("candidate_sessions", limit=5000) or [])
    target_candidates = list(supabase_provider.list_resource("candidates", limit=5000) or [])
    target_sessions = list(supabase_provider.list_resource("candidate_sessions", limit=5000) or [])
    source_attempts = list(sheets_provider.list_resource("session_attempts", limit=5000) or [])
    lineage_rows = []
    request = getattr(supabase_provider, "_request", None)
    if callable(request):
        try:
            candidate_lineage = request("data_source_lineage", query={
                "select": "entity_type,entity_id,source_system,source_tab,source_row_key,source_checksum,import_batch_id",
                "limit": 5000,
            })
            if isinstance(candidate_lineage, list):
                lineage_rows = candidate_lineage
        except Exception:
            lineage_rows = []
    by_source = {}
    by_entity = {}
    for row in lineage_rows:
        by_source[(
            str(row.get("source_system") or ""), str(row.get("source_tab") or ""),
            str(row.get("source_row_key") or ""),
        )] = row
        by_entity[(
            str(row.get("entity_type") or ""), str(row.get("entity_id") or ""),
            str(row.get("source_system") or ""), str(row.get("source_tab") or ""),
        )] = row

    # Local import avoids a module cycle while reusing the exact planner
    # identity contract instead of inventing comparison-only identity rules.
    from .reconciliation import _candidate_items
    _items, resolutions = _candidate_items(
        source_sessions, target_candidates, target_sessions,
        by_source, by_entity, source_attempts,
    )
    aligned_sessions = []
    for row in source_sessions:
        next_row = dict(row)
        resolution = resolutions.get(str(row.get("session_id") or "").strip()) or {}
        candidate_id = str(resolution.get("candidate_id") or "")
        next_row["candidate_id"] = candidate_id
        next_row["comparison_identity_status"] = (
            "stable" if candidate_id and not resolution.get("blocking_reason")
            else "legacy_identity_unresolved"
        )
        aligned_sessions.append(next_row)
    return {
        "source_sessions": aligned_sessions,
        "target_candidates": target_candidates,
        "target_sessions": target_sessions,
        "source_attempts": source_attempts,
        "resolutions": resolutions,
    }


def _align_candidate_comparison_rows(domain, rows, *, side, context):
    rows = [dict(row) for row in rows]
    resolutions = context["resolutions"]
    if side == "supabase":
        if domain == "candidates":
            for row in rows:
                row["comparison_candidate_id"] = str(row.get("id") or "")
        return rows

    if domain == "candidate_sessions":
        return [dict(row) for row in context["source_sessions"]]
    if domain == "candidates":
        latest = {}
        unresolved = []
        for session in context["source_sessions"]:
            candidate_id = str(session.get("candidate_id") or "")
            candidate = {
                **session,
                "comparison_candidate_id": candidate_id,
                "display_name": session.get("candidate_name"),
                "latest_session_id": session.get("session_id"),
                "authoritative_status": session.get("authoritative_status") or _first_value(
                    session, ("authoritative_status", "status", "raw_status")
                ),
            }
            if not candidate_id:
                candidate["comparison_identity_status"] = "legacy_identity_unresolved"
                unresolved.append(candidate)
                continue
            stamp = str(session.get("completed_at") or session.get("updated_at") or session.get("created_at") or "")
            current = latest.get(candidate_id)
            if current is None or stamp >= current[0]:
                latest[candidate_id] = (stamp, candidate)
        return [item[1] for item in latest.values()] + unresolved
    if domain in {"candidate_tracking", "history"}:
        for row in rows:
            resolution = resolutions.get(str(row.get("session_id") or "").strip()) or {}
            row["candidate_id"] = str(resolution.get("candidate_id") or "")
            if not row["candidate_id"]:
                row["comparison_identity_status"] = "legacy_identity_unresolved"
    elif domain == "candidate_corrections":
        for row in rows:
            resolution = resolutions.get(str(row.get("source_session_id") or "").strip()) or {}
            row["candidate_id"] = str(resolution.get("candidate_id") or "")
            if row.get("source_session_id") and not row["candidate_id"]:
                row["comparison_identity_status"] = "legacy_identity_unresolved"
    return rows


def compare_shadow_provider(sheets_provider, supabase_provider, diagnostic_mode=False) -> dict[str, Any]:
    logger.info("Comparing all required Sheets and Supabase domains (diagnostic_mode=%s)", diagnostic_mode)
    result = {
        "mismatch_count": 0,
        "total_unexplained": 0,
        "error_count": 0,
        "sheets_snapshot_timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "sheets_snapshot_checksum": None,
        "sheets_fetch_count": None,
        "sheets_retry_count": None,
        "required_domains": list(REQUIRED_SHADOW_DOMAINS),
        "categories": {},
        "not_implemented": [],
        "invariant_errors": [],
        "lineage_rpc_path_verified": False,
        "project_ref": None,
        "overall_readiness": "unknown",
        "completed": False,
    }

    provider_url = str(getattr(supabase_provider, "_url", "") or "")
    project_match = re.search(r"https://([a-z0-9]+)\.supabase\.co", provider_url)
    result["project_ref"] = project_match.group(1) if project_match else None
    if result["project_ref"] != EXPECTED_SUPABASE_PROJECT_REF:
        result["invariant_errors"].append("project_ref_mismatch")
    result["lineage_rpc_path_verified"] = bool(
        getattr(supabase_provider, "lineage_write_mode", None) == "rpc_only"
        and callable(getattr(supabase_provider, "insert_lineage_if_absent", None))
    )
    if not result["lineage_rpc_path_verified"]:
        result["invariant_errors"].append("lineage_rpc_path_inactive")

    identity_context = None
    identity_context_error = None
    stable_identity_required = (
        getattr(sheets_provider, "stable_identity_resolution_required", False) is True
    )
    if stable_identity_required:
        try:
            identity_context = _candidate_comparison_context(sheets_provider, supabase_provider)
        except Exception:
            identity_context_error = "stable_identity_context_unavailable"

    for domain in REQUIRED_SHADOW_DOMAINS:
        spec = SHADOW_DOMAIN_SPECS[domain]
        domain_result = _empty_domain_result()
        domain_result["error_codes"] = []
        if diagnostic_mode:
            domain_result["field_mismatch_counts"] = {}
        try:
            sheets_rows, sheets_error = _fetch_with_retry(
                lambda: (
                    identity_context["source_sessions"]
                    if identity_context is not None and domain == "candidate_sessions"
                    else identity_context["source_attempts"]
                    if identity_context is not None and domain == "session_attempts"
                    else sheets_provider.list_resource(domain, limit=5000)
                ), domain, max_retries=0
            )
            if sheets_error:
                raise RuntimeError(sheets_error["code"])
            supabase_rows, supabase_error = _fetch_with_retry(
                lambda: (
                    identity_context["target_candidates"]
                    if identity_context is not None and domain == "candidates"
                    else identity_context["target_sessions"]
                    if identity_context is not None and domain == "candidate_sessions"
                    else supabase_provider.list_resource(domain, limit=5000)
                ), domain, max_retries=0
            )
            if supabase_error:
                raise RuntimeError("supabase_query_error")
            sheets_rows = list(sheets_rows or [])
            supabase_rows = list(supabase_rows or [])
            if identity_context is not None:
                sheets_rows = _align_candidate_comparison_rows(
                    domain, sheets_rows, side="sheets", context=identity_context,
                )
                supabase_rows = _align_candidate_comparison_rows(
                    domain, supabase_rows, side="supabase", context=identity_context,
                )
            elif stable_identity_required and domain in {"candidates", "candidate_sessions", "candidate_tracking", "history", "candidate_corrections"}:
                raise RuntimeError(identity_context_error or "stable_identity_context_unavailable")
            domain_result["sheets_count"] = len(sheets_rows)
            domain_result["supabase_count"] = len(supabase_rows)
            sheets_index, sheets_duplicates, sheets_unresolved = _comparison_index(spec, sheets_rows)
            supabase_index, supabase_duplicates, supabase_unresolved = _comparison_index(spec, supabase_rows)
            domain_result["duplicate_identity_count"] = sheets_duplicates + supabase_duplicates
            domain_result["unresolved_identity_count"] = sheets_unresolved + supabase_unresolved
            if domain_result["unresolved_identity_count"]:
                domain_result["error_codes"].append("legacy_identity_unresolved")
            missing_supabase = set(sheets_index) - set(supabase_index)
            missing_sheets = set(supabase_index) - set(sheets_index)
            domain_result["missing_in_supabase_count"] = len(missing_supabase)
            domain_result["missing_in_sheets_count"] = len(missing_sheets)
            historical_expected_mismatch_offset = 0

            for key in set(sheets_index) & set(supabase_index):
                sheets_row = sheets_index[key]
                supabase_row = supabase_index[key]
                identity_mismatch = _group_mismatch(spec.identity, sheets_row, supabase_row)
                value_mismatch = _group_mismatch(spec.values, sheets_row, supabase_row)
                status_mismatch = _group_mismatch(spec.statuses, sheets_row, supabase_row)
                relationship_mismatch = _group_mismatch(spec.relationships, sheets_row, supabase_row)
                attempt_mismatch = _group_mismatch(spec.attempts, sheets_row, supabase_row)
                domain_result["identity_mismatch_count"] += int(identity_mismatch)
                domain_result["value_mismatch_count"] += int(value_mismatch)
                domain_result["status_mismatch_count"] += int(status_mismatch)
                domain_result["relationship_mismatch_count"] += int(relationship_mismatch)
                domain_result["attempt_mismatch_count"] += int(attempt_mismatch)
                if (
                    domain == "headset_reviews"
                    and not supabase_row.get("session_id")
                ):
                    historical_expected_mismatch_offset += sum(map(int, (
                        identity_mismatch, value_mismatch, status_mismatch,
                        relationship_mismatch, attempt_mismatch,
                    )))
                if diagnostic_mode:
                    mismatch_fields = {}
                    for fields in (spec.identity, spec.values, spec.statuses, spec.relationships, spec.attempts):
                        for field in _mismatched_fields(fields, sheets_row, supabase_row):
                            domain_result["field_mismatch_counts"][field] = domain_result["field_mismatch_counts"].get(field, 0) + 1
                    for label, fields in (
                        ("identity", spec.identity), ("value", spec.values),
                        ("status", spec.statuses), ("relationship", spec.relationships),
                        ("attempt", spec.attempts),
                    ):
                        names = _mismatched_fields(fields, sheets_row, supabase_row)
                        if names:
                            mismatch_fields[label] = names
                    if mismatch_fields:
                        domain_result.setdefault("safe_mismatch_details", []).append({
                            "safe_identity_hash": hashlib.sha256(
                                f"{domain}:{key}".encode("utf-8")
                            ).hexdigest(),
                            "fields": mismatch_fields,
                        })
                if not any((identity_mismatch, value_mismatch, status_mismatch, relationship_mismatch, attempt_mismatch)):
                    domain_result["exact_match_count"] += 1

            expected = 0
            expected_offset = 0
            if domain == "newbie_shift_requests":
                expected += sheets_duplicates
                expected_offset += sheets_duplicates
            if domain == "headset_reviews":
                standalone = sum(
                    1 for row in supabase_rows
                    if not row.get("source_session_id") and not row.get("session_id")
                )
                unresolved_link = sum(
                    1 for row in supabase_rows
                    if row.get("source_session_id") and not row.get("session_id")
                )
                expected += standalone + unresolved_link
                expected_offset += unresolved_link + historical_expected_mismatch_offset
                if unresolved_link:
                    # Keep the known unresolved source-session link visible as a
                    # relationship mismatch while classifying it as an expected
                    # historical exception for readiness accounting.
                    domain_result["relationship_mismatch_count"] += unresolved_link
                    domain_result["exact_match_count"] = max(
                        0, domain_result["exact_match_count"] - unresolved_link
                    )
                    domain_result["error_codes"].append("expected_unresolved_headset_session_relationship")
            domain_result["expected_difference_count"] = expected
            mismatch_total = sum(domain_result[key] for key in (
                "missing_in_supabase_count", "missing_in_sheets_count",
                "identity_mismatch_count", "value_mismatch_count",
                "status_mismatch_count", "relationship_mismatch_count",
                "attempt_mismatch_count", "duplicate_identity_count",
                "unresolved_identity_count",
            ))
            domain_result["unexplained_difference_count"] = max(0, mismatch_total - min(expected_offset, mismatch_total))
            domain_result["readiness"] = "ready" if domain_result["unexplained_difference_count"] == 0 else "not_ready"
            result["mismatch_count"] += mismatch_total
            result["total_unexplained"] += domain_result["unexplained_difference_count"]
        except Exception as exc:
            safe_code = str(exc)
            if safe_code not in {
                "quota_exhausted", "sheets_quota_exhausted", "sheets_network_error",
                "supabase_query_error", "schema_mismatch", "normalization_error",
            }:
                safe_code = "unexpected_exception"
            domain_result["error_count"] = 1
            domain_result["errors"] = [safe_code]
            domain_result["error_codes"] = [safe_code]
            domain_result["readiness"] = "error"
            result["error_count"] += 1
        result["categories"][domain] = domain_result

    metadata = getattr(sheets_provider, "snapshot_metadata", {}) or {}
    result["sheets_snapshot_timestamp"] = metadata.get("timestamp", result["sheets_snapshot_timestamp"])
    result["sheets_snapshot_checksum"] = metadata.get("checksum")
    result["sheets_fetch_count"] = metadata.get("fetch_count")
    result["sheets_retry_count"] = metadata.get("retry_count")
    snapshot_timestamp = result["sheets_snapshot_timestamp"]
    snapshot_fresh = False
    try:
        parsed_timestamp = datetime.datetime.fromisoformat(str(snapshot_timestamp).replace("Z", "+00:00"))
        if parsed_timestamp.tzinfo is None:
            parsed_timestamp = parsed_timestamp.replace(tzinfo=datetime.timezone.utc)
        snapshot_age = (datetime.datetime.now(datetime.timezone.utc) - parsed_timestamp).total_seconds()
        snapshot_fresh = 0 <= snapshot_age <= SHADOW_SNAPSHOT_MAX_AGE_SECONDS
    except (TypeError, ValueError):
        snapshot_fresh = False
    snapshot_complete = bool(
        snapshot_fresh
        and re.fullmatch(r"[0-9a-f]{64}", str(result["sheets_snapshot_checksum"] or ""))
        and result["sheets_fetch_count"] == 1
        and not metadata.get("errors")
    )
    if not snapshot_complete:
        result["invariant_errors"].append("snapshot_contract_incomplete")
    result["completed"] = (
        set(result["categories"]) == set(REQUIRED_SHADOW_DOMAINS)
        and not result["not_implemented"]
        and not result["invariant_errors"]
        and all(item["readiness"] != "unknown" for item in result["categories"].values())
    )
    if result["error_count"]:
        quota_blocked = any(
            "quota" in code
            for item in result["categories"].values()
            for code in item.get("error_codes", [])
        )
        result["overall_readiness"] = "blocked_by_quota" if quota_blocked else "error"
    elif result["invariant_errors"] or not result["completed"]:
        result["overall_readiness"] = "incomplete"
    elif result["total_unexplained"]:
        result["overall_readiness"] = "not_ready"
    else:
        result["overall_readiness"] = "ready"
    return result


def verify_production_health(provider, comparison_result=None) -> dict[str, Any]:
    import re, os, glob
    logger.info("Verifying production environment health")
    
    result = {
        "ok": True,
        "full_cutover_ready": False,
        "shadow_read_mapped_domains_ready": False,
        "checks": [],
        "errors": [],
        "warnings": [],
        "info": [],
        "counts": {},
        "comparison": None,
    }
    
    def add_check(name, severity, passed, detail):
        result["checks"].append({"name": name, "severity": severity, "passed": passed, "detail": detail})
        if not passed:
            if severity == "ERROR": result["errors"].append(name)
            elif severity == "WARNING": result["warnings"].append(name)
            elif severity == "INFO": result["info"].append(detail)
            
    try:
        # Check Project Ref
        m = re.search(r'https://([a-z0-9]+)\.supabase\.co', getattr(provider, '_url', ''))
        actual_ref = m.group(1) if m else 'unknown'
        EXPECTED_REF = EXPECTED_SUPABASE_PROJECT_REF
        add_check('project_ref', 'ERROR', actual_ref == EXPECTED_REF, f"Expected {EXPECTED_REF}, got {actual_ref}")
        
        # Schema tables
        REQUIRED_TABLES = [
            'candidates', 'candidate_sessions', 'session_attempts',
            'headset_catalog', 'headset_reviews', 'supervisor_transfers',
            'newbie_shift_requests', 'candidate_corrections',
            'candidate_status_actions', 'extra_attempt_grants',
            'notifications', 'app_users', 'user_role_assignments',
            'import_batches', 'import_staging_rows', 'import_row_results',
            'reconciliation_results', 'data_source_lineage',
        ]
        for t in REQUIRED_TABLES:
            try:
                provider._request(t, query={'select': 'id', 'limit': '1'})
                add_check(f'table_{t}', 'ERROR', True, 'Exists')
            except Exception as e:
                add_check(f'table_{t}', 'ERROR', False, str(e))
                
        REQUIRED_VIEWS = [
            'current_headset_catalog_view', 'headset_review_queue_view',
            'current_candidate_status_view', 'candidate_history_view',
            'pending_requests_view', 'recent_activity_view',
        ]
        for v in REQUIRED_VIEWS:
            try:
                provider._request(v, query={'select': '*', 'limit': '1'})
                add_check(f'view_{v}', 'WARNING', True, 'Exists')
            except Exception as e:
                err_str = str(e).lower()
                passed = 'does not exist' not in err_str
                add_check(f'view_{v}', 'ERROR' if not passed else 'WARNING', passed, str(e))
                
        # Batches
        try:
            batches = provider._request('import_batches', query={'select': 'id,status', 'limit': '100'})
            b_dict = {b['id']: b['status'] for b in batches}
            add_check('batch_1', 'ERROR', b_dict.get('9e830168-40c8-4e9a-9a38-2f907e45a29c') == 'succeeded', 'Production batch')
            add_check('batch_2', 'ERROR', b_dict.get('da04bccb-982d-4a17-820a-4eaa06d23b8f') == 'succeeded', 'Idempotency batch')
            add_check('batch_3', 'WARNING', b_dict.get('99999999-9999-9999-9999-999999999999') == 'rolled_back', 'Synthetic rollback')
            failed_batches = [b for b in batches if b['status'] == 'failed']
            add_check('no_failed_batches', 'ERROR', len(failed_batches) == 0, 'No failed batches')
        except Exception as e:
            add_check('batches', 'ERROR', False, str(e))
            
        # Recon totals
        try:
            recon = provider._request('reconciliation_results', query={'import_batch_id': 'eq.9e830168-40c8-4e9a-9a38-2f907e45a29c'})
            src_cnt = sum(r.get('source_row_count', 0) for r in recon)
            norm_cnt = sum(r.get('normalized_row_count', 0) for r in recon)
            unres_cnt = sum(r.get('unresolved_row_count', 0) for r in recon)
            dup_cnt = sum(r.get('duplicate_row_count', 0) for r in recon)
            rej_cnt = sum(r.get('rejected_row_count', 0) for r in recon)
            sum_parts = norm_cnt + unres_cnt + dup_cnt + rej_cnt
            add_check('recon_totals', 'ERROR', sum_parts == src_cnt, f'Parts {sum_parts} == Source {src_cnt}')
            add_check('recon_expected', 'WARNING', src_cnt == 358 and norm_cnt == 220, 'Expected totals')
        except Exception as e:
            add_check('recon_totals', 'ERROR', False, str(e))
            
        # Simplified Counts
        try:
            for entity in ['candidates', 'candidate_sessions', 'session_attempts', 'data_source_lineage']:
                res = provider._request(entity, query={'select': 'id'})
                result['counts'][entity] = len(res)
            add_check('counts_retrieved', 'ERROR', True, 'OK')
        except Exception as e:
            add_check('counts_retrieved', 'ERROR', False, str(e))
            
        # Headset review warnings
        try:
            hr = provider._request('headset_reviews', query={'select': 'id,session_id,source_session_id'})
            unresolved_links = sum(1 for r in hr if r.get('source_session_id') and not r.get('session_id'))
            add_check('headset_review_links', 'WARNING', unresolved_links == 0, f"{unresolved_links} unresolved")
        except Exception as e:
            pass
            
        # Env vars
        provider_val = os.environ.get('MTS_DATA_PROVIDER', 'sheets')
        dual_write = os.environ.get('MTS_DUAL_WRITE_ENABLED', 'false')
        shadow_mode = os.environ.get('MTS_SHADOW_COMPARE', 'false')
        
        add_check('env_provider', 'ERROR', provider_val == 'sheets', 'Must be sheets')
        add_check('env_dual_write', 'ERROR', dual_write not in ('true', '1'), 'Must not be true')
        add_check('env_shadow_mode', 'ERROR', shadow_mode not in ('true', '1'), 'Must remain disabled')

        lineage_rpc_active = bool(
            getattr(provider, 'lineage_write_mode', None) == 'rpc_only'
            and callable(getattr(provider, 'insert_lineage_if_absent', None))
        )
        add_check('lineage_rpc_provider_method', 'ERROR', lineage_rpc_active, 'Trusted lineage RPC method must be active')

        comparison_domains = set((comparison_result or {}).get('categories') or {})
        comparison_ready = bool(
            comparison_result
            and comparison_result.get('completed')
            and comparison_result.get('overall_readiness') == 'ready'
            and comparison_domains == set(REQUIRED_SHADOW_DOMAINS)
            and not comparison_result.get('not_implemented')
            and not comparison_result.get('error_count')
            and not comparison_result.get('total_unexplained')
            and all(
                item.get('error_count') == 0
                and item.get('unexplained_difference_count') == 0
                and item.get('readiness') == 'ready'
                for item in (comparison_result.get('categories') or {}).values()
            )
        )
        add_check(
            'shadow_comparison_current', 'ERROR', comparison_ready,
            'Current same-process comparison covers all 14 required domains and is ready'
            if comparison_ready else 'A current successful all-domain comparison is required',
        )
        if comparison_result:
            result['comparison'] = {
                'snapshot_timestamp': comparison_result.get('sheets_snapshot_timestamp'),
                'snapshot_checksum': comparison_result.get('sheets_snapshot_checksum'),
                'required_domain_count': len(comparison_domains),
                'overall_readiness': comparison_result.get('overall_readiness'),
                'error_count': comparison_result.get('error_count'),
                'total_unexplained': comparison_result.get('total_unexplained'),
            }
        
        # Secret safety
        frontend_src = glob.glob('frontend/src/**/*.js', recursive=True) + glob.glob('frontend/src/**/*.jsx', recursive=True)
        key = getattr(provider, '_key', '')
        if key and len(key) > 20:
            key_prefix = key[:8]
            found_key = False
            for path in frontend_src[:50]:
                try:
                    with open(path, encoding="utf-8", errors="replace") as f:
                        content = f.read()
                    if key_prefix in content:
                        found_key = True
                        break
                except Exception:
                    pass
            add_check('service_key_in_frontend', 'ERROR', not found_key, 'Check frontend source for service key')
            
        add_check('unmapped_tabs', 'WARNING', False, '9 required configuration tabs remain unmapped (66 rows)')
        add_check('sam_authorized_users_rejected', 'WARNING', False, '6 sam-authorized-users rows rejected')
        
    except Exception as e:
        add_check('unexpected_exception', 'ERROR', False, str(e))
        
    has_errors = len(result['errors']) > 0
    result['ok'] = not has_errors
    result['shadow_read_mapped_domains_ready'] = not has_errors and bool(comparison_result)
    result['full_cutover_ready'] = False
    
    return result

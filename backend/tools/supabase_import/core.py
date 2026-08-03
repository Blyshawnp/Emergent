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

    for field in IDENTITY_FIELDS:
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


def safe_upsert_lineage(provider, lineage_rows):
    if not lineage_rows:
        return
    try:
        existing = provider._request("data_source_lineage", query={"select": "source_system,source_tab,source_row_key,entity_type,entity_id"})
        seen_keys = {(l["source_system"], l["source_tab"], l["source_row_key"]) for l in existing}
        seen_entities = {(l["entity_type"], l["entity_id"], l["source_system"], l["source_tab"]) for l in existing}
    except Exception:
        seen_keys = set()
        seen_entities = set()
    filtered = []
    for l in lineage_rows:
        k = (l["source_system"], l["source_tab"], l["source_row_key"])
        ent = (l["entity_type"], l["entity_id"], l["source_system"], l["source_tab"])
        if k not in seen_keys and ent not in seen_entities:
            filtered.append(l)
    if filtered:
        unique_payload = {}
        for l in filtered:
            key = (l["source_system"], l["source_tab"], l["source_row_key"])
            unique_payload[key] = l
        provider.upsert_rows("data_source_lineage", list(unique_payload.values()), on_conflict="source_system,source_tab,source_row_key")


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
        safe_upsert_lineage(provider, user_lineage)
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
        safe_upsert_lineage(provider, list({l["entity_id"]: l for l in cand_lineage}.values()))
        results["inserted"] += len(unique_cand)
    if headset_payload and not dry_run:
        provider.upsert_rows("headset_catalog", headset_payload, on_conflict="brand,model")
        safe_upsert_lineage(provider, headset_lineage)
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
        safe_upsert_lineage(provider, sessions_lineage)
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
        safe_upsert_lineage(provider, reviews_lineage)
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
        safe_upsert_lineage(provider, transfers_lineage)
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
        safe_upsert_lineage(provider, shifts_lineage)
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
        safe_upsert_lineage(provider, corrections_lineage)
        results["inserted"] += len(corrections_payload)

    # 8. notifications
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
        safe_upsert_lineage(provider, notif_lineage)
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
            key = (staged.source_system, staged.source_tab, staged.source_row_key)
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


def compare_shadow_provider(sheets_provider, supabase_provider, diagnostic_mode=False) -> dict[str, Any]:
    logger.info("Comparing Sheets vs Supabase (diagnostic_mode=%s)", diagnostic_mode)
    resources = [
        "candidate_sessions", "headset_catalog", "headset_reviews", "pending_requests", "notifications", "recent_activity"
    ]

    report = {"mismatch_count": 0, "categories": {}}
    for res in resources:
        try:
            sheets_rows = sheets_provider.list_resource(res, limit=5000)
            sup_rows = supabase_provider.list_resource(res, limit=5000)

            s_keys = set()
            for r in sheets_rows:
                k = next((str(r.get(f) or "").strip() for f in IDENTITY_FIELDS if r.get(f)), None)
                if k:
                    s_keys.add(k)

            sup_keys = set()
            for r in sup_rows:
                k = next((str(r.get(f) or "").strip() for f in IDENTITY_FIELDS if r.get(f)), None)
                if k:
                    sup_keys.add(k)

            missing_in_sup = s_keys - sup_keys
            missing_in_sheets = sup_keys - s_keys

            mismatches = len(missing_in_sup) + len(missing_in_sheets)
            if mismatches > 0:
                report["mismatch_count"] += mismatches
                report["categories"][res] = {
                    "missing_in_supabase": len(missing_in_sup),
                    "missing_in_sheets": len(missing_in_sheets)
                }
                if diagnostic_mode:
                    report["categories"][res]["missing_ids"] = list(missing_in_sup)[:10]
        except Exception as exc:
            logger.warning("Comparison failed for resource %s: %s", res, exc)

    return report


def verify_production_health(provider) -> dict[str, Any]:
    logger.info("Verifying production environment health")
    status = {"ok": True, "details": {}}

    try:
        provider._request("sync_state", query={"limit": 1})
        status["details"]["database_connection"] = "ok"
    except Exception as exc:
        status["ok"] = False
        status["details"]["database_connection"] = f"failed: {exc}"

    return status

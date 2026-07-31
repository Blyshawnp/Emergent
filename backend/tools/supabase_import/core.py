from __future__ import annotations

import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from typing import Any, Iterable, Mapping, Sequence


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
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def stable_checksum(row: Mapping[str, Any]) -> str:
    payload = json.dumps(dict(row), sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def deterministic_source_key(tab: str, row_number: int, row: Mapping[str, Any]):
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
    raise ValueError("unrecognized_boolean")


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
    for row_number, row in enumerate(rows, start=2):
        row_copy = dict(row)
        key, fallback = deterministic_source_key(tab, row_number, row_copy)
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

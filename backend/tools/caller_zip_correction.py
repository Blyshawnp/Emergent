from __future__ import annotations

import copy
from typing import Any, Iterable, Mapping


SETTING_KEY = "caller_roster_zip_corrections_v1"
SOURCE_TAB = "callers"
OLD_ZIP = "19103"
NEW_ZIP = "19130"
TARGET_NAMES = ("Sam Smith", "Susan Miller-Smith")


class CallerZipCorrectionError(ValueError):
    """Raised when a caller ZIP correction cannot be targeted unambiguously."""


def _caller_name(raw_row: Mapping[str, Any]) -> str:
    return " ".join(
        part
        for part in (
            str(raw_row.get("First") or "").strip(),
            str(raw_row.get("Last") or "").strip(),
        )
        if part
    )


def plan_current_shadow_corrections(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Build exact, idempotent correction entries without mutating staging rows."""
    candidates = list(rows)
    planned: list[dict[str, Any]] = []
    batch_ids = set()

    for target_name in TARGET_NAMES:
        matches = [row for row in candidates if _caller_name(row.get("raw_row") or {}) == target_name]
        if len(matches) != 1:
            raise CallerZipCorrectionError(
                f"{target_name}: expected exactly one current staging row, found {len(matches)}"
            )

        row = matches[0]
        raw_row = row.get("raw_row") or {}
        current_zip = str(raw_row.get("Zip") or "").strip()
        if current_zip not in {OLD_ZIP, NEW_ZIP}:
            raise CallerZipCorrectionError(
                f"{target_name}: current ZIP must be {OLD_ZIP} or {NEW_ZIP}"
            )

        staging_row_id = str(row.get("id") or "").strip()
        import_batch_id = str(row.get("import_batch_id") or "").strip()
        source_row_key = str(row.get("source_row_key") or "").strip()
        source_tab = str(row.get("source_tab") or "").strip()
        try:
            source_row_number = int(row.get("source_row_number"))
        except (TypeError, ValueError) as exc:
            raise CallerZipCorrectionError(f"{target_name}: invalid source row number") from exc

        if not staging_row_id or not import_batch_id or not source_row_key:
            raise CallerZipCorrectionError(f"{target_name}: stable staging identity is incomplete")
        if source_tab.casefold() != SOURCE_TAB or source_row_number < 2:
            raise CallerZipCorrectionError(f"{target_name}: unexpected caller source identity")

        batch_ids.add(import_batch_id)
        planned.append({
            "staging_row_id": staging_row_id,
            "import_batch_id": import_batch_id,
            "source_tab": SOURCE_TAB,
            "source_row_number": source_row_number,
            "source_row_key": source_row_key,
            "caller_name": target_name,
            "prior_zip": current_zip,
            "zip": NEW_ZIP,
            "status": "already_corrected" if current_zip == NEW_ZIP else "update_required",
        })

    if len(batch_ids) != 1:
        raise CallerZipCorrectionError("target callers do not belong to one current import batch")
    return planned


def build_correction_setting(plan: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    corrections = [dict(item) for item in plan]
    if [item.get("caller_name") for item in corrections] != list(TARGET_NAMES):
        raise CallerZipCorrectionError("correction plan is incomplete or out of order")
    return {
        "version": 1,
        "source_tab": SOURCE_TAB,
        "authoritative_provider": "google_sheets",
        "provider_cutover": False,
        "corrections": corrections,
    }


def apply_correction_overlay(
    staging_row: Mapping[str, Any],
    setting_value: Mapping[str, Any],
) -> dict[str, Any]:
    """Return a corrected current view while leaving historical raw data unchanged."""
    result = copy.deepcopy(dict(staging_row))
    row_id = str(staging_row.get("id") or "").strip()
    matches = [
        item for item in (setting_value.get("corrections") or [])
        if str(item.get("staging_row_id") or "").strip() == row_id
    ]
    if not matches:
        return result
    if len(matches) != 1:
        raise CallerZipCorrectionError("multiple corrections target the same staging row")

    correction = matches[0]
    raw_row = result.get("raw_row") or {}
    checks = (
        str(staging_row.get("import_batch_id") or "") == str(correction.get("import_batch_id") or ""),
        str(staging_row.get("source_tab") or "").casefold() == SOURCE_TAB,
        str(staging_row.get("source_row_key") or "") == str(correction.get("source_row_key") or ""),
        int(staging_row.get("source_row_number") or 0) == int(correction.get("source_row_number") or 0),
        _caller_name(raw_row) == str(correction.get("caller_name") or ""),
    )
    if not all(checks):
        raise CallerZipCorrectionError("correction identity verification failed")

    current_zip = str(raw_row.get("Zip") or "").strip()
    if current_zip not in {OLD_ZIP, NEW_ZIP}:
        raise CallerZipCorrectionError("correction ZIP precondition failed")
    result["raw_row"] = {**raw_row, "Zip": NEW_ZIP}
    return result

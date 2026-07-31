from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from data_providers.supabase import SupabaseDataProvider  # noqa: E402
from services.apps_script_api import AppsScriptApiClient, load_apps_script_api_config  # noqa: E402
from tools.supabase_import.core import missing_candidate_headers, stage_rows  # noqa: E402


def _sheets_client():
    config, status = load_apps_script_api_config(BACKEND_DIR, expected_role="sam")
    if not config:
        raise RuntimeError(f"SAM Apps Script configuration unavailable: {status.get('status')}")
    return AppsScriptApiClient(config, timeout=30)


def _read_sources(client):
    metadata = client.get("getSheetMetadata")
    sources = []
    for item in metadata.get("sheets", []):
        title = str(item.get("properties", {}).get("title") or "")
        escaped = title.replace("'", "''")
        response = client.get("getSheetRange", {"range": f"'{escaped}'!A:ZZ"})
        values = response.get("values", []) if isinstance(response, dict) else []
        headers = [str(value).strip() for value in (values[0] if values else [])]
        while headers and not headers[-1]:
            headers.pop()
        rows = []
        for raw in values[1:]:
            if not any(str(value).strip() for value in raw):
                continue
            rows.append({header: raw[index] if index < len(raw) else "" for index, header in enumerate(headers) if header})
        sources.append((title, headers, rows))
    return sources


def _manifest(sources):
    report = []
    for title, headers, rows in sources:
        item = {"tab": title, "headers": headers, "row_count": len(rows)}
        if title == "Candidate Sessions":
            item["missing_lazy_headers"] = missing_candidate_headers(headers)
        report.append(item)
    return report


def inventory(_args):
    print(json.dumps(_manifest(_read_sources(_sheets_client())), indent=2))
    return 0


def stage(args):
    sources = _read_sources(_sheets_client())
    snapshot_manifest = _manifest(sources)
    snapshot_checksum = hashlib.sha256(json.dumps(snapshot_manifest, sort_keys=True).encode("utf-8")).hexdigest()
    if args.dry_run:
        print(json.dumps({
            "dry_run": True,
            "source_count": len(sources),
            "source_row_count": sum(len(rows) for _, _, rows in sources),
            "snapshot_checksum": snapshot_checksum,
        }))
        return 0

    provider = SupabaseDataProvider(
        os.environ.get("SUPABASE_URL", ""),
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""),
        timeout=float(os.environ.get("SUPABASE_TIMEOUT_SECONDS", "10")),
    )
    batch_key = args.batch_key or f"google-sheets-{snapshot_checksum}"
    batch_rows = provider.upsert_rows("import_batches", [{
        "batch_key": batch_key,
        "source_system": "google_sheets",
        "importer_version": "1",
        "status": "extracting",
        "source_row_count": sum(len(rows) for _, _, rows in sources),
        "source_checksum": snapshot_checksum,
        "metadata": {"source_count": len(sources)},
    }], on_conflict="batch_key")
    if len(batch_rows) != 1 or not batch_rows[0].get("id"):
        raise RuntimeError("Import batch upsert did not return an exact batch identity")
    batch_id = batch_rows[0]["id"]
    staged_count = 0
    unresolved_count = 0
    for title, headers, rows in sources:
        payload = []
        for item in stage_rows(title, headers, rows):
            status = "unresolved" if item.fallback_reason else "valid"
            unresolved_count += int(status == "unresolved")
            payload.append({
                "import_batch_id": batch_id,
                "source_system": "google_sheets",
                "source_tab": item.source_tab,
                "source_row_number": item.source_row_number,
                "source_row_key": item.source_row_key,
                "source_record_id": item.source_record_id,
                "source_checksum": item.source_checksum,
                "raw_row": item.raw_row,
                "header_presence": item.header_presence,
                "normalization_status": status,
                "unresolved_reason_code": item.fallback_reason,
            })
        for start in range(0, len(payload), 100):
            provider.upsert_rows(
                "import_staging_rows", payload[start:start + 100],
                on_conflict="import_batch_id,source_tab,source_row_key",
            )
        staged_count += len(payload)
    provider.upsert_rows("import_batches", [{
        **batch_rows[0],
        "status": "staged",
        "staged_row_count": staged_count,
        "unresolved_row_count": unresolved_count,
    }], on_conflict="batch_key")
    print(json.dumps({
        "batch_key": batch_key,
        "source_row_count": sum(len(rows) for _, _, rows in sources),
        "staged_row_count": staged_count,
        "unresolved_missing_identity_count": unresolved_count,
    }))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="MTS/SAM read-only Sheets to Supabase importer")
    subparsers = parser.add_subparsers(dest="command", required=True)
    inventory_parser = subparsers.add_parser("inventory")
    inventory_parser.set_defaults(func=inventory)
    stage_parser = subparsers.add_parser("stage")
    stage_parser.add_argument("--batch-key")
    stage_parser.add_argument("--dry-run", action="store_true")
    stage_parser.set_defaults(func=stage)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

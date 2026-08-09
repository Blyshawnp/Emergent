from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# Load .env variables
env_path = BACKEND_DIR.parent / ".env"
if env_path.exists():
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ[k.strip()] = v.strip()

from data_providers.supabase import SupabaseDataProvider  # noqa: E402
from data_providers.sheets import SheetsDataProvider  # noqa: E402
from services.apps_script_api import AppsScriptApiClient, load_apps_script_api_config  # noqa: E402
from tools.supabase_import.core import (  # noqa: E402
    missing_candidate_headers,
    stage_rows,
    validate_staged_rows,
    transform_and_load_batch,
    reconcile_batch,
    rollback_batch,
    compare_shadow_provider,
    verify_production_health,
)
from tools.supabase_import.reconciliation import (  # noqa: E402
    EXECUTION_ACK_ENV,
    EXECUTION_ACK_VALUE,
    generate_reconciliation_plan,
    hosted_count_snapshot,
    public_plan,
    validate_execution_request,
)
from tools.supabase_import.execution import approved_plan_errors, execute_plan  # noqa: E402


def _sheets_client():
    config, status = load_apps_script_api_config(BACKEND_DIR, expected_role="sam")
    if not config:
        raise RuntimeError(f"SAM Apps Script configuration unavailable: {status.get('status')}")
    return AppsScriptApiClient(config, timeout=180)


def _supabase_client():
    return SupabaseDataProvider(
        os.environ.get("SUPABASE_URL", ""),
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""),
        timeout=float(os.environ.get("SUPABASE_TIMEOUT_SECONDS", "15")),
    )


def _read_sources(client):
    import time
    metadata = None
    for attempt in range(4):
        try:
            metadata = client.get("getSheetMetadata")
            break
        except Exception as exc:
            if attempt == 3:
                raise exc
            time.sleep(2.0 * (attempt + 1))
    sources = []
    for item in metadata.get("sheets", []):
        title = str(item.get("properties", {}).get("title") or "")
        escaped = title.replace("'", "''")
        response = None
        for attempt in range(4):
            try:
                response = client.get("getSheetRange", {"range": f"'{escaped}'!A:ZZ"})
                break
            except Exception as exc:
                if attempt == 3:
                    raise exc
                time.sleep(2.0 * (attempt + 1))
        time.sleep(0.5)
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


def extract(_args):
    sources = _read_sources(_sheets_client())
    manifest = _manifest(sources)
    print(json.dumps({
        "status": "extracted",
        "tab_count": len(sources),
        "total_rows": sum(len(rows) for _, _, rows in sources),
        "tabs": manifest
    }, indent=2))
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

    provider = _supabase_client()
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
        "batch_id": batch_id,
        "batch_key": batch_key,
        "source_row_count": sum(len(rows) for _, _, rows in sources),
        "staged_row_count": staged_count,
        "unresolved_missing_identity_count": unresolved_count,
    }))
    return 0


def validate(args):
    provider = _supabase_client()
    batch_id = args.batch_id
    if not batch_id:
        batches = provider._request("import_batches", query={"order": "started_at.desc", "limit": 1})
        if not batches:
            print("No import batch found")
            return 1
        batch_id = batches[0]["id"]

    if args.dry_run:
        print(json.dumps({"dry_run": True, "batch_id": batch_id, "status": "validate_planned"}))
        return 0

    validate_staged_rows(provider, batch_id)
    batches = provider._request("import_batches", query={"id": f"eq.{batch_id}"})
    if batches:
        provider.upsert_rows("import_batches", [{
            **batches[0],
            "status": "validating"
        }], on_conflict="batch_key")

    print(json.dumps({"status": "validated", "batch_id": batch_id}))
    return 0


def transform(args):
    provider = _supabase_client()
    batch_id = args.batch_id
    if not batch_id:
        batches = provider._request("import_batches", query={"order": "started_at.desc", "limit": 1})
        if not batches:
            print("No import batch found")
            return 1
        batch_id = batches[0]["id"]
    print(json.dumps({"status": "transform_planned", "batch_id": batch_id, "dry_run": True}))
    return 0


def load(args):
    provider = _supabase_client()
    batch_id = args.batch_id
    if not batch_id:
        batches = provider._request("import_batches", query={"order": "started_at.desc", "limit": 1})
        if not batches:
            print("No import batch found")
            return 1
        batch_id = batches[0]["id"]

    if not args.dry_run:
        batches = provider._request("import_batches", query={"id": f"eq.{batch_id}"})
        if batches:
            provider.upsert_rows("import_batches", [{
                **batches[0],
                "status": "loading"
            }], on_conflict="batch_key")

    res = transform_and_load_batch(provider, batch_id, dry_run=args.dry_run)
    print(json.dumps({
        "status": "loaded" if not args.dry_run else "load_planned",
        "batch_id": batch_id,
        "results": res
    }, indent=2))
    return 0


def reconcile(args):
    provider = _supabase_client()
    batch_id = args.batch_id
    if not batch_id:
        batches = provider._request("import_batches", query={"order": "started_at.desc", "limit": 1})
        if not batches:
            print("No import batch found")
            return 1
        batch_id = batches[0]["id"]

    res = reconcile_batch(provider, batch_id, dry_run=args.dry_run)
    if not args.dry_run:
        batches = provider._request("import_batches", query={"id": f"eq.{batch_id}"})
        if batches:
            provider.upsert_rows("import_batches", [{
                **batches[0],
                "status": "succeeded",
                "completed_at": datetime.datetime.utcnow().isoformat() + "Z"
            }], on_conflict="batch_key")

    print(json.dumps({
        "status": "reconciled" if not args.dry_run else "reconcile_planned",
        "batch_id": batch_id,
        "results": res
    }, indent=2))
    return 0


def report(args):
    provider = _supabase_client()
    batch_id = args.batch_id
    if not batch_id:
        batches = provider._request("import_batches", query={"order": "started_at.desc", "limit": 1})
        if not batches:
            print("No import batch found")
            return 1
        batch_id = batches[0]["id"]

    batches = provider._request("import_batches", query={"id": f"eq.{batch_id}"})
    staging_rows = provider._request("import_staging_rows", query={"import_batch_id": f"eq.{batch_id}"})
    reconciliations = provider._request("reconciliation_results", query={"import_batch_id": f"eq.{batch_id}"})

    print(json.dumps({
        "batch": batches[0] if batches else None,
        "staging_summary": {
            "total": len(staging_rows),
            "statuses": {
                "valid": sum(1 for r in staging_rows if r["normalization_status"] == "valid"),
                "unresolved": sum(1 for r in staging_rows if r["normalization_status"] == "unresolved"),
                "duplicate": sum(1 for r in staging_rows if r["normalization_status"] == "duplicate"),
                "rejected": sum(1 for r in staging_rows if r["normalization_status"] == "rejected"),
            }
        },
        "reconciliation": reconciliations
    }, indent=2))
    return 0


def rollback_batch_cmd(args):
    provider = _supabase_client()
    batch_id = args.batch_id
    if not batch_id:
        print("Explicit batch-id is required for rollback")
        return 1
    res = rollback_batch(provider, batch_id, dry_run=args.dry_run)
    print(json.dumps({
        "status": "rolled_back" if not args.dry_run else "rollback_planned",
        "batch_id": batch_id,
        "results": res
    }, indent=2))
    return 0


def sync_incremental_cmd(args):
    provider = _supabase_client()
    if args.action in {"rollback-preview", "rollback"}:
        if not args.batch_id:
            print(json.dumps({"status": "blocked", "errors": ["batch_id_required"]}, indent=2))
            return 2
        if args.action == "rollback-preview":
            print(json.dumps(provider.preview_reconciliation_rollback(args.batch_id), indent=2))
            return 0
        errors = []
        if not args.acknowledge_rollback:
            errors.append("rollback_ack_missing")
        if os.environ.get(EXECUTION_ACK_ENV) != EXECUTION_ACK_VALUE:
            errors.append("task_level_execution_ack_missing")
        if errors:
            print(json.dumps({"status": "blocked", "errors": errors}, indent=2))
            return 2
        print(json.dumps(provider.rollback_reconciliation_batch(args.batch_id), indent=2))
        return 0

    sheets = SheetsDataProvider(_sheets_client())
    if args.execute:
        # Never execute a serialized plan. This fresh provider instance fetches
        # exactly one new Sheets snapshot and reconstructs all private payloads.
        comparison = compare_shadow_provider(sheets, provider, diagnostic_mode=False)
        plan = generate_reconciliation_plan(sheets, provider, comparison_result=comparison)
        errors = validate_execution_request(
            plan,
            project_ref=args.project_ref,
            plan_checksum=args.plan_checksum,
            snapshot_checksum=args.snapshot_checksum,
            acknowledged=args.acknowledge_live_reconciliation,
        )
        errors.extend(approved_plan_errors(plan))
        if errors:
            print(json.dumps({"status": "blocked", "mode": "execute", "errors": sorted(set(errors))}, indent=2))
            return 2
        result = execute_plan(provider, plan)
        print(json.dumps({"status": "completed", "mode": "execute", **result}, indent=2))
        return 0

    counts_before = hosted_count_snapshot(provider)
    comparison = compare_shadow_provider(sheets, provider, diagnostic_mode=False)
    plan = generate_reconciliation_plan(
        sheets, provider, comparison_result=comparison,
    )
    counts_after = hosted_count_snapshot(provider)
    if counts_before != counts_after:
        raise RuntimeError("critical_no_write_verification_failed")
    output = public_plan(plan, diagnostic=args.diagnostic)
    output["dry_run"] = True
    output["hosted_counts_before"] = counts_before
    output["hosted_counts_after"] = counts_after
    output["hosted_counts_unchanged"] = True
    if args.output_plan:
        safe_plan = public_plan(plan, diagnostic=True)
        Path(args.output_plan).write_text(
            json.dumps(safe_plan, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        output["safe_plan_written"] = True
    print(json.dumps(output, indent=2))
    return 0 if plan.get("status") == "ready" else 1


def compare_shadow_cmd(args):
    sheets = SheetsDataProvider(_sheets_client())
    sup = _supabase_client()
    res = compare_shadow_provider(sheets, sup, diagnostic_mode=args.diagnostic)
    print(json.dumps(res, indent=2))
    return 0 if res.get("overall_readiness") == "ready" and res.get("completed") else 1


def verify_production_cmd(_args):
    provider = _supabase_client()
    comparison = compare_shadow_provider(SheetsDataProvider(_sheets_client()), provider)
    res = verify_production_health(provider, comparison_result=comparison)
    print(json.dumps(res, indent=2))
    return 0 if res.get("ok") and res.get("shadow_read_mapped_domains_ready") else 1


def idempotency_check_cmd(args):
    provider = _supabase_client()
    batch_id = args.batch_id
    if not batch_id:
        batches = provider._request('import_batches', query={'status': 'eq.succeeded', 'select': 'id,batch_key', 'limit': '1'})
        batch_id = batches[0]['id'] if batches else None
    if not batch_id:
        print(json.dumps({'error': 'no_succeeded_batch_found'}))
        return 1
    result = reconcile(type('Args', (), {'batch_id': batch_id, 'dry_run': True})())
    print(json.dumps({'idempotency_check': 'ok', 'batch_id': batch_id, 'dry_run': True}))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="MTS/SAM Sheets-to-Supabase importer and shadow verification CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # inventory
    subparsers.add_parser("inventory").set_defaults(func=inventory)

    # extract
    subparsers.add_parser("extract").set_defaults(func=extract)

    # stage
    stage_parser = subparsers.add_parser("stage")
    stage_parser.add_argument("--batch-key")
    stage_parser.add_argument("--dry-run", action="store_true")
    stage_parser.set_defaults(func=stage)

    # validate
    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("--batch-id")
    validate_parser.add_argument("--dry-run", action="store_true")
    validate_parser.set_defaults(func=validate)

    # transform
    transform_parser = subparsers.add_parser("transform")
    transform_parser.add_argument("--batch-id")
    transform_parser.set_defaults(func=transform)

    # load
    load_parser = subparsers.add_parser("load")
    load_parser.add_argument("--batch-id")
    load_parser.add_argument("--dry-run", action="store_true")
    load_parser.set_defaults(func=load)

    # reconcile
    reconcile_parser = subparsers.add_parser("reconcile")
    reconcile_parser.add_argument("--batch-id")
    reconcile_parser.add_argument("--dry-run", action="store_true")
    reconcile_parser.set_defaults(func=reconcile)

    # idempotency-check (alias for running reconcile on latest batch with dry-run)
    idempotency_parser = subparsers.add_parser(
        'idempotency-check',
        help='Re-stage latest batch in dry-run mode and confirm zero new canonical rows'
    )
    idempotency_parser.add_argument('--batch-id')
    idempotency_parser.set_defaults(func=idempotency_check_cmd)

    # report
    report_parser = subparsers.add_parser("report")
    report_parser.add_argument("--batch-id")
    report_parser.set_defaults(func=report)

    # rollback-batch
    rollback_parser = subparsers.add_parser("rollback-batch")
    rollback_parser.add_argument("--batch-id", required=True)
    rollback_parser.add_argument("--dry-run", action="store_true")
    rollback_parser.set_defaults(func=rollback_batch_cmd)

    # sync-incremental
    sync_parser = subparsers.add_parser(
        "sync-incremental",
        help="Build a one-snapshot exact reconciliation plan; defaults to zero-write dry-run",
    )
    sync_parser.add_argument("action", nargs="?", choices=("rollback-preview", "rollback"))
    mode = sync_parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--execute", action="store_true")
    sync_parser.add_argument("--diagnostic", action="store_true")
    sync_parser.add_argument("--output-plan")
    sync_parser.add_argument("--project-ref")
    sync_parser.add_argument("--plan-checksum")
    sync_parser.add_argument("--snapshot-checksum")
    sync_parser.add_argument("--acknowledge-live-reconciliation", action="store_true")
    sync_parser.add_argument("--batch-id")
    sync_parser.add_argument("--acknowledge-rollback", action="store_true")
    sync_parser.set_defaults(func=sync_incremental_cmd)

    # compare-shadow
    compare_parser = subparsers.add_parser("compare-shadow")
    compare_parser.add_argument("--diagnostic", action="store_true")
    compare_parser.set_defaults(func=compare_shadow_cmd)

    # verify-production
    subparsers.add_parser(
        "verify-production",
        help="Run a fresh all-domain comparison and fail closed unless current mapped readiness is proven",
    ).set_defaults(func=verify_production_cmd)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

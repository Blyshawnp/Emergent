"""
READ-ONLY Audit Script: Detect Post-Cutover Completed MTS Sessions Missing from Supabase

SCOPE LIMITATION:
- Local SQLite source: C:\\Emergent-Mock-BU\\APP-main\\backend\\data\\mock_testing_suite.sqlite3
- Coverage: THIS LOCAL INSTALLATION ONLY
- Cannot detect sessions completed on other testers' individual desktop installations
  unless recorded in a centralized shared log.
"""

import os
import sys
import json
import sqlite3
from pathlib import Path
from datetime import datetime, timezone

# Add backend to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

# Ensure production environment variables
os.environ.setdefault("MTS_DATA_PROVIDER", "supabase")
os.environ.setdefault("MTS_SHADOW_COMPARE", "false")
os.environ.setdefault("MTS_DUAL_WRITE_ENABLED", "false")

from data_providers.factory import build_data_provider, configured_provider_mode, _read_runtime_config_supabase
from data_providers.supabase import SupabaseDataProvider


def run_audit():
    print("=" * 70)
    print("MTS POST-CUTOVER SESSION AUDIT (READ-ONLY)")
    print("=" * 70)
    local_db_path = Path(__file__).resolve().parent.parent / "backend" / "data" / "mock_testing_suite.sqlite3"
    print(f"Audit Source: {local_db_path}")
    print("Coverage: THIS MACHINE ONLY")
    print("Note: Other testers' local installations require their own separate audit.")
    print("-" * 70)

    # 1. Read local SQLite history
    local_records = []
    if local_db_path.is_file():
        con = sqlite3.connect(str(local_db_path))
        con.row_factory = sqlite3.Row
        cur = con.cursor()
        cur.execute("SELECT id, data, timestamp, created_at FROM history_documents ORDER BY id DESC")
        for row in cur.fetchall():
            try:
                doc = json.loads(row["data"])
                doc["_sqlite_id"] = row["id"]
                doc["_sqlite_created_at"] = row["created_at"]
                local_records.append(doc)
            except Exception as e:
                print(f"Error parsing SQLite row {row['id']}: {e}")
        con.close()

    print(f"Total Local SQLite History Records Found: {len(local_records)}")

    # 2. Query Supabase (read-only)
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "") or os.environ.get("SUPABASE_ANON_KEY", "")
    if not url or not key:
        cfg_url, cfg_key = _read_runtime_config_supabase()
        url = url or cfg_url
        key = key or cfg_key

    if not url or not key:
        print("ERROR: Supabase credentials not configured. Cannot perform remote comparison.")
        return

    provider = SupabaseDataProvider(url, key)

    try:
        remote_sessions = provider.list_resource("candidate_sessions", limit=5000)
        remote_candidates = provider.list_resource("candidates", limit=5000)
        remote_attempts = provider.list_resource("session_attempts", limit=5000)
    except Exception as exc:
        print(f"ERROR: Failed to query Supabase: {exc}")
        return

    print(f"Total Remote Supabase candidate_sessions Found: {len(remote_sessions)}")
    print(f"Total Remote Supabase candidates Found: {len(remote_candidates)}")
    print(f"Total Remote Supabase session_attempts Found: {len(remote_attempts)}")
    print("-" * 70)

    # Build lookup indices
    remote_session_ids = {s.get("session_id") for s in remote_sessions if s.get("session_id")}
    remote_cand_names = {c.get("display_name", "").strip().lower(): c for c in remote_candidates if c.get("display_name")}
    remote_cand_ids = {c.get("source_candidate_id"): c for c in remote_candidates if c.get("source_candidate_id")}

    # Count attempts per session
    attempts_per_session_uuid = {}
    for att in remote_attempts:
        s_uuid = att.get("session_id")
        if s_uuid:
            attempts_per_session_uuid[s_uuid] = attempts_per_session_uuid.get(s_uuid, 0) + 1

    # 3. Check each local record against Supabase
    missing_sessions = []
    found_sessions = []

    for rec in local_records:
        cand_name = str(rec.get("candidate_name") or rec.get("candidate") or "").strip()
        sess_id = str(rec.get("history_id") or rec.get("session_id") or rec.get("resume_source_history_id") or "").strip()
        completed_at = str(rec.get("completed_at") or rec.get("timestamp_iso") or rec.get("timestamp") or "").strip()
        final_result = str(rec.get("final_status") or rec.get("status") or rec.get("final_result") or "").strip()
        final_attempt = bool(rec.get("final_attempt"))

        # Calculate expected physical call count
        call_results = [
            (1, (rec.get("call_1") or {}).get("result") or rec.get("call_1_result")),
            (2, (rec.get("call_2") or {}).get("result") or rec.get("call_2_result")),
            (3, (rec.get("call_3") or {}).get("result") or rec.get("call_3_result")),
        ]
        valid_calls = [(num, res) for num, res in call_results if res not in (None, "")]
        expected_attempts = len(valid_calls) if valid_calls else 1

        sess_exists = sess_id in remote_session_ids
        cand_exists = (cand_name.lower() in remote_cand_names) or (f"cand-{cand_name.lower().replace(' ', '-')}" in remote_cand_ids)

        # Count actual attempts found
        actual_attempts = 0
        if sess_exists:
            for s in remote_sessions:
                if s.get("session_id") == sess_id:
                    actual_attempts = attempts_per_session_uuid.get(s.get("id"), 0)
                    break

        item = {
            "session_id": sess_id,
            "candidate_name": cand_name,
            "completed_at": completed_at,
            "final_result": final_result,
            "final_attempt": final_attempt,
            "expected_attempts": expected_attempts,
            "supabase_candidate_exists": "YES" if cand_exists else "NO",
            "supabase_session_exists": "YES" if sess_exists else "NO",
            "supabase_attempts_found": actual_attempts,
            "local_machine": "This Workstation (SQLite)",
        }

        if not sess_exists:
            missing_sessions.append(item)
        else:
            found_sessions.append(item)

    print(f"\nAUDIT FINDINGS:")
    print(f"Local sessions present in Supabase: {len(found_sessions)}")
    print(f"Local sessions MISSING from Supabase: {len(missing_sessions)}")
    print("-" * 70)

    if missing_sessions:
        print("\nMISSING SESSIONS REQUIRING OWNER REVIEW FOR REPAIR:")
        for idx, m in enumerate(missing_sessions, 1):
            print(f"\n[{idx}] Candidate: {m['candidate_name']}")
            print(f"    Session ID: {m['session_id']}")
            print(f"    Completed At: {m['completed_at']}")
            print(f"    Final Result: {m['final_result']} (Final Attempt: {m['final_attempt']})")
            print(f"    Expected Attempts: {m['expected_attempts']}")
            print(f"    Supabase Candidate Exists: {m['supabase_candidate_exists']}")
            print(f"    Supabase Session Exists: {m['supabase_session_exists']}")
            print(f"    Supabase Attempts Found: {m['supabase_attempts_found']}")
            print(f"    Local Machine/Source: {m['local_machine']}")
    else:
        print("No missing sessions found in local SQLite history.")

    # 4. Centralized evidence search
    print("\n" + "=" * 70)
    print("CENTRALIZED EVIDENCE SEARCH (READ-ONLY)")
    print("=" * 70)
    try:
        audit_events = provider.list_resource("audit_events", limit=100)
        print(f"Audit Events checked: {len(audit_events)} records found.")
    except Exception as exc:
        print(f"Audit events table check: {exc}")

    try:
        notifications = provider.list_resource("notifications", limit=100)
        print(f"Notifications checked: {len(notifications)} records found.")
    except Exception as exc:
        print(f"Notifications table check: {exc}")

    print("\nSummary: If other testers use separate installations/local SQLite DBs,")
    print("their local sessions cannot be detected from this workstation.")
    print("Each workstation requires running this audit script independently.")


if __name__ == "__main__":
    run_audit()

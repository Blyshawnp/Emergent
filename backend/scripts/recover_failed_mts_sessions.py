"""
Session Recovery Script for Un-synced Local MTS Sessions
=========================================================
Target sessions (strictly whitelisted for stabilization recovery):
- Jennifer West (History ID 36, session_id: ff58aea1-dbf8-4048-83d0-52a9bd89639a)
- Braxton Baby (History ID 35, session_id: 0cefd3e0-8fad-4c1d-b543-2d883bf8577d)
- Reginald Jefferson (History ID 34, session_id: 484e4b93-e0dc-4652-b87d-6fac840f3ec2)

Default mode is DRY-RUN only.
Strictly isolated owner-operated diagnostic tool.
Does NOT expose any open HTTP endpoints on the server.
Never mutates Mock Testa sessions.
"""

import os
import sys
import json
import sqlite3
import argparse
from pathlib import Path

# Add backend directory to path
backend_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(backend_dir))

from server import (
    _build_candidate_lifecycle_payloads,
)


ALLOWED_TARGET_SESSION_IDS = {
    "ff58aea1-dbf8-4048-83d0-52a9bd89639a",  # Jennifer West (History ID 36)
    "0cefd3e0-8fad-4c1d-b543-2d883bf8577d",  # Braxton Baby (History ID 35)
    "484e4b93-e0dc-4652-b87d-6fac840f3ec2",  # Reginald Jefferson (History ID 34)
}

TARGET_CANDIDATE_NAMES = {
    "jennifer west",
    "braxton baby",
    "reginald jefferson",
}


def get_sqlite_path():
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("APPDATA environment variable not set")
    db_path = Path(appdata) / "Mock Testing Suite" / "mock_testing_suite.sqlite3"
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found at {db_path}")
    return str(db_path)


def inspect_and_build_payloads(db_path, session_ids=None):
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    cursor = conn.cursor()

    cursor.execute("SELECT id, timestamp, created_at, data FROM history_documents ORDER BY id DESC")
    rows = cursor.fetchall()
    conn.close()

    candidates_found = []

    for row_id, timestamp, created_at, data_json in rows:
        try:
            session_data = json.loads(data_json)
        except Exception:
            continue

        cand_name = str(session_data.get("candidate_name") or "").strip()
        sess_id = str(session_data.get("session_id") or "").strip()

        # Guard: NEVER process Mock Testa
        if "mock testa" in cand_name.lower():
            continue

        if session_ids and sess_id not in session_ids:
            continue

        if not session_ids and (sess_id not in ALLOWED_TARGET_SESSION_IDS and cand_name.lower() not in TARGET_CANDIDATE_NAMES):
            continue

        # Strictly enforce allowed recovery IDs
        if sess_id not in ALLOWED_TARGET_SESSION_IDS:
            continue

        built = _build_candidate_lifecycle_payloads(session_data, candidate_action="updated")
        candidates_found.append({
            "history_id": row_id,
            "timestamp": timestamp,
            "created_at": created_at,
            "candidate_name": cand_name,
            "session_id": sess_id,
            "session_data": session_data,
            "built_payloads": built,
        })

    return candidates_found


def main():
    parser = argparse.ArgumentParser(
        description="Inspect and dry-run candidate lifecycle payloads for un-synced local MTS sessions. Dry-run only; hosted execution is deferred pending deployment."
    )
    parser.add_argument("--session-id", type=str, help="Specific authorized session ID to inspect")

    args = parser.parse_args()

    if args.session_id and args.session_id not in ALLOWED_TARGET_SESSION_IDS:
        sys.exit(f"ERROR: Session ID '{args.session_id}' is not in the authorized stabilization recovery list ({ALLOWED_TARGET_SESSION_IDS}). Aborting.")

    db_path = get_sqlite_path()
    print(f"Reading SQLite database: {db_path}")

    session_filter = [args.session_id] if args.session_id else None
    sessions_to_recover = inspect_and_build_payloads(db_path, session_filter)

    print(f"\nFound {len(sessions_to_recover)} authorized target session(s) in local SQLite:")

    for item in sessions_to_recover:
        print(f"\n========================================================")
        print(f"Candidate: {item['candidate_name']}")
        print(f"History ID: {item['history_id']}")
        print(f"Session ID: {item['session_id']}")
        print(f"Timestamp: {item['timestamp']}")
        built = item["built_payloads"]
        if not built.get("ok"):
            print(f"PAYLOAD BUILD ERROR: {built.get('reason')}")
            continue

        sess = built["session_payload"]
        attempts = built["attempt_payloads"]

        print(f"Calculated Result: {sess.get('calculated_result')}")
        print(f"Final Result: {sess.get('final_result')}")
        print(f"Final Attempt: {sess.get('final_attempt')}")
        print(f"Physical Calls Count: {len(attempts)}")
        print(f"Has Newbie Shift: {bool(sess.get('newbie_shift_data'))}")
        print(f"Coaching Summary Preview:\n  {repr(sess.get('coaching_summary', '')[:120])}...")
        print(f"Fail Summary Preview:\n  {repr(sess.get('fail_summary', '')[:120])}...")

    print(f"\n========================================================")
    print("[DRY RUN ONLY] Inspected payloads successfully.")
    print("Hosted execution is deferred pending database migration deployment and owner authorization.")
    print("========================================================\n")


if __name__ == "__main__":
    main()

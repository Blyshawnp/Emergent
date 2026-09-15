import os
import sys
import unittest
from unittest.mock import patch, MagicMock, AsyncMock
from pathlib import Path
from datetime import datetime, timezone

from fastapi.testclient import TestClient

backend_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(backend_dir))

import server
from server import app, db, _lookup_shared_candidate_sessions


class TestHostedSyncSafety(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.created_history_ids = []

    def tearDown(self):
        for hid in self.created_history_ids:
            try:
                db.history.store.execute("DELETE FROM history_documents WHERE data LIKE ?", (f"%{hid}%",))
            except Exception:
                pass

    def test_finish_session_hosted_success_tags_synced(self):
        """When hosted persistence succeeds, session is saved locally and tagged sync_status='synced'."""
        sess_id = "test-sync-success-1"
        self.created_history_ids.append(sess_id)
        session_data = {
            "session_id": sess_id,
            "candidate_name": "Synced Success Candidate",
            "tester_name": "Tester A",
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
        }

        with patch.object(server.db.sessions, "find_one", new=AsyncMock(return_value=session_data)), \
             patch.object(server.db.sessions, "delete_one", new=AsyncMock(return_value=None)), \
             patch("server.configured_provider_mode", return_value="supabase"), \
             patch("server._persist_candidate_lifecycle_to_supabase", return_value={"ok": True, "session_id": sess_id}):
            res = self.client.post("/api/finish-session", json={})
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertTrue(data["ok"])
            self.assertTrue(data["sharedTracking"]["ok"])

        # Check local history record in SQLite
        rows = db.history.store.fetchall("SELECT data FROM history_documents ORDER BY id DESC")
        matching = [server.SQLiteCollection.decode(r["data"]) for r in rows if r["data"] and sess_id in r["data"]]
        self.assertTrue(len(matching) >= 1)
        rec = matching[0]
        self.assertEqual(rec.get("sync_status"), "synced")
        self.assertIsNotNone(rec.get("synced_at"))
        self.assertIsNone(rec.get("sync_error"))

    def test_finish_session_hosted_failure_preserves_local_and_tags_local_only(self):
        """When hosted persistence fails, session is preserved locally, tagged 'local_only', and returns sharedTracking.ok=False."""
        sess_id = "test-sync-failed-1"
        self.created_history_ids.append(sess_id)
        session_data = {
            "session_id": sess_id,
            "candidate_name": "Local Only Candidate",
            "tester_name": "Tester B",
            "call_1": {"result": "Fail"},
            "call_2": {"result": "Pass"},
        }

        failure_result = {
            "ok": False,
            "stage": "hosted_edge_function",
            "error_code": "NETWORK_TIMEOUT",
            "error": "Connection to hosted service timed out.",
        }

        with patch.object(server.db.sessions, "find_one", new=AsyncMock(return_value=session_data)), \
             patch.object(server.db.sessions, "delete_one", new=AsyncMock(return_value=None)), \
             patch("server.configured_provider_mode", return_value="supabase"), \
             patch("server._persist_candidate_lifecycle_to_supabase", return_value=failure_result):
            res = self.client.post("/api/finish-session", json={})
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertTrue(data["ok"])  # local save succeeded
            self.assertFalse(data["sharedTracking"]["ok"])  # hosted sync failed

        # Local history record MUST be preserved completely in SQLite
        rows = db.history.store.fetchall("SELECT data FROM history_documents ORDER BY id DESC")
        matching = [server.SQLiteCollection.decode(r["data"]) for r in rows if r["data"] and sess_id in r["data"]]
        self.assertTrue(len(matching) >= 1)
        rec = matching[0]
        self.assertEqual(rec.get("candidate_name"), "Local Only Candidate")
        self.assertEqual(rec.get("sync_status"), "local_only")
        self.assertIsNone(rec.get("synced_at"))
        self.assertEqual(rec.get("sync_error"), "Connection to hosted service timed out.")

    def test_retry_hosted_sync_success_updates_status(self):
        """Retrying hosted sync reuses exact session ID, idempotently persists to Supabase, and updates SQLite to synced."""
        sess_id = "test-retry-success-1"
        history_id = f"hist-{sess_id}"
        self.created_history_ids.append(sess_id)
        record = {
            "history_id": history_id,
            "session_id": sess_id,
            "candidate_name": "Retry Success Candidate",
            "tester_name": "Tester C",
            "final_status": "Pass",
            "sync_status": "local_only",
            "sync_error": "Previous failure",
        }
        db.history.store.execute(
            "INSERT INTO history_documents (data, timestamp) VALUES (?, ?)",
            (server.SQLiteCollection.encode(record), datetime.now(timezone.utc).isoformat()),
        )

        with patch("server.configured_provider_mode", return_value="supabase"), \
             patch("server._persist_candidate_lifecycle_to_supabase", return_value={"ok": True, "session_id": sess_id}) as mock_persist:
            res = self.client.post(f"/api/history/session/{history_id}/retry-sync")
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertTrue(data["ok"])
            self.assertEqual(data["sync_status"], "synced")
            self.assertEqual(data["message"], "Hosted sync succeeded.")

            # Verify idempotency: called with exact record
            self.assertEqual(mock_persist.call_count, 1)
            passed_session = mock_persist.call_args[0][0]
            self.assertEqual(passed_session.get("session_id"), sess_id)

        # Verify updated in SQLite
        rows = db.history.store.fetchall("SELECT data FROM history_documents ORDER BY id DESC")
        matching = [server.SQLiteCollection.decode(r["data"]) for r in rows if r["data"] and history_id in r["data"]]
        self.assertTrue(len(matching) >= 1)
        rec = matching[0]
        self.assertEqual(rec.get("sync_status"), "synced")
        self.assertIsNotNone(rec.get("synced_at"))
        self.assertIsNone(rec.get("sync_error"))

    def test_retry_hosted_sync_failure_preserves_local_only(self):
        """Failed retry preserves local_only status and updates error."""
        sess_id = "test-retry-fail-1"
        history_id = f"hist-{sess_id}"
        self.created_history_ids.append(sess_id)
        record = {
            "history_id": history_id,
            "session_id": sess_id,
            "candidate_name": "Retry Fail Candidate",
            "tester_name": "Tester D",
            "final_status": "Pass",
            "sync_status": "local_only",
        }
        db.history.store.execute(
            "INSERT INTO history_documents (data, timestamp) VALUES (?, ?)",
            (server.SQLiteCollection.encode(record), datetime.now(timezone.utc).isoformat()),
        )

        failure_result = {"ok": False, "error": "Hosted RPC failed: connection refused"}
        with patch("server.configured_provider_mode", return_value="supabase"), \
             patch("server._persist_candidate_lifecycle_to_supabase", return_value=failure_result):
            res = self.client.post(f"/api/history/session/{history_id}/retry-sync")
            self.assertEqual(res.status_code, 200)
            data = res.json()
            self.assertFalse(data["ok"])
            self.assertEqual(data["sync_status"], "local_only")
            self.assertIn("connection refused", data["error"])

        # Check in SQLite
        rows = db.history.store.fetchall("SELECT data FROM history_documents ORDER BY id DESC")
        matching = [server.SQLiteCollection.decode(r["data"]) for r in rows if r["data"] and history_id in r["data"]]
        rec = matching[0]
        self.assertEqual(rec.get("sync_status"), "local_only")
        self.assertEqual(rec.get("sync_error"), "Hosted RPC failed: connection refused")

    def test_retry_hosted_sync_not_found(self):
        """Retrying non-existent session returns 200 with ok=False."""
        res = self.client.post("/api/history/session/completely-unknown-session-id/retry-sync")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertFalse(data["ok"])
        self.assertIn("not found", data["error"].lower())

    def test_get_history_exposes_sync_status(self):
        """GET /api/history returns sync_status on every record."""
        res = self.client.get("/api/history")
        self.assertEqual(res.status_code, 200)
        history = res.json()
        self.assertIsInstance(history, list)
        for item in history:
            self.assertIn("sync_status", item)
            self.assertIn(item["sync_status"], ("synced", "local_only"))

    def test_autocomplete_tags_synced_vs_local_only(self):
        """Candidate autocomplete tags remote canonical rows as synced and unmerged local rows as local_only."""
        local_sess_id = "autocomplete-local-1"
        self.created_history_ids.append(local_sess_id)
        local_sess = {
            "session_id": local_sess_id,
            "history_id": local_sess_id,
            "candidate_name": "UniqueLocalCandidate Test",
            "status": "Incomplete",
            "sync_status": "local_only",
        }
        db.history.store.execute(
            "INSERT INTO history_documents (data, timestamp) VALUES (?, ?)",
            (server.SQLiteCollection.encode(local_sess), datetime.now(timezone.utc).isoformat()),
        )

        with patch("server.configured_provider_mode", return_value="supabase"), \
             patch("server._get_active_data_provider") as mock_provider:
            mock_inst = MagicMock()
            mock_inst.list_resource.return_value = [
                {
                    "session_id": "autocomplete-remote-1",
                    "candidate_name": "UniqueRemoteCandidate Test",
                    "status": "Pass",
                }
            ]
            mock_provider.return_value = mock_inst

            # Query local
            local_res = _lookup_shared_candidate_sessions("UniqueLocalCandidate")
            self.assertTrue(local_res["ok"])
            matching_local = [m for m in local_res["matches"] if "UniqueLocalCandidate" in m.get("candidate_name", "")]
            self.assertTrue(len(matching_local) >= 1)
            self.assertEqual(matching_local[0].get("sync_status"), "local_only")

            # Query remote
            remote_res = _lookup_shared_candidate_sessions("UniqueRemoteCandidate")
            self.assertTrue(remote_res["ok"])
            matching_remote = [m for m in remote_res["matches"] if "UniqueRemoteCandidate" in m.get("candidate_name", "")]
            self.assertTrue(len(matching_remote) >= 1)
            self.assertEqual(matching_remote[0].get("sync_status"), "synced")


if __name__ == "__main__":
    unittest.main()

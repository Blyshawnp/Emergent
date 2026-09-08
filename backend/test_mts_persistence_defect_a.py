import asyncio
import os
import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock, patch

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))

import server
from data_providers.dual_write import (
    ADAPTER_REGISTRY,
    TABLE_ALLOWED_COLUMNS,
    CandidatesAdapter,
    CandidateSessionsAdapter,
    SessionAttemptsAdapter,
)


class MtsPersistenceDefectATests(unittest.TestCase):
    """Verifies canonical Supabase primary session-completion persistence,

    multi-call attempt generation, idempotency, partial-failure recovery,
    cross-client visibility, canonical column precedence, and age pruning.
    """

    def setUp(self):
        self.env_patcher = patch.dict(os.environ, {
            "MTS_DATA_PROVIDER": "supabase",
            "MTS_SHADOW_COMPARE": "false",
            "MTS_DUAL_WRITE_ENABLED": "false",
            "MTS_DUAL_WRITE_DOMAINS": "[]",
        })
        self.env_patcher.start()

    def tearDown(self):
        self.env_patcher.stop()

    def _create_mock_store(self):
        """In-memory mock store simulating Supabase tables with unique constraints."""
        tables = {
            "candidates": {},           # (source_system, source_candidate_id) -> row
            "candidate_sessions": {},   # session_id -> row
            "session_attempts": {},     # source_action_id -> row
            "headset_reviews": {},      # review_id -> row
        }

        provider = MagicMock()

        def mock_upsert(table, rows, *, on_conflict, resolution="merge-duplicates"):
            if table not in tables:
                tables[table] = {}
            results = []
            for r in rows:
                row_copy = dict(r)
                if not row_copy.get("id"):
                    row_copy["id"] = f"uuid-{table}-{len(tables[table]) + 1}"

                # Determine key based on table and conflict_key
                if table == "candidates":
                    key = (row_copy.get("source_system", "google_sheets"), row_copy.get("source_candidate_id"))
                elif table == "candidate_sessions":
                    key = row_copy.get("session_id")
                elif table == "session_attempts":
                    key = row_copy.get("source_action_id")
                elif table == "headset_reviews":
                    key = row_copy.get("review_id")
                else:
                    key = row_copy.get("id")

                if key in tables[table]:
                    # Update existing row
                    tables[table][key].update(row_copy)
                    results.append(dict(tables[table][key]))
                else:
                    tables[table][key] = row_copy
                    results.append(dict(row_copy))
            return results

        def mock_list(table, filters=None, limit=5000):
            rows = list(tables.get(table, {}).values())
            return rows[:limit]

        provider.upsert_rows.side_effect = mock_upsert
        provider.list_resource.side_effect = mock_list
        return provider, tables

    def test_legacy_path_produces_zero_supabase_writes_when_dual_write_off(self):
        """Step A (Regression proof): Proves that _sync_shared_candidate_tracking

        produces ZERO writes to Supabase when MTS_DATA_PROVIDER=supabase and dual-write is OFF.
        """
        provider, tables = self._create_mock_store()
        session_record = {
            "session_id": "test-session-legacy-1",
            "candidate_name": "Devon Tester",
            "tester_name": "Senior Evaluator",
            "final_result": "Fail",
            "attempt_number": 1,
            "call_1": {"result": "Fail"},
            "call_2": {"result": "Fail"},
        }
        with patch("server._get_active_data_provider", return_value=provider), \
             patch("server._shared_sheet_context", return_value={"ok": False, "error": "Sheets unavailable"}):
            result = server._sync_shared_candidate_tracking(session_record)

        self.assertFalse(result.get("ok"))
        self.assertEqual(len(tables["candidates"]), 0)
        self.assertEqual(len(tables["candidate_sessions"]), 0)
        self.assertEqual(len(tables["session_attempts"]), 0)

    def test_primary_supabase_persistence_writes_all_entities(self):
        """Step C: Tests that _persist_candidate_lifecycle_to_supabase writes

        candidates, candidate_sessions, and session_attempts to Supabase with dual-write OFF.
        """
        provider, tables = self._create_mock_store()
        session_record = {
            "session_id": "sess-primary-001",
            "candidate_name": "Devon Tester",
            "tester_name": "Senior Evaluator",
            "final_result": "Fail",
            "attempt_number": 1,
            "call_1": {"result": "Fail"},
            "call_2": {"result": "Fail"},
        }
        with patch("server._get_active_data_provider", return_value=provider):
            res = server._persist_candidate_lifecycle_to_supabase(session_record, "appended")

        self.assertTrue(res.get("ok"), f"Persistence failed: {res}")
        self.assertEqual(len(tables["candidates"]), 1)
        self.assertEqual(len(tables["candidate_sessions"]), 1)
        self.assertEqual(len(tables["session_attempts"]), 2)

        # Verify candidate entity
        cand = list(tables["candidates"].values())[0]
        self.assertEqual(cand["display_name"], "Devon Tester")
        self.assertEqual(cand["source_candidate_id"], "cand-devon-tester")
        self.assertEqual(cand["source_system"], "google_sheets")

        # Verify session entity
        sess = list(tables["candidate_sessions"].values())[0]
        self.assertEqual(sess["session_id"], "sess-primary-001")
        self.assertEqual(sess["candidate_name"], "Devon Tester")
        self.assertEqual(sess["final_result"], "Fail")
        self.assertEqual(sess["candidate_id"], cand["id"])

        # Verify attempt entities
        attempts = list(tables["session_attempts"].values())
        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0]["attempt_number"], 1)
        self.assertEqual(attempts[0]["result"], "Fail")
        self.assertEqual(attempts[0]["source_action_id"], "google_sheets:attempt:sess-primary-001:1")
        self.assertEqual(attempts[0]["session_id"], sess["id"])

        self.assertEqual(attempts[1]["attempt_number"], 2)
        self.assertEqual(attempts[1]["result"], "Fail")
        self.assertEqual(attempts[1]["source_action_id"], "google_sheets:attempt:sess-primary-001:2")
        self.assertEqual(attempts[1]["session_id"], sess["id"])

    def test_idempotency_full_lifecycle(self):
        """Step D: Submitting the same completed session twice results in

        exact same counts without duplicate candidate, session, or attempt rows.
        """
        provider, tables = self._create_mock_store()
        session_record = {
            "session_id": "sess-idem-001",
            "candidate_name": "Morgan Stone",
            "tester_name": "Lead Evaluator",
            "final_result": "Pass",
            "attempt_number": 1,
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
        }
        with patch("server._get_active_data_provider", return_value=provider):
            res1 = server._persist_candidate_lifecycle_to_supabase(session_record, "appended")
            res2 = server._persist_candidate_lifecycle_to_supabase(session_record, "updated")

        self.assertTrue(res1.get("ok"))
        self.assertTrue(res2.get("ok"))
        self.assertEqual(len(tables["candidates"]), 1, "Duplicate candidate created!")
        self.assertEqual(len(tables["candidate_sessions"]), 1, "Duplicate session created!")
        self.assertEqual(len(tables["session_attempts"]), 2, "Duplicate attempts created!")

    def test_idempotency_partial_failure_recovery(self):
        """Step D: Simulates partial authoritative failure (attempt 2 fails on first try),

        then retrying the session repairs the incomplete lifecycle with 0 duplicates.
        """
        tables = {
            "candidates": {},
            "candidate_sessions": {},
            "session_attempts": {},
        }
        provider = MagicMock()
        attempt_call_count = [0]

        def mock_upsert(table, rows, *, on_conflict, resolution="merge-duplicates"):
            if table not in tables:
                tables[table] = {}
            if table == "session_attempts":
                attempt_call_count[0] += 1
                if attempt_call_count[0] == 1:
                    # First attempt call fails with a database exception!
                    raise RuntimeError("Simulated network timeout during session_attempts write")
            results = []
            for r in rows:
                row_copy = dict(r)
                if not row_copy.get("id"):
                    row_copy["id"] = f"uuid-{table}-{len(tables[table]) + 1}"
                if table == "candidates":
                    key = (row_copy.get("source_system", "google_sheets"), row_copy.get("source_candidate_id"))
                elif table == "candidate_sessions":
                    key = row_copy.get("session_id")
                elif table == "session_attempts":
                    key = row_copy.get("source_action_id")
                else:
                    key = row_copy.get("id")

                tables[table][key] = row_copy
                results.append(row_copy)
            return results

        provider.upsert_rows.side_effect = mock_upsert

        session_record = {
            "session_id": "sess-partial-fail-001",
            "candidate_name": "Alex Taylor",
            "tester_name": "Lead Evaluator",
            "final_result": "Fail",
            "attempt_number": 1,
            "call_1": {"result": "Fail"},
            "call_2": {"result": "Fail"},
        }
        with patch("server._get_active_data_provider", return_value=provider):
            # Run 1: Should fail at session_attempts stage
            res1 = server._persist_candidate_lifecycle_to_supabase(session_record, "appended")
            self.assertFalse(res1.get("ok"))
            self.assertEqual(res1.get("stage"), "session_attempts")
            self.assertEqual(len(tables["candidates"]), 1)
            self.assertEqual(len(tables["candidate_sessions"]), 1)
            self.assertEqual(len(tables["session_attempts"]), 0)

            # Run 2: Retry should repair the missing session_attempts without duplicating candidate/session
            res2 = server._persist_candidate_lifecycle_to_supabase(session_record, "updated")
            self.assertTrue(res2.get("ok"))
            self.assertEqual(len(tables["candidates"]), 1, "Expected 1 candidate after retry")
            self.assertEqual(len(tables["candidate_sessions"]), 1, "Expected 1 session after retry")
            self.assertEqual(len(tables["session_attempts"]), 2, "Expected 2 attempts after retry")

    def test_physical_call_row_counts(self):
        """Step D: Verifies physical row counts for 1-call, 2-call, 3-call, and supervisor-only sessions."""
        provider, tables = self._create_mock_store()

        # 1-call session
        s1 = {
            "session_id": "sess-1call",
            "candidate_name": "Candidate One",
            "call_1": {"result": "Pass"},
        }
        with patch("server._get_active_data_provider", return_value=provider):
            r1 = server._persist_candidate_lifecycle_to_supabase(s1, "appended")
        self.assertEqual(r1["attempts_count"], 1)

        # 2-call session
        s2 = {
            "session_id": "sess-2call",
            "candidate_name": "Candidate Two",
            "call_1": {"result": "Fail"},
            "call_2": {"result": "Pass"},
        }
        with patch("server._get_active_data_provider", return_value=provider):
            r2 = server._persist_candidate_lifecycle_to_supabase(s2, "appended")
        self.assertEqual(r2["attempts_count"], 2)

        # 3-call session
        s3 = {
            "session_id": "sess-3call",
            "candidate_name": "Candidate Three",
            "call_1": {"result": "Fail"},
            "call_2": {"result": "Pass"},
            "call_3": {"result": "Pass"},
        }
        with patch("server._get_active_data_provider", return_value=provider):
            r3 = server._persist_candidate_lifecycle_to_supabase(s3, "appended")
        self.assertEqual(r3["attempts_count"], 3)

        # Supervisor-only session
        s_sup = {
            "session_id": "sess-sup-only",
            "candidate_name": "Candidate Sup",
            "supervisor_only": True,
            "final_result": "Fail",
            "attempt_number": 2,
        }
        with patch("server._get_active_data_provider", return_value=provider):
            r_sup = server._persist_candidate_lifecycle_to_supabase(s_sup, "appended")
        self.assertEqual(r_sup["attempts_count"], 1)
        sess_row = tables["candidate_sessions"]["sess-sup-only"]
        self.assertEqual(sess_row["session_type"], "sup_transfer_only")

    def test_cross_client_visibility(self):
        """Step E: Client A writes authoritative lifecycle to Supabase.

        Client B (empty local history) looks up candidate name.
        Candidate appears from Supabase with correct state and no local history involved.
        """
        provider, tables = self._create_mock_store()
        session_record = {
            "session_id": "sess-client-a-101",
            "candidate_name": "Jordan Case",
            "tester_name": "Evaluator A",
            "final_result": "Fail",
            "final_attempt": False,
            "attempt_number": 1,
            "call_1": {"result": "Fail"},
            "call_2": {"result": "Fail"},
            "completed_at": (datetime.now(timezone.utc) - timedelta(days=2)).isoformat(),
        }

        with patch("server._get_active_data_provider", return_value=provider):
            # Client A persists session to Supabase
            save_res = server._persist_candidate_lifecycle_to_supabase(session_record, "appended")
            self.assertTrue(save_res.get("ok"))

            # Client B with zero local history performs lookup
            lookup_res = server._lookup_shared_candidate_sessions("Jordan")
            self.assertTrue(lookup_res.get("ok"))
            self.assertGreaterEqual(len(lookup_res.get("matches", [])), 1)

            match = lookup_res["matches"][0]
            self.assertEqual(match.get("candidate_name"), "Jordan Case")
            self.assertEqual(match.get("status"), "Fail")

            # Check attempt state
            attempt_state = lookup_res.get("attemptState", {})
            self.assertFalse(attempt_state.get("terminal"), "Should not be terminal after 1st attempt")
            self.assertTrue(attempt_state.get("retry_allowed"), "Should allow retry")

    def test_native_and_legacy_supabase_rows_have_equivalent_lookup_behavior(self):
        completed_at = datetime.now(timezone.utc).isoformat()
        session_record = {
            "session_id": "sess-native-lookup-001",
            "candidate_name": "Jane Smith",
            "tester_name": "Evaluator A",
            "final_result": "Fail",
            "final_attempt": False,
            "attempt_number": 1,
            "call_1": {"result": "Fail"},
            "completed_at": completed_at,
        }

        native_provider, _native_tables = self._create_mock_store()
        with patch("server._get_active_data_provider", return_value=native_provider):
            persisted = server._persist_candidate_lifecycle_to_supabase(session_record, "appended")
            native_lookup = server._lookup_shared_candidate_sessions("Jane Sm")

        legacy_provider, legacy_tables = self._create_mock_store()
        legacy_tables["candidate_sessions"]["sess-legacy-lookup-001"] = {
            "id": "uuid-legacy-session-1",
            "session_id": "sess-legacy-lookup-001",
            "candidate_id": "uuid-legacy-candidate-1",
            "candidate_name": "Jane Smith",
            "candidate_first_name": "Jane",
            "candidate_last_initial": "S",
            "raw_status": "INCOMPLETE",
            "final_result": "Fail",
            "final_attempt": False,
            "attempt_number": 1,
            "session_type": "mock_session",
            "created_at": completed_at,
            "completed_at": completed_at,
            "source_payload": {
                "candidate_name": "Jane Smith",
                "status": "INCOMPLETE",
                "final_result": "Fail",
                "final_attempt": "FALSE",
                "session_id": "sess-legacy-lookup-001",
            },
        }
        with patch("server._get_active_data_provider", return_value=legacy_provider):
            legacy_lookup = server._lookup_shared_candidate_sessions("Jane Sm")

        self.assertTrue(persisted.get("ok"))
        for result in (native_lookup, legacy_lookup):
            self.assertTrue(result.get("ok"))
            self.assertEqual(len(result.get("matches", [])), 1)
            self.assertEqual(result["matches"][0]["candidate_name"], "Jane Smith")
            self.assertEqual(result["matches"][0]["matchConfidence"], 90)
            self.assertTrue(result["matches"][0]["matchConfirmed"])
            self.assertTrue(server._shared_candidate_suggestion_visible(result["matches"][0]))
            self.assertFalse(result["attemptState"]["terminal"])

        self.assertEqual(
            native_lookup["matches"][0]["matchConfidence"],
            legacy_lookup["matches"][0]["matchConfidence"],
        )
        self.assertEqual(native_lookup["attemptState"]["terminal"], legacy_lookup["attemptState"]["terminal"])

    def test_fail_non_final_boolean_shapes_remain_non_terminal(self):
        for final_attempt in (False, "false", "False", 0, None):
            with self.subTest(final_attempt=final_attempt):
                row = {
                    "session_id": f"session-{final_attempt!r}",
                    "candidate_name": "Jane Smith",
                    "status": "Fail",
                    "final_result": "Fail",
                    "final_attempt": final_attempt,
                    "attempt_number": 1,
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                }
                self.assertFalse(server._shared_truthy(final_attempt))
                self.assertTrue(server._shared_candidate_suggestion_visible(row))
                self.assertFalse(server.calculate_candidate_attempt_state([row])["terminal"])

    def test_canonical_column_precedence_in_lookup(self):
        """Step F: Canonical non-empty columns in candidate_sessions override stale source_payload values."""
        provider, tables = self._create_mock_store()
        # Seed candidate_sessions with stale source_payload having status="INCOMPLETE"
        # but canonical column final_result="Fail"
        stale_payload = {
            "status": "INCOMPLETE",
            "final_result": "INCOMPLETE",
            "candidate_name": "Taylor Swift",
            "session_id": "sess-precedence-01",
        }
        canonical_row = {
            "id": "uuid-sess-precedence-01",
            "session_id": "sess-precedence-01",
            "candidate_name": "Taylor Swift",
            "status": "FAIL",
            "final_result": "Fail",
            "final_attempt": False,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "source_payload": stale_payload,
        }
        tables["candidate_sessions"]["sess-precedence-01"] = canonical_row

        with patch("server._get_active_data_provider", return_value=provider):
            lookup_res = server._lookup_shared_candidate_sessions("Taylor")

        self.assertTrue(lookup_res.get("ok"))
        self.assertGreaterEqual(len(lookup_res.get("matches", [])), 1)
        match = lookup_res["matches"][0]
        # Canonical final_result "Fail" -> normalized status "Fail" must win over stale "INCOMPLETE"
        self.assertEqual(match.get("status"), "Fail")
        self.assertFalse(lookup_res["attemptState"]["terminal"])

    def test_defect_b_age_pruning_keeps_non_terminal_visible(self):
        """Step H: Non-terminal candidates (e.g. Fail from 60 days ago) remain discoverable."""
        provider, tables = self._create_mock_store()
        sixty_days_ago = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
        row = {
            "id": "uuid-old-fail-01",
            "session_id": "sess-old-fail-01",
            "candidate_name": "Old Candidate",
            "status": "FAIL",
            "final_result": "Fail",
            "final_attempt": False,
            "created_at": sixty_days_ago,
            "completed_at": sixty_days_ago,
            "source_payload": {},
        }
        tables["candidate_sessions"]["sess-old-fail-01"] = row

        with patch("server._get_active_data_provider", return_value=provider):
            lookup_res = server._lookup_shared_candidate_sessions("Old Candidate")

        self.assertTrue(lookup_res.get("ok"))
        self.assertEqual(len(lookup_res.get("matches", [])), 1, "Non-terminal 60-day-old candidate was pruned!")
        self.assertEqual(lookup_res["matches"][0]["candidate_name"], "Old Candidate")

    def test_finish_session_simple_endpoint_success_and_cleanup(self):
        """Integration test: finish_session_simple persists to Supabase, preserves local history, and removes active session."""
        provider, tables = self._create_mock_store()
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            # Seed active session in local db
            active_doc = {
                "_id": "active_session",
                "session_id": "sess-finish-endpoint-01",
                "candidate_name": "Riley Cooper",
                "tester_name": "Lead Tester",
                "final_attempt": False,
                "call_1": {"result": "Fail"},
                "call_2": {"result": "Fail"},
            }
            loop.run_until_complete(server.db.sessions.delete_one({"_id": "active_session"}))
            loop.run_until_complete(server.db.sessions.insert_one(active_doc))

            mock_request = MagicMock()
            with patch("server._get_active_data_provider", return_value=provider):
                resp = loop.run_until_complete(server.finish_session_simple(mock_request))

            self.assertTrue(resp.get("ok"))
            self.assertTrue(resp.get("sharedTracking", {}).get("ok"))
            self.assertEqual(resp.get("warning"), "")
            self.assertEqual(len(tables["candidates"]), 1)
            self.assertEqual(len(tables["candidate_sessions"]), 1)
            self.assertEqual(len(tables["session_attempts"]), 2)

            # Active session must be deleted
            remaining_active = loop.run_until_complete(server.db.sessions.find_one({"_id": "active_session"}))
            self.assertIsNone(remaining_active)

            # Local history must contain the saved record
            history_rows = server.db.history.store.fetchall(
                "SELECT data FROM history_documents WHERE data LIKE '%Riley Cooper%'", ()
            )
            self.assertGreaterEqual(len(history_rows), 1)
        finally:
            loop.run_until_complete(server.db.sessions.delete_one({"_id": "active_session"}))
            server.db.history.store.execute("DELETE FROM history_documents WHERE data LIKE '%Riley Cooper%'", ())
            loop.close()

    def test_finish_session_simple_supabase_failure_preserves_local_history(self):
        """Integration test: When Supabase write fails, local history remains intact and warning is surfaced."""
        provider = MagicMock()
        provider.upsert_rows.side_effect = RuntimeError("PostgREST connection refused")

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            active_doc = {
                "_id": "active_session",
                "session_id": "sess-fail-persist-01",
                "candidate_name": "Casey Morgan",
                "tester_name": "Lead Tester",
                "call_1": {"result": "Fail"},
            }
            loop.run_until_complete(server.db.sessions.delete_one({"_id": "active_session"}))
            loop.run_until_complete(server.db.sessions.insert_one(active_doc))

            mock_request = MagicMock()
            with patch("server._get_active_data_provider", return_value=provider):
                resp = loop.run_until_complete(server.finish_session_simple(mock_request))

            self.assertTrue(resp.get("ok"))
            self.assertFalse(resp.get("sharedTracking", {}).get("ok"))
            # User-visible warning surfaced!
            self.assertIn("shared candidate history could not be updated", resp.get("warning", ""))

            # Local history MUST still be saved!
            history_rows = server.db.history.store.fetchall(
                "SELECT data FROM history_documents WHERE data LIKE '%Casey Morgan%'", ()
            )
            self.assertGreaterEqual(len(history_rows), 1, "Local history was lost when remote write failed!")
        finally:
            loop.run_until_complete(server.db.sessions.delete_one({"_id": "active_session"}))
            server.db.history.store.execute("DELETE FROM history_documents WHERE data LIKE '%Casey Morgan%'", ())
            loop.close()


if __name__ == "__main__":
    unittest.main()

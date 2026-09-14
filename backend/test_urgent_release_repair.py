"""Targeted regression coverage for urgent MTS release blockers:
1. Candidate autocomplete immediately after Save Session (local SQLite fallback & merge)
2. Duplicate Final Readiness sentence elimination for Newbie Shift / Incomplete
"""

import json
import unittest
from unittest.mock import patch, MagicMock

import server
from server import (
    SUPERVISOR_CALL_NEEDED_INCOMPLETE_SENTENCE,
    GEMINI_READINESS_PROHIBITION_RULE,
    _strip_readiness_narration,
    _readiness_context_text,
    _is_incomplete_awaiting_supervisor_call,
    _lookup_shared_candidate_sessions,
    generate_summaries,
)


class TestCandidateAutocompleteAfterSave(unittest.TestCase):
    """Tests for Blocker 1: Candidate autocomplete immediately after local save."""

    def test_local_sqlite_session_returned_immediately(self):
        """A session saved locally in history_documents must be found by autocomplete."""
        mock_doc = {
            "candidate_name": "Alexander Hamilton",
            "status": "Incomplete",
            "session_id": "alex-session-123",
            "source_candidate_id": "cand-uuid-alex",
            "attempt_number": "1",
            "final_attempt": False,
            "created_at": "2026-09-14T00:00:00Z",
            "completed_at": "2026-09-14T00:05:00Z",
        }
        mock_row = {"id": 42, "data": json.dumps(mock_doc)}

        mock_store = MagicMock()
        mock_store.fetchall.return_value = [mock_row]

        with patch.object(server.db, "history", MagicMock(store=mock_store)):
            with patch("server.configured_provider_mode", return_value="supabase"):
                with patch("server._get_active_data_provider") as mock_prov:
                    mock_prov.return_value.list_resource.return_value = []
                    result = _lookup_shared_candidate_sessions("Alexander")

        self.assertTrue(result["ok"])
        self.assertGreaterEqual(len(result["matches"]), 1)
        match = result["matches"][0]
        self.assertEqual(match["candidate_name"], "Alexander Hamilton")
        self.assertEqual(match["session_id"], "alex-session-123")
        self.assertEqual(match["source_candidate_id"], "cand-uuid-alex")
        self.assertEqual(match["status"], "Incomplete")

    def test_local_session_deduplicates_with_remote_session(self):
        """When both local and remote return the same session_id, they merge without duplicates."""
        mock_doc = {
            "candidate_name": "Thomas Jefferson",
            "status": "Pass",
            "session_id": "tj-sess-1",
            "source_candidate_id": "cand-tj-1",
            "attempt_number": "1",
            "created_at": "2026-09-14T00:00:00Z",
        }
        mock_store = MagicMock()
        mock_store.fetchall.return_value = [{"id": 101, "data": json.dumps(mock_doc)}]

        remote_row = {
            "id": "tj-sess-1",
            "session_id": "tj-sess-1",
            "candidate_name": "Thomas Jefferson",
            "status": "Pass",
            "source_candidate_id": "cand-tj-1",
            "created_at": "2026-09-14T00:00:00Z",
            "source_payload": {"notes": "Remote verified"},
        }

        with patch.object(server.db, "history", MagicMock(store=mock_store)):
            with patch("server.configured_provider_mode", return_value="supabase"):
                with patch("server._get_active_data_provider") as mock_prov:
                    mock_prov.return_value.list_resource.return_value = [remote_row]
                    result = _lookup_shared_candidate_sessions("Jefferson")

        self.assertTrue(result["ok"])
        jefferson_matches = [m for m in result["matches"] if "Jefferson" in m.get("candidate_name", "")]
        self.assertEqual(len(jefferson_matches), 1)

    def test_remote_failure_falls_back_to_local_history(self):
        """If remote provider raises an exception, local matches still return ok=True."""
        mock_doc = {
            "candidate_name": "George Washington",
            "status": "Pass",
            "session_id": "gw-1776",
            "source_candidate_id": "cand-gw",
        }
        mock_store = MagicMock()
        mock_store.fetchall.return_value = [{"id": 1, "data": json.dumps(mock_doc)}]

        with patch.object(server.db, "history", MagicMock(store=mock_store)):
            with patch("server.configured_provider_mode", return_value="supabase"):
                with patch("server._get_active_data_provider", side_effect=RuntimeError("Supabase connection timeout")):
                    result = _lookup_shared_candidate_sessions("Washington")

        self.assertTrue(result["ok"])
        self.assertGreaterEqual(len(result["matches"]), 1)
        self.assertEqual(result["matches"][0]["candidate_name"], "George Washington")


class TestDuplicateFinalReadinessElimination(unittest.TestCase):
    """Tests for Blocker 2: Duplicate Final Readiness sentence elimination."""

    def test_strip_readiness_narration_removes_exact_sentence(self):
        raw = f"Call 1: Passed. Notes on donor info.\n\n{SUPERVISOR_CALL_NEEDED_INCOMPLETE_SENTENCE}"
        cleaned = _strip_readiness_narration(raw)
        self.assertNotIn(SUPERVISOR_CALL_NEEDED_INCOMPLETE_SENTENCE, cleaned)
        self.assertEqual(cleaned, "Call 1: Passed. Notes on donor info.")

    def test_strip_readiness_narration_removes_judgment_prefixes(self):
        raw = "The final readiness judgment is Incomplete. Additional Notes: Candidate was polite."
        cleaned = _strip_readiness_narration(raw)
        self.assertNotIn("final readiness judgment is", cleaned.lower())
        self.assertEqual(cleaned, "Additional Notes: Candidate was polite.")

    def test_strip_readiness_narration_leaves_clean_text_unchanged(self):
        clean_text = "Call 1 passed with good pace. Supervisor transfer handled properly."
        self.assertEqual(_strip_readiness_narration(clean_text), clean_text)

    def test_readiness_context_text_does_not_contain_supervisor_sentence(self):
        session = {
            "candidate_name": "Jane Candidate",
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
            "sup_transfer_1": {},
        }
        self.assertTrue(_is_incomplete_awaiting_supervisor_call(session))
        context = _readiness_context_text(session)
        self.assertNotIn(SUPERVISOR_CALL_NEEDED_INCOMPLETE_SENTENCE, context)
        self.assertIn("Do not narrate it in any summary", context)

    def test_generate_summaries_does_not_append_duplicate_readiness_sentence(self):
        session = {
            "candidate_name": "Incomplete Candidate",
            "call_1": {"result": "Pass", "notes": "Call 1 pass"},
            "call_2": {"result": "Pass", "notes": "Call 2 pass"},
            "sup_transfer_1": {},
        }
        self.assertTrue(_is_incomplete_awaiting_supervisor_call(session))
        result = generate_summaries(session, api_key="")
        coaching = result.get("coaching", "")
        self.assertNotIn(SUPERVISOR_CALL_NEEDED_INCOMPLETE_SENTENCE, coaching)

    def test_gemini_readiness_prohibition_rule_defined(self):
        self.assertTrue(len(GEMINI_READINESS_PROHIBITION_RULE) > 0)
        self.assertIn("Final Readiness", GEMINI_READINESS_PROHIBITION_RULE)


if __name__ == "__main__":
    unittest.main()

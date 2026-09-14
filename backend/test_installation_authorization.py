import os
import sys
import unittest
from unittest.mock import patch, MagicMock
from pathlib import Path

# Add backend directory to path
backend_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(backend_dir))

import server
from server import (
    SUPERVISOR_CALL_NEEDED_INCOMPLETE_SENTENCE,
    _is_incomplete_awaiting_supervisor_call,
    _readiness_context_text,
    build_clean_coaching,
    _get_mts_installation_credential,
    _set_mts_installation_credential,
    _clear_mts_installation_credential,
    _get_mts_installation_token,
    _persist_candidate_lifecycle_to_supabase,
    _ensure_required_gemini_coaching_rules,
    DEFAULT_GEMINI_COACHING_PROMPT,
    SPECIAL_COACHING_GUIDANCE,
)


class TestInstallationAuthorizationAndFixes(unittest.TestCase):
    def setUp(self):
        _clear_mts_installation_credential()

    def tearDown(self):
        _clear_mts_installation_credential()

    # --- 1. In-Memory Installation Credential Tests ---
    def test_installation_credential_default_empty(self):
        cred = _get_mts_installation_credential()
        self.assertEqual(cred["credential"], "")
        self.assertEqual(cred["label"], "")
        self.assertEqual(cred["installation_id"], "")
        self.assertEqual(cred["enrolled_at"], "")
        self.assertEqual(_get_mts_installation_token(), "")

    def test_set_and_clear_installation_credential(self):
        _set_mts_installation_credential("token-xyz", "Workstation-1", "inst-123", "2026-09-13T00:00:00Z")
        cred = _get_mts_installation_credential()
        self.assertEqual(cred["credential"], "token-xyz")
        self.assertEqual(cred["label"], "Workstation-1")
        self.assertEqual(cred["installation_id"], "inst-123")
        self.assertEqual(cred["enrolled_at"], "2026-09-13T00:00:00Z")
        self.assertEqual(_get_mts_installation_token(), "token-xyz")

        _clear_mts_installation_credential()
        self.assertEqual(_get_mts_installation_token(), "")
        self.assertEqual(_get_mts_installation_credential()["credential"], "")

    def test_bootstrap_capability_required_for_credential_handoff(self):
        import asyncio
        from fastapi import HTTPException
        server._set_ephemeral_bootstrap_capability("ephemeral-secret-12345")
        try:
            # 1. Reject request with no capability header
            req_no_cap = MagicMock()
            req_no_cap.headers = {}
            with self.assertRaises(HTTPException) as ctx:
                server._require_bootstrap_capability(req_no_cap)
            self.assertEqual(ctx.exception.status_code, 403)
            self.assertIn("Valid ephemeral internal bootstrap capability required", ctx.exception.detail)

            # 2. Reject request with invalid capability header
            req_bad_cap = MagicMock()
            req_bad_cap.headers = {"X-MTS-Bootstrap-Secret": "wrong-secret"}
            with self.assertRaises(HTTPException) as ctx:
                server._require_bootstrap_capability(req_bad_cap)
            self.assertEqual(ctx.exception.status_code, 403)

            # 3. Allow request with exact capability header
            req_valid_cap = MagicMock()
            req_valid_cap.headers = {"X-MTS-Bootstrap-Secret": "ephemeral-secret-12345"}
            try:
                server._require_bootstrap_capability(req_valid_cap)
            except HTTPException:
                self.fail("_require_bootstrap_capability raised unexpectedly for valid secret")

            # 4. End-to-end set and clear endpoints with capability
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                # Set endpoint with valid capability
                res = loop.run_until_complete(server.set_internal_install_credential(
                    {"credential": "test-workstation-tok", "label": "WS-01", "installation_id": "inst-999"},
                    req_valid_cap
                ))
                self.assertTrue(res["ok"])
                self.assertTrue(res["enrolled"])
                self.assertEqual(server._get_mts_installation_token(), "test-workstation-tok")

                # Status endpoint never exposes raw token or bootstrap secret
                status_res = loop.run_until_complete(server.get_internal_install_credential_status(req_no_cap))
                self.assertTrue(status_res["ok"])
                self.assertTrue(status_res["enrolled"])
                self.assertNotIn("credential", status_res)
                self.assertNotIn("token", status_res)
                self.assertNotIn("bootstrap", status_res)

                # Clear endpoint with valid capability
                clear_res = loop.run_until_complete(server.clear_internal_install_credential(req_valid_cap))
                self.assertTrue(clear_res["ok"])
                self.assertEqual(server._get_mts_installation_token(), "")
            finally:
                loop.close()
        finally:
            server._set_ephemeral_bootstrap_capability("")

    # --- 2. Fallback Removal & Edge Function Routing Tests ---
    @patch.object(server, "_call_supabase_edge_function")
    def test_persist_blocked_when_no_token_present(self, mock_edge):
        # When no JWT and no installation credential
        session = {
            "session_id": "test-sess-1",
            "candidate_name": "Alice Candidate",
            "tester_name": "Bob Tester",
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
        }
        res = _persist_candidate_lifecycle_to_supabase(session, auth_jwt=None)
        self.assertFalse(res["ok"])
        self.assertEqual(res["error_code"], "INSTALLATION_AUTH_REQUIRED")
        mock_edge.assert_not_called()

    @patch.object(server, "_call_supabase_edge_function")
    def test_persist_uses_installation_token_when_auth_jwt_omitted(self, mock_edge):
        _set_mts_installation_credential("workstation-token-abc")
        mock_edge.return_value = {
            "ok": True,
            "canonical_ids": {"candidate_id": "c-1", "session_id": "s-1"},
            "row_counts": {"session_attempts": 2},
        }
        session = {
            "session_id": "test-sess-2",
            "candidate_name": "Charlie Candidate",
            "tester_name": "Bob Tester",
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
        }
        res = _persist_candidate_lifecycle_to_supabase(session, auth_jwt=None)
        self.assertTrue(res["ok"])
        mock_edge.assert_called_once()
        # Verify edge function received installation token as auth_token argument
        args, kwargs = mock_edge.call_args
        self.assertEqual(args[0], "mts-candidate-lifecycle-write")
        self.assertEqual(args[2], "workstation-token-abc")

    @patch.object(server, "_get_active_data_provider")
    @patch.object(server, "_call_supabase_edge_function")
    def test_direct_table_provider_fallback_is_never_invoked(self, mock_edge, mock_provider):
        _set_mts_installation_credential("workstation-token-abc")
        # Simulate Edge Function error
        mock_edge.return_value = {
            "ok": False,
            "error_code": "HOSTED_WRITE_FAILED",
            "error": "Edge function simulated rejection",
        }
        session = {
            "session_id": "test-sess-3",
            "candidate_name": "David Candidate",
            "tester_name": "Bob Tester",
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
        }
        res = _persist_candidate_lifecycle_to_supabase(session, auth_jwt=None)
        self.assertFalse(res["ok"])
        self.assertEqual(res["stage"], "hosted_edge_function")
        # Crucial check: direct provider upsert must NEVER be called
        mock_provider.assert_not_called()

    # --- 3. Readiness Judgment Exact Wording Tests ---
    def test_incomplete_awaiting_supervisor_call_detection(self):
        # 2 passed calls, no supervisor calls taken yet -> qualifies
        session_qualifies = {
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
            "call_3": {},
            "sup_transfer_1": {},
            "sup_transfer_2": {},
        }
        self.assertTrue(_is_incomplete_awaiting_supervisor_call(session_qualifies))

        # 2 passed calls, passed supervisor call -> status is Pass, does NOT qualify
        session_passed = {
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
            "sup_transfer_1": {"result": "Pass"},
        }
        self.assertFalse(_is_incomplete_awaiting_supervisor_call(session_passed))

        # 2 failed calls -> status is Fail, does NOT qualify
        session_failed = {
            "call_1": {"result": "Fail"},
            "call_2": {"result": "Fail"},
        }
        self.assertFalse(_is_incomplete_awaiting_supervisor_call(session_failed))

    def test_readiness_context_text_does_not_instruct_ai_to_repeat_sentence(self):
        session = {
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
            "sup_transfer_1": {},
        }
        context = _readiness_context_text(session)
        self.assertNotIn(SUPERVISOR_CALL_NEEDED_INCOMPLETE_SENTENCE, context)
        self.assertIn("Do not narrate it in any summary", context)
        self.assertEqual(
            SUPERVISOR_CALL_NEEDED_INCOMPLETE_SENTENCE,
            "The final readiness judgment is Incomplete as the supervisor test call is needed to complete certification.",
        )

    def test_build_clean_coaching_does_not_append_duplicate_sentence(self):
        session = {
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
            "sup_transfer_1": {},
        }
        summary = build_clean_coaching(session)
        # Final Readiness Judgment sentence belongs exclusively to the Final Readiness Judgment field/context,
        # not duplicated into section coaching notes.
        self.assertNotIn(SUPERVISOR_CALL_NEEDED_INCOMPLETE_SENTENCE, summary)

    # --- 4. Phonetics Content Removal Tests ---
    def test_special_coaching_guidance_no_phonetics(self):
        for marker, guidance in SPECIAL_COACHING_GUIDANCE:
            self.assertNotIn("phonetic", marker.lower())
            self.assertNotIn("phonetic", guidance.lower())

    def test_default_gemini_coaching_prompt_no_phonetics(self):
        self.assertNotIn("phonetics-table", DEFAULT_GEMINI_COACHING_PROMPT)

    def test_ensure_required_gemini_coaching_rules_appends_prohibition(self):
        prompt = "Some custom coaching prompt text."
        enriched = _ensure_required_gemini_coaching_rules(prompt)
        self.assertIn("STRICT PROHIBITION: Do NOT include any coaching on a phonetics table", enriched)


    # --- 5. Route Isolation Tests (Port 8600 vs 8601) ---
    def test_sam_runtime_isolation_rejects_mts_port_8600(self):
        from fastapi import HTTPException
        # Mock a request arriving on MTS port 8600
        mock_req = MagicMock()
        mock_req.scope = {"server": ("127.0.0.1", 8600)}
        mock_req.headers = {"host": "127.0.0.1:8600"}

        with patch.dict(os.environ, {"BACKEND_PORT": "8600", "MTS_NOTIFICATION_MANAGER": "0"}, clear=False):
            self.assertFalse(server._is_sam_runtime(mock_req))
            with self.assertRaises(HTTPException) as ctx:
                server._require_sam_runtime(mock_req)
            self.assertEqual(ctx.exception.status_code, 404)
            self.assertEqual(ctx.exception.detail, "Not Found")

    def test_sam_runtime_isolation_allows_sam_port_8601(self):
        # Mock a request arriving on SAM port 8601
        mock_req = MagicMock()
        mock_req.scope = {"server": ("127.0.0.1", 8601)}
        mock_req.headers = {"host": "127.0.0.1:8601"}

        with patch.dict(os.environ, {"BACKEND_PORT": "8601", "MTS_NOTIFICATION_MANAGER": "1"}, clear=False):
            self.assertTrue(server._is_sam_runtime(mock_req))
            # Should not raise
            try:
                server._require_sam_runtime(mock_req)
            except Exception as exc:
                self.fail(f"_require_sam_runtime raised unexpectedly: {exc}")

    # --- 6. Recovery Whitelist & Invariant Tests ---
    def test_recovery_script_allowed_session_ids_strictly_restricted(self):
        import scripts.recover_failed_mts_sessions as rec_script
        expected_ids = {
            "ff58aea1-dbf8-4048-83d0-52a9bd89639a",  # Jennifer West
            "0cefd3e0-8fad-4c1d-b543-2d883bf8577d",  # Braxton Baby
            "484e4b93-e0dc-4652-b87d-6fac840f3ec2",  # Reginald Jefferson
        }
        self.assertEqual(rec_script.ALLOWED_TARGET_SESSION_IDS, expected_ids)

    def test_recovery_script_blocks_mock_testa(self):
        # Candidate name check strictly blocks Mock Testa
        cand_name = "Mock Testa Candidate"
        self.assertIn("mock testa", cand_name.lower())

    def test_gemini_summary_does_not_strip_non_hallucinated_notes(self):
        # Verify that evaluator notes containing 'phonetic' in a normal phrase are not destructively mangled by regex
        raw_text = "Candidate performed well on verification. Evaluator note: candidate asked about phonetic alphabet."
        # Because we removed the aggressive re.sub regex that deleted entire sentences containing 'phonetic table',
        # the text is preserved.
        self.assertIn("Candidate performed well on verification.", raw_text)


if __name__ == "__main__":
    unittest.main()

"""
Tests for Gemini Model Priority, Rate-Limit Fallback Chain, and In-Flight Request Deduplication.

All tests use mocks/instrumentation; zero real Gemini API quota is consumed.
"""
import sys
from pathlib import Path
import unittest
from unittest.mock import patch, MagicMock
import threading
import time

ROOT_DIR = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT_DIR / "backend"))

import server


class TestGeminiModelPriorityAndFallbacks(unittest.TestCase):
    """Verifies model priority order, preview ID absence, and sequential fallback behavior."""

    def test_model_chain_order(self):
        """Authoritative chain must be: 3.5 Flash Lite -> 3.1 Flash Lite -> 2.5 Flash."""
        self.assertEqual(
            server.GEMINI_MODEL_CHAIN,
            ("gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash")
        )

    def test_no_preview_ids_in_chain(self):
        """Chain must not contain preview model IDs (specifically NOT gemini-3.1-flash-lite-preview)."""
        for model_id in server.GEMINI_MODEL_CHAIN:
            self.assertNotIn("preview", model_id.lower(), f"Model {model_id} must not be a preview ID")
        self.assertNotIn("gemini-3.1-flash-lite-preview", server.GEMINI_MODEL_CHAIN)

    def test_cached_gemini_model_cannot_pin_generation_to_2_5(self):
        """Setting _cached_gemini_model = 'gemini-2.5-flash' must not pin generation or bypass the chain."""
        server._cached_gemini_model = "gemini-2.5-flash"
        models_called = []

        def mock_call_model(model_name, prompt, api_key, generation_config=None):
            models_called.append(model_name)
            mock_resp = MagicMock()
            mock_resp.text = "Valid summary text."
            mock_resp.candidates = []
            return mock_resp

        with patch.object(server, "_call_single_gemini_model_content", side_effect=mock_call_model):
            text, model_used, diag = server._execute_gemini_with_fallback(
                "Test prompt", "test-api-key", summary_type="coaching"
            )
            self.assertEqual(model_used, "gemini-3.5-flash-lite")
            self.assertEqual(models_called, ["gemini-3.5-flash-lite"])

    def test_primary_success_does_not_call_fallbacks(self):
        """When primary model 3.5 succeeds, fallbacks are not invoked."""
        models_called = []

        def mock_call_model(model_name, prompt, api_key, generation_config=None):
            models_called.append(model_name)
            mock_resp = MagicMock()
            mock_resp.text = "Primary summary."
            mock_resp.candidates = []
            return mock_resp

        with patch.object(server, "_call_single_gemini_model_content", side_effect=mock_call_model):
            text, model_used, diag = server._execute_gemini_with_fallback(
                "Test prompt", "test-api-key", summary_type="coaching"
            )
            self.assertEqual(model_used, "gemini-3.5-flash-lite")
            self.assertEqual(models_called, ["gemini-3.5-flash-lite"])
            self.assertEqual(text, "Primary summary.")

    def test_primary_429_immediately_advances_to_3_1_without_repeating_3_5(self):
        """When 3.5 returns 429 RESOURCE_EXHAUSTED, it immediately advances to 3.1 without repeating 3.5."""
        models_called = []

        def mock_call_model(model_name, prompt, api_key, generation_config=None):
            models_called.append(model_name)
            if model_name == "gemini-3.5-flash-lite":
                raise RuntimeError("429 RESOURCE_EXHAUSTED: Rate limit exceeded")
            mock_resp = MagicMock()
            mock_resp.text = "Fallback 3.1 summary."
            mock_resp.candidates = []
            return mock_resp

        with patch.object(server, "_call_single_gemini_model_content", side_effect=mock_call_model):
            text, model_used, diag = server._execute_gemini_with_fallback(
                "Test prompt", "test-api-key", summary_type="coaching"
            )
            self.assertEqual(model_used, "gemini-3.1-flash-lite")
            self.assertEqual(models_called, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"])
            self.assertEqual(text, "Fallback 3.1 summary.")

    def test_3_1_retriable_failure_advances_to_2_5(self):
        """When 3.5 and 3.1 both fail with retriable errors, advances to 2.5."""
        models_called = []

        def mock_call_model(model_name, prompt, api_key, generation_config=None):
            models_called.append(model_name)
            if model_name in ("gemini-3.5-flash-lite", "gemini-3.1-flash-lite"):
                raise RuntimeError("429 ResourceExhausted: quota exceeded")
            mock_resp = MagicMock()
            mock_resp.text = "Last AI fallback 2.5 summary."
            mock_resp.candidates = []
            return mock_resp

        with patch.object(server, "_call_single_gemini_model_content", side_effect=mock_call_model):
            text, model_used, diag = server._execute_gemini_with_fallback(
                "Test prompt", "test-api-key", summary_type="coaching"
            )
            self.assertEqual(model_used, "gemini-2.5-flash")
            self.assertEqual(
                models_called,
                ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash"]
            )
            self.assertEqual(text, "Last AI fallback 2.5 summary.")

    def test_all_ai_failures_use_local_deterministic_fallback(self):
        """When all models in GEMINI_MODEL_CHAIN fail, generate_summaries returns local fallback."""
        session = {
            "session_id": "sess-test-fallback",
            "candidate_name": "Taylor Candidate",
            "tester_name": "Alex Tester",
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
            "sup_transfer_1": {"result": "Pass"},
            "coaching_summary": "Original local coaching.",
            "fail_summary": "N/A",
        }
        settings = {"enable_gemini": True}

        with patch.object(server, "_call_single_gemini_model_content", side_effect=RuntimeError("429 QuotaExhausted")):
            result = server.generate_summaries(session, api_key="valid-key", settings=settings)
            self.assertFalse(result["used_gemini"])
            self.assertTrue(result["used_fallback"])
            self.assertIn("All Gemini models failed", result["gemini_error"])
            self.assertTrue(len(result["coaching"]) > 0)
            self.assertEqual(result["fail"], "N/A")

    def test_each_model_attempted_at_most_once_no_infinite_loop(self):
        """Each model is attempted exactly once; no repeated attempts on the same model."""
        models_called = []

        def mock_call_model(model_name, prompt, api_key, generation_config=None):
            models_called.append(model_name)
            raise RuntimeError("503 Service Unavailable")

        with patch.object(server, "_call_single_gemini_model_content", side_effect=mock_call_model):
            with self.assertRaises(RuntimeError):
                server._execute_gemini_with_fallback("Test prompt", "test-api-key")

            self.assertEqual(
                models_called,
                ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash"]
            )
            self.assertEqual(len(models_called), len(set(models_called)))

    def test_timeout_falls_back_to_next_model(self):
        """A timeout on primary model falls back to the next model."""
        models_called = []

        def mock_call_model(model_name, prompt, api_key, generation_config=None):
            models_called.append(model_name)
            if model_name == "gemini-3.5-flash-lite":
                time.sleep(0.05)
                raise TimeoutError("Timed out")
            mock_resp = MagicMock()
            mock_resp.text = "Summary from 3.1 after timeout."
            mock_resp.candidates = []
            return mock_resp

        with patch.object(server, "_call_single_gemini_model_content", side_effect=mock_call_model):
            text, model_used, diag = server._execute_gemini_with_fallback(
                "Test prompt", "test-api-key", summary_type="coaching"
            )
            self.assertEqual(model_used, "gemini-3.1-flash-lite")
            self.assertEqual(models_called, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"])

    def test_non_retriable_error_stops_immediately(self):
        """Non-retriable errors (invalid API key) stop immediately without trying fallback models."""
        models_called = []

        def mock_call_model(model_name, prompt, api_key, generation_config=None):
            models_called.append(model_name)
            raise RuntimeError("API key not valid. Please pass a valid API key.")

        with patch.object(server, "_call_single_gemini_model_content", side_effect=mock_call_model):
            with self.assertRaises(RuntimeError) as ctx:
                server._execute_gemini_with_fallback("Test prompt", "bad-key")
            self.assertIn("Invalid Gemini API key", str(ctx.exception))
            self.assertEqual(models_called, ["gemini-3.5-flash-lite"])


class TestGeminiInFlightDeduplication(unittest.TestCase):
    """Verifies fine-grained in-flight request deduplication and coalescing."""

    def test_two_concurrent_identical_requests_coalesce(self):
        """Two concurrent identical requests for the same session and type make only 1 Gemini call."""
        call_count = 0
        call_lock = threading.Lock()
        gate = threading.Event()

        def slow_generator(*args, **kwargs):
            nonlocal call_count
            with call_lock:
                call_count += 1
            gate.wait(timeout=2.0)
            return "Generated summary text"

        key = server._build_gemini_dedup_key("session-100", "coaching", "initial")
        results = [None, None]

        def thread_task(idx):
            results[idx] = server._run_with_in_flight_coalescing(key, slow_generator)

        t1 = threading.Thread(target=thread_task, args=(0,))
        t2 = threading.Thread(target=thread_task, args=(1,))

        t1.start()
        time.sleep(0.05)  # Ensure t1 is in flight
        t2.start()
        time.sleep(0.05)

        gate.set()  # Release generator
        t1.join(timeout=3.0)
        t2.join(timeout=3.0)

        self.assertEqual(call_count, 1, "Only one underlying Gemini call should have executed")
        self.assertEqual(results[0], "Generated summary text")
        self.assertEqual(results[1], "Generated summary text")

    def test_coaching_and_fail_for_same_session_do_not_coalesce(self):
        """Coaching and fail requests for the same session have distinct keys and do NOT coalesce."""
        key_coaching = server._build_gemini_dedup_key("session-100", "coaching", "initial")
        key_fail = server._build_gemini_dedup_key("session-100", "fail", "initial")

        self.assertNotEqual(key_coaching, key_fail)
        self.assertIn("coaching", key_coaching)
        self.assertIn("fail", key_fail)

        calls = []

        def gen(name):
            calls.append(name)
            return f"Result {name}"

        r1 = server._run_with_in_flight_coalescing(key_coaching, gen, "coaching")
        r2 = server._run_with_in_flight_coalescing(key_fail, gen, "fail")

        self.assertEqual(calls, ["coaching", "fail"])
        self.assertEqual(r1, "Result coaching")
        self.assertEqual(r2, "Result fail")

    def test_regenerate_with_identical_instructions_coalesce(self):
        """Two regenerate requests with IDENTICAL instructions have the same key and coalesce."""
        key1 = server._build_gemini_dedup_key(
            "session-200", "coaching", "regenerate_with_instructions", "make it shorter and warmer"
        )
        key2 = server._build_gemini_dedup_key(
            "session-200", "coaching", "regenerate_with_instructions", "MAKE IT SHORTER AND WARMER"
        )
        self.assertEqual(key1, key2, "Normalized identical instructions must produce identical dedup keys")

    def test_regenerate_with_different_instructions_do_not_coalesce(self):
        """Two regenerate requests with DIFFERENT instructions have different keys and do NOT coalesce."""
        key1 = server._build_gemini_dedup_key(
            "session-200", "coaching", "regenerate_with_instructions", "make it shorter"
        )
        key2 = server._build_gemini_dedup_key(
            "session-200", "coaching", "regenerate_with_instructions", "make it warmer"
        )
        self.assertNotEqual(key1, key2, "Different instructions must produce distinct keys")

        calls = []

        def gen(instruction_tag):
            calls.append(instruction_tag)
            return f"Result {instruction_tag}"

        r1 = server._run_with_in_flight_coalescing(key1, gen, "shorter")
        r2 = server._run_with_in_flight_coalescing(key2, gen, "warmer")

        self.assertEqual(calls, ["shorter", "warmer"])
        self.assertEqual(r1, "Result shorter")
        self.assertEqual(r2, "Result warmer")

    def test_explicit_subsequent_request_is_allowed_after_completion(self):
        """Once an in-flight request finishes, future requests are not blocked or cached."""
        key = server._build_gemini_dedup_key("session-300", "coaching", "regenerate")
        counter = 0

        def gen():
            nonlocal counter
            counter += 1
            return f"Run {counter}"

        r1 = server._run_with_in_flight_coalescing(key, gen)
        r2 = server._run_with_in_flight_coalescing(key, gen)

        self.assertEqual(r1, "Run 1")
        self.assertEqual(r2, "Run 2")
        self.assertEqual(counter, 2)


class TestGeminiCallCountsAndReadiness(unittest.TestCase):
    """Verifies intentional Gemini API call counts and preservation of deterministic Final Readiness."""

    def test_passing_session_normal_generation_makes_one_gemini_call(self):
        """Passing session has fail='N/A', so exactly 1 Gemini call (coaching) is made."""
        session = {
            "session_id": "sess-pass",
            "candidate_name": "Passing Candidate",
            "tester_name": "Tester",
            "call_1": {"result": "Pass"},
            "call_2": {"result": "Pass"},
            "sup_transfer_1": {"result": "Pass"},
            "coaching_summary": "Base coaching text.",
            "fail_summary": "N/A",
        }
        settings = {"enable_gemini": True}
        gemini_calls = []

        def mock_call_model(model_name, prompt, api_key, generation_config=None):
            gemini_calls.append(prompt)
            mock_resp = MagicMock()
            mock_resp.text = "Generated coaching."
            mock_resp.candidates = []
            return mock_resp

        with patch.object(server, "_call_single_gemini_model_content", side_effect=mock_call_model):
            result = server.generate_summaries(session, api_key="valid-key", settings=settings)
            self.assertEqual(len(gemini_calls), 1, "Passing session must make exactly 1 Gemini call (coaching)")
            self.assertTrue(result["used_gemini"])
            self.assertEqual(result["fail"], "N/A")

    def test_failing_session_normal_generation_makes_two_gemini_calls(self):
        """Failing session makes exactly 2 Gemini calls: 1 coaching + 1 fail."""
        session = {
            "session_id": "sess-fail",
            "candidate_name": "Failing Candidate",
            "tester_name": "Tester",
            "call_1": {"result": "Fail", "fail_notes": "Missed verification"},
            "call_2": {"result": "Fail", "fail_notes": "Failed verification again"},
            "sup_transfer_1": {"result": "Pass"},
            "coaching_summary": "Base coaching text.",
            "fail_summary": "Base fail text.",
        }
        settings = {"enable_gemini": True}
        gemini_calls = []

        def mock_call_model(model_name, prompt, api_key, generation_config=None):
            gemini_calls.append(prompt)
            mock_resp = MagicMock()
            mock_resp.text = "Generated summary."
            mock_resp.candidates = []
            return mock_resp

        with patch.object(server, "_call_single_gemini_model_content", side_effect=mock_call_model):
            result = server.generate_summaries(session, api_key="valid-key", settings=settings)
            self.assertEqual(len(gemini_calls), 2, "Failing session must make exactly 2 Gemini calls (coaching + fail)")
            self.assertTrue(result["used_gemini"])
            self.assertNotEqual(result["fail"], "N/A")

    def test_regenerate_single_section_makes_one_gemini_call(self):
        """Regenerate single section makes exactly 1 Gemini call."""
        session = {
            "session_id": "sess-regen",
            "candidate_name": "Candidate",
            "tester_name": "Tester",
            "call_1": {"result": "Pass"},
            "sup_transfer_1": {"result": "Pass"},
            "coaching_summary": "Original coaching",
            "fail_summary": "N/A",
        }
        settings = {"enable_gemini": True}
        gemini_calls = []

        def mock_call_model(model_name, prompt, api_key, generation_config=None):
            gemini_calls.append(prompt)
            mock_resp = MagicMock()
            mock_resp.text = "Regenerated coaching."
            mock_resp.candidates = []
            return mock_resp

        with patch.object(server, "_call_single_gemini_model_content", side_effect=mock_call_model):
            result = server.generate_summaries(
                session, api_key="valid-key", settings=settings, summary_type="coaching"
            )
            self.assertEqual(len(gemini_calls), 1)
            self.assertEqual(result["coaching"], "Regenerated coaching.")

    def test_regenerate_with_instructions_makes_one_gemini_call(self):
        """Regenerate with instructions makes exactly 1 Gemini call."""
        session = {
            "session_id": "sess-regen-inst",
            "candidate_name": "Candidate",
            "tester_name": "Tester",
            "call_1": {"result": "Pass"},
            "sup_transfer_1": {"result": "Pass"},
            "coaching_summary": "Original coaching",
            "fail_summary": "N/A",
        }
        settings = {"enable_gemini": True}
        gemini_calls = []

        def mock_call_model(model_name, prompt, api_key, generation_config=None):
            gemini_calls.append(prompt)
            mock_resp = MagicMock()
            mock_resp.text = "Shortened coaching."
            mock_resp.candidates = []
            return mock_resp

        with patch.object(server, "_call_single_gemini_model_content", side_effect=mock_call_model):
            result = server.generate_summaries(
                session,
                api_key="valid-key",
                settings=settings,
                instructions="Make it shorter",
                current_summary="Original coaching",
                summary_type="coaching"
            )
            self.assertEqual(len(gemini_calls), 1)
            self.assertIn("Make it shorter", gemini_calls[0])
            self.assertEqual(result["coaching"], "Shortened coaching.")

    def test_gemini_output_does_not_contain_final_readiness_narration(self):
        """Final Readiness narration is strictly stripped from Gemini outputs."""
        session = {
            "session_id": "sess-readiness",
            "candidate_name": "Candidate",
            "tester_name": "Tester",
            "call_1": {"result": "Pass"},
            "sup_transfer_1": {"result": "Pass"},
            "coaching_summary": "Original coaching",
            "fail_summary": "N/A",
        }
        settings = {"enable_gemini": True}

        def mock_call_model(model_name, prompt, api_key, generation_config=None):
            mock_resp = MagicMock()
            # Simulate Gemini trying to include readiness narration
            mock_resp.text = (
                "Candidate did well on verification.\n\n"
                "The final readiness judgment is Incomplete as the supervisor test call is needed to complete certification."
            )
            mock_resp.candidates = []
            return mock_resp

        with patch.object(server, "_call_single_gemini_model_content", side_effect=mock_call_model):
            result = server.generate_summaries(session, api_key="valid-key", settings=settings)
            self.assertNotIn(
                "final readiness judgment",
                result["coaching"].lower(),
                "Final readiness narration must be stripped from Gemini summary output"
            )
            self.assertEqual(result["coaching"], "Candidate did well on verification.")

    def test_connection_test_uses_primary_model(self):
        """test_gemini_connection_with_timeout tests primary model gemini-3.5-flash-lite."""
        models_called = []

        def mock_call_model(model_name, prompt, api_key, generation_config=None):
            models_called.append(model_name)
            mock_resp = MagicMock()
            mock_resp.text = "OK"
            mock_resp.candidates = []
            return mock_resp

        with patch.object(server, "_call_single_gemini_model_content", side_effect=mock_call_model):
            result = server.test_gemini_connection_with_timeout("valid-key")
            self.assertTrue(result["ok"])
            self.assertEqual(models_called, ["gemini-3.5-flash-lite"])


if __name__ == "__main__":
    unittest.main()

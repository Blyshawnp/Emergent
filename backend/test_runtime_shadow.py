from __future__ import annotations

import threading
import time
import unittest

from data_providers.runtime_shadow import (
    ShadowComparisonRuntime,
    ShadowRuntimeConfig,
    ReadOnlySupabaseShadowProvider,
    runtime_shadow_enabled,
)


SAFE_ENV = {
    "MTS_DATA_PROVIDER": "sheets",
    "MTS_SHADOW_COMPARE": "true",
    "MTS_DUAL_WRITE_ENABLED": "false",
}


def _result(domain, *, mismatch=0, unexplained=0, errors=0):
    return {
        "mismatch_count": mismatch,
        "error_count": errors,
        "categories": {domain: {
            "unexplained_difference_count": unexplained,
            "error_count": errors,
            "safe_mismatch_details": [],
        }},
    }


class RuntimeShadowTests(unittest.TestCase):
    def _runtime(self, comparison, *, env=None, workers=1, queued=2, telemetry=20):
        return ShadowComparisonRuntime(
            lambda _config: (object(), object()),
            config=ShadowRuntimeConfig(
                max_workers=workers,
                max_queued=queued,
                io_timeout_seconds=0.5,
                retry_limit=0,
                log_interval_seconds=600,
                telemetry_limit=telemetry,
            ),
            environ=SAFE_ENV if env is None else env,
            comparison=comparison,
        )

    def test_flag_false_does_not_build_providers_or_compare(self):
        calls = []
        runtime = ShadowComparisonRuntime(
            lambda _config: calls.append("provider"),
            environ={**SAFE_ENV, "MTS_SHADOW_COMPARE": "false"},
            comparison=lambda *_args, **_kwargs: calls.append("compare"),
        )
        self.assertEqual(runtime.submit("history"), "disabled")
        runtime.shutdown()
        self.assertEqual(calls, [])

    def test_safety_flags_require_sheets_without_dual_write(self):
        self.assertTrue(runtime_shadow_enabled(SAFE_ENV))
        self.assertFalse(runtime_shadow_enabled({**SAFE_ENV, "MTS_DATA_PROVIDER": "supabase"}))
        self.assertFalse(runtime_shadow_enabled({**SAFE_ENV, "MTS_DUAL_WRITE_ENABLED": "true"}))

    def test_supabase_runtime_facade_exposes_reads_but_no_mutation_api(self):
        class Provider:
            _url = "https://example.supabase.co"

            def set_comparison_deadline(self, seconds):
                self.deadline = seconds

            def list_resource(self, resource, **kwargs):
                return [(resource, kwargs)]

            def _request(self, path, **kwargs):
                return [(path, kwargs)]

            def upsert_rows(self, *_args, **_kwargs):
                raise AssertionError("must be unreachable")

        provider = Provider()
        facade = ReadOnlySupabaseShadowProvider(provider)
        self.assertEqual(facade.list_resource("notifications", limit=5)[0][0], "notifications")
        self.assertEqual(facade._request("data_source_lineage", query={"select": "id"})[0][0], "data_source_lineage")
        self.assertFalse(hasattr(facade, "upsert_rows"))
        self.assertFalse(hasattr(facade, "begin_reconciliation_execution"))
        with self.assertRaisesRegex(RuntimeError, "write_forbidden"):
            facade._request("data_source_lineage", method="POST", body={})
        with self.assertRaisesRegex(RuntimeError, "direct_query_forbidden"):
            facade._request("candidates")

    def test_background_match_returns_before_comparison_finishes(self):
        entered = threading.Event()
        release = threading.Event()

        def compare(_sheets, _supabase, domain, **_kwargs):
            entered.set()
            release.wait(1)
            return _result(domain)

        runtime = self._runtime(compare)
        started = time.perf_counter()
        self.assertEqual(runtime.submit("history"), "scheduled")
        elapsed = time.perf_counter() - started
        self.assertTrue(entered.wait(0.5))
        self.assertLess(elapsed, 0.1)
        self.assertEqual(runtime.pending_count(), 1)
        release.set()
        runtime.shutdown()
        self.assertEqual(runtime.telemetry()[-1]["status"], "match")

    def test_mismatch_expected_difference_and_errors_are_diagnostic(self):
        outcomes = iter([
            _result("history", mismatch=1, unexplained=1),
            _result("headset_reviews", mismatch=1),
            RuntimeError("private payload must not escape"),
        ])

        def compare(_sheets, _supabase, domain, **_kwargs):
            outcome = next(outcomes)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        runtime = self._runtime(compare, workers=1, queued=3)
        for domain in ("history", "headset_reviews", "notifications"):
            self.assertEqual(runtime.submit(domain), "scheduled")
        self.assertTrue(runtime.wait_for_idle())
        runtime.shutdown()
        events = runtime.telemetry()
        self.assertEqual(
            [event["status"] for event in events],
            ["unexplained_difference", "expected_historical_difference", "shadow_error"],
        )
        self.assertEqual(events[-1]["exception_class"], "RuntimeError")
        self.assertNotIn("private payload", str(events))

    def test_malformed_result_and_timeout_are_isolated(self):
        outcomes = iter([None, TimeoutError("slow")])

        def compare(*_args, **_kwargs):
            outcome = next(outcomes)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        runtime = self._runtime(compare, workers=1, queued=2)
        runtime.submit("history")
        runtime.submit("notifications")
        self.assertTrue(runtime.wait_for_idle())
        runtime.shutdown()
        self.assertEqual([e["status"] for e in runtime.telemetry()], ["shadow_error", "shadow_error"])
        self.assertEqual(
            [e["exception_class"] for e in runtime.telemetry()],
            ["AttributeError", "TimeoutError"],
        )

    def test_capacity_and_duplicate_coalescing_are_bounded(self):
        release = threading.Event()
        entered = threading.Event()

        def compare(_sheets, _supabase, domain, **_kwargs):
            entered.set()
            release.wait(1)
            return _result(domain)

        runtime = self._runtime(compare, workers=1, queued=1)
        self.assertEqual(runtime.submit("history"), "scheduled")
        self.assertTrue(entered.wait(0.5))
        self.assertEqual(runtime.submit("notifications"), "scheduled")
        self.assertEqual(runtime.submit("history"), "skipped_due_to_capacity")
        self.assertEqual(runtime.submit("headset_catalog"), "skipped_due_to_capacity")
        self.assertEqual(runtime.pending_count(), 2)
        release.set()
        runtime.shutdown()
        skips = [event for event in runtime.telemetry() if event["status"] == "skipped_due_to_capacity"]
        self.assertEqual({event["reason"] for event in skips}, {"coalesced", "capacity"})

    def test_shutdown_cancels_queued_work_and_releases_capacity(self):
        entered = threading.Event()
        release = threading.Event()

        def compare(_sheets, _supabase, domain, **_kwargs):
            entered.set()
            release.wait(1)
            return _result(domain)

        runtime = self._runtime(compare, workers=1, queued=1)
        runtime.submit("history")
        self.assertTrue(entered.wait(0.5))
        runtime.submit("notifications")
        shutdown = threading.Thread(target=runtime.shutdown)
        shutdown.start()
        release.set()
        shutdown.join(1)
        self.assertFalse(shutdown.is_alive())
        self.assertEqual(runtime.pending_count(), 0)
        self.assertEqual(runtime.submit("history"), "skipped_due_to_capacity")

    def test_telemetry_is_bounded_and_contains_only_safe_shape(self):
        runtime = self._runtime(lambda _a, _b, domain, **_kw: _result(domain), telemetry=2)
        for domain in ("history", "notifications", "headset_catalog"):
            runtime.submit(domain)
        self.assertTrue(runtime.wait_for_idle())
        runtime.shutdown()
        events = runtime.telemetry()
        self.assertEqual(len(events), 2)
        self.assertEqual(set(events[0]), {
            "timestamp", "domain", "status", "duration_ms", "exception_class",
            "safe_identity_hashes", "reason",
        })

    def test_grouped_route_domains_share_one_provider_snapshot(self):
        provider_calls = []

        def providers(_config):
            provider_calls.append(True)
            return object(), object()

        runtime = ShadowComparisonRuntime(
            providers,
            config=ShadowRuntimeConfig(max_workers=1, max_queued=1),
            environ=SAFE_ENV,
            comparison=lambda _a, _b, domain, **_kw: _result(domain),
        )
        self.assertEqual(
            runtime.submit_many(("pending_requests", "recent_activity", "newbie_shift_requests")),
            "scheduled",
        )
        self.assertTrue(runtime.wait_for_idle())
        runtime.shutdown()
        self.assertEqual(len(provider_calls), 1)
        self.assertEqual(
            [event["domain"] for event in runtime.telemetry()],
            ["pending_requests", "recent_activity", "newbie_shift_requests"],
        )


if __name__ == "__main__":
    unittest.main()

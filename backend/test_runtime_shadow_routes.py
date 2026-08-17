from __future__ import annotations

import inspect
from contextlib import ExitStack
import threading
import time
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

import server
from data_providers.runtime_shadow import ShadowComparisonRuntime, ShadowRuntimeConfig


class RecordingRuntime:
    def __init__(self, error=None):
        self.calls = []
        self.error = error

    def submit(self, domain):
        self.calls.append(domain)
        if self.error:
            raise self.error
        return "scheduled"


class RuntimeShadowRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(server.app)

    def test_candidate_tracking_route_keeps_sheets_payload_on_shadow_error(self):
        expected = {"ok": True, "matches": [{"session_id": "safe-id"}]}
        with patch.object(server, "_reconcile_remote_newbie_requests_into_local_state", return_value={"ok": True}), \
             patch.object(server, "_lookup_shared_candidate_sessions", return_value=expected), \
             patch.object(server, "_shadow_runtime", RecordingRuntime()) as runtime:
            baseline = self.client.get("/api/shared/candidates/lookup?name=test")
        failing = RecordingRuntime(RuntimeError("shadow unavailable"))
        with patch.object(server, "_reconcile_remote_newbie_requests_into_local_state", return_value={"ok": True}), \
             patch.object(server, "_lookup_shared_candidate_sessions", return_value=expected), \
             patch.object(server, "_shadow_runtime", failing):
            shadow = self.client.get("/api/shared/candidates/lookup?name=test")
        self.assertEqual((baseline.status_code, baseline.json()), (200, expected))
        self.assertEqual((shadow.status_code, shadow.json()), (baseline.status_code, baseline.json()))
        self.assertEqual(runtime.calls, ["candidate_tracking"])

    def test_history_route_keeps_local_sheets_authoritative_view(self):
        row = {"session_id": "safe-session", "status": "Pass", "timestamp": "2026-08-16T00:00:00Z"}
        with patch.object(server.db.history, "_read_history_docs", return_value=[row]), \
             patch.object(server, "_shadow_runtime", RecordingRuntime()):
            baseline = self.client.get("/api/history")
        failing = RecordingRuntime(ValueError("malformed shadow response"))
        with patch.object(server.db.history, "_read_history_docs", return_value=[row]), \
             patch.object(server, "_shadow_runtime", failing):
            shadow = self.client.get("/api/history")
        self.assertEqual(baseline.status_code, 200)
        self.assertEqual((shadow.status_code, shadow.json()), (baseline.status_code, baseline.json()))
        self.assertEqual(failing.calls, ["history", "candidate_sessions"])

    def test_headset_route_keeps_sheets_payload_on_shadow_mismatch(self):
        expected = {"groups": [{"brand": "safe-brand", "models": []}], "denied": [], "error": ""}
        fetch = AsyncMock(return_value=(expected["groups"], [], ""))
        with patch.object(server, "_fetch_approved_headsets", fetch), \
             patch.object(server, "_shadow_runtime", RecordingRuntime()):
            baseline = self.client.get("/api/headsets")
        with patch.object(server, "_fetch_approved_headsets", AsyncMock(return_value=(expected["groups"], [], ""))), \
             patch.object(server, "_shadow_runtime", RecordingRuntime(RuntimeError("mismatch"))):
            shadow = self.client.get("/api/headsets")
        self.assertEqual((baseline.status_code, baseline.json()), (200, expected))
        self.assertEqual((shadow.status_code, shadow.json()), (baseline.status_code, baseline.json()))

    def test_newbie_pending_recent_route_keeps_sheets_snapshot(self):
        expected = {"ok": True, "pending": [], "recent": [], "newbie": []}
        headers = {server.ADMIN_TOKEN_HEADER: "test-token"}
        with patch.dict(server.os.environ, {"MTS_ADMIN_TOKEN": "test-token"}), \
             patch.object(server, "_shared_pending_request_snapshot", return_value=expected), \
             patch.object(server, "_shadow_runtime", RecordingRuntime()):
            baseline = self.client.get("/api/shared/admin/pending-requests", headers=headers)
        failing = RecordingRuntime(TimeoutError("shadow timeout"))
        with patch.dict(server.os.environ, {"MTS_ADMIN_TOKEN": "test-token"}), \
             patch.object(server, "_shared_pending_request_snapshot", return_value=expected), \
             patch.object(server, "_shadow_runtime", failing):
            shadow = self.client.get("/api/shared/admin/pending-requests", headers=headers)
        self.assertEqual((baseline.status_code, baseline.json()), (200, expected))
        self.assertEqual((shadow.status_code, shadow.json()), (baseline.status_code, baseline.json()))
        self.assertEqual(failing.calls, [
            "pending_requests", "recent_activity", "newbie_shift_requests", "candidate_corrections",
        ])

    def test_slow_shadow_is_not_added_to_headset_response_latency(self):
        entered = threading.Event()
        release = threading.Event()

        def compare(_sheets, _supabase, domain, **_kwargs):
            entered.set()
            release.wait(1)
            return {"mismatch_count": 0, "error_count": 0, "categories": {domain: {}}}

        runtime = ShadowComparisonRuntime(
            lambda _config: (object(), object()),
            config=ShadowRuntimeConfig(max_workers=1, max_queued=1, io_timeout_seconds=0.5),
            environ={
                "MTS_DATA_PROVIDER": "sheets",
                "MTS_SHADOW_COMPARE": "true",
                "MTS_DUAL_WRITE_ENABLED": "false",
            },
            comparison=compare,
        )
        try:
            with patch.object(server, "_fetch_approved_headsets", AsyncMock(return_value=([], [], ""))), \
                 patch.object(server, "_shadow_runtime", runtime):
                started = time.perf_counter()
                response = self.client.get("/api/headsets")
                elapsed = time.perf_counter() - started
            self.assertEqual(response.status_code, 200)
            self.assertTrue(entered.wait(0.5))
            self.assertLess(elapsed, 0.1)
        finally:
            release.set()
            runtime.shutdown()

    def _assert_nonblocking(self, path, patchers, *, headers=None):
        entered = threading.Event()
        release = threading.Event()

        def compare(_sheets, _supabase, domain, **_kwargs):
            entered.set()
            release.wait(1)
            return {"mismatch_count": 0, "error_count": 0, "categories": {domain: {}}}

        runtime = ShadowComparisonRuntime(
            lambda _config: (object(), object()),
            config=ShadowRuntimeConfig(max_workers=1, max_queued=1, io_timeout_seconds=0.5),
            environ={
                "MTS_DATA_PROVIDER": "sheets",
                "MTS_SHADOW_COMPARE": "true",
                "MTS_DUAL_WRITE_ENABLED": "false",
            },
            comparison=compare,
        )
        try:
            with ExitStack() as stack:
                for patcher in patchers:
                    stack.enter_context(patcher)
                stack.enter_context(patch.object(server, "_shadow_runtime", runtime))
                started = time.perf_counter()
                response = self.client.get(path, headers=headers or {})
                elapsed = time.perf_counter() - started
            self.assertEqual(response.status_code, 200)
            self.assertTrue(entered.wait(0.5))
            self.assertLess(elapsed, 0.1)
            return elapsed
        finally:
            release.set()
            runtime.shutdown()

    def test_candidate_history_latency_excludes_shadow_io(self):
        self._assert_nonblocking(
            "/api/history",
            [patch.object(server.db.history, "_read_history_docs", return_value=[])],
        )

    def test_candidate_tracking_latency_excludes_shadow_io(self):
        self._assert_nonblocking(
            "/api/shared/candidates/lookup?name=test",
            [
                patch.object(server, "_reconcile_remote_newbie_requests_into_local_state", return_value={"ok": True}),
                patch.object(server, "_lookup_shared_candidate_sessions", return_value={"ok": True, "matches": []}),
            ],
        )

    def test_pending_recent_latency_excludes_shadow_io(self):
        headers = {server.ADMIN_TOKEN_HEADER: "test-token"}
        self._assert_nonblocking(
            "/api/shared/admin/pending-requests",
            [
                patch.dict(server.os.environ, {"MTS_ADMIN_TOKEN": "test-token"}),
                patch.object(server, "_shared_pending_request_snapshot", return_value={"ok": True, "pending": [], "recent": []}),
            ],
            headers=headers,
        )

    def test_shadow_wiring_is_present_only_on_get_routes(self):
        integrated = []
        for route in server.app.routes:
            if not isinstance(route, APIRoute):
                continue
            try:
                source = inspect.getsource(route.endpoint)
            except (OSError, TypeError):
                continue
            if "_schedule_shadow_domains" in source:
                integrated.append(route.path)
                self.assertEqual(route.methods, {"GET"}, route.path)
        self.assertGreaterEqual(len(integrated), 10)


if __name__ == "__main__":
    unittest.main()

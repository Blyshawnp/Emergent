from __future__ import annotations

import datetime
import logging
import os
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable, Mapping

from .sheets import SheetsDataProvider
from .supabase import SupabaseDataProvider

logger = logging.getLogger(__name__)

TRUE_VALUES = frozenset({"1", "true", "yes", "on"})
RUNTIME_SHADOW_DOMAINS = frozenset({
    "candidates", "candidate_sessions", "session_attempts",
    "authoritative_candidate_status", "candidate_tracking", "history",
    "headset_catalog", "headset_reviews", "supervisor_transfers",
    "newbie_shift_requests", "candidate_corrections", "pending_requests",
    "recent_activity", "notifications",
})

RUNTIME_CONFIG_DOMAINS = frozenset({
    "callers", "call_types", "call_fail_reasons", "supervisor_coaching",
    "supervisor_fail_reasons", "supervisor_reasons", "shows",
    "gemini_coaching_prompt", "gemini_fail_prompt",
})

RUNTIME_ALL_DOMAINS = RUNTIME_SHADOW_DOMAINS | RUNTIME_CONFIG_DOMAINS


class ReadOnlySupabaseShadowProvider:
    """Narrow facade: runtime shadow code has no Supabase mutation methods."""

    def __init__(self, provider):
        self._provider = provider
        self._url = provider._url

    def set_comparison_deadline(self, seconds):
        self._provider.set_comparison_deadline(seconds)

    def list_resource(self, resource, *, filters=None, limit=1000, offset=0):
        return self._provider.list_resource(
            resource, filters=filters, limit=limit, offset=offset
        )

    def _request(self, path, *, query=None, method="GET", body=None, prefer=None):
        if method != "GET" or body is not None or prefer is not None:
            raise RuntimeError("runtime_shadow_write_forbidden")
        if str(path) != "data_source_lineage":
            raise RuntimeError("runtime_shadow_direct_query_forbidden")
        try:
            return self._provider._request(path, query=query)
        except Exception:
            return self._provider._request(
                "rpc/get_shadow_domain_data",
                method="POST",
                body={"p_domain": "candidate_lineage", "p_limit": 5000}
            )


def _enabled(value) -> bool:
    return str(value or "").strip().casefold() in TRUE_VALUES


def runtime_shadow_enabled(environ: Mapping[str, str] | None = None) -> bool:
    env = os.environ if environ is None else environ
    return bool(
        str(env.get("MTS_DATA_PROVIDER", "sheets")).strip().casefold() == "sheets"
        and _enabled(env.get("MTS_SHADOW_COMPARE", "false"))
        and not _enabled(env.get("MTS_DUAL_WRITE_ENABLED", "false"))
    )


@dataclass(frozen=True)
class ShadowRuntimeConfig:
    max_workers: int = 2
    max_queued: int = 4
    io_timeout_seconds: float = 10.0
    retry_limit: int = 0
    log_interval_seconds: float = 60.0
    telemetry_limit: int = 200

    @classmethod
    def from_environ(cls, environ: Mapping[str, str] | None = None):
        env = os.environ if environ is None else environ

        def integer(name, default, minimum, maximum):
            try:
                value = int(str(env.get(name, default)).strip())
            except (TypeError, ValueError):
                value = default
            return max(minimum, min(maximum, value))

        def number(name, default, minimum, maximum):
            try:
                value = float(str(env.get(name, default)).strip())
            except (TypeError, ValueError):
                value = default
            return max(minimum, min(maximum, value))

        return cls(
            max_workers=integer("MTS_SHADOW_MAX_WORKERS", 2, 1, 4),
            max_queued=integer("MTS_SHADOW_MAX_QUEUED", 4, 0, 16),
            io_timeout_seconds=number("MTS_SHADOW_IO_TIMEOUT_SECONDS", 10.0, 1.0, 15.0),
            retry_limit=integer("MTS_SHADOW_RETRY_LIMIT", 0, 0, 1),
            log_interval_seconds=number("MTS_SHADOW_LOG_INTERVAL_SECONDS", 60.0, 10.0, 600.0),
            telemetry_limit=integer("MTS_SHADOW_TELEMETRY_LIMIT", 200, 20, 1000),
        )


class ShadowComparisonRuntime:
    """Bounded in-process diagnostic executor; never participates in responses."""

    def __init__(
        self,
        provider_factory: Callable[[ShadowRuntimeConfig], tuple],
        *,
        config: ShadowRuntimeConfig | None = None,
        environ: Mapping[str, str] | None = None,
        comparison: Callable | None = None,
    ):
        self.config = config or ShadowRuntimeConfig.from_environ(environ)
        self._environ = os.environ if environ is None else environ
        self._provider_factory = provider_factory
        if comparison is None:
            from tools.supabase_import.core import compare_shadow_resource
            comparison = compare_shadow_resource
        self._comparison = comparison
        self._lock = threading.Lock()
        self._capacity = threading.BoundedSemaphore(
            self.config.max_workers + self.config.max_queued
        )
        self._pending = set()
        self._telemetry = deque(maxlen=self.config.telemetry_limit)
        self._last_log = {}
        self._executor = None
        self._stopping = False
        self._closed = False

    def start(self):
        with self._lock:
            if self._closed:
                return False
            if self._executor is None:
                self._executor = ThreadPoolExecutor(
                    max_workers=self.config.max_workers,
                    thread_name_prefix="mts-shadow",
                )
                self._stopping = False
            return True

    def submit(self, domain: str) -> str:
        return self.submit_many((domain,))

    def submit_many(self, domains) -> str:
        normalized = tuple(dict.fromkeys(str(domain or "").strip() for domain in domains))
        if not normalized or any(domain not in RUNTIME_SHADOW_DOMAINS for domain in normalized):
            raise ValueError("Unsupported runtime shadow domain")
        if not runtime_shadow_enabled(self._environ):
            return "disabled"
        if not self.start():
            return self._record_skip_many(normalized, "shutdown")
        skip_reason = ""
        with self._lock:
            if self._stopping or self._executor is None:
                skip_reason = "shutdown"
            elif any(domain in self._pending for domain in normalized):
                skip_reason = "coalesced"
            elif not self._capacity.acquire(blocking=False):
                skip_reason = "capacity"
            else:
                self._pending.update(normalized)
                executor = self._executor
        if skip_reason:
            return self._record_skip_many(normalized, skip_reason)
        try:
            future = executor.submit(self._run_many, normalized)
            future.add_done_callback(lambda _future, items=normalized: self._release(items))
        except Exception:
            with self._lock:
                self._pending.difference_update(normalized)
                self._capacity.release()
            return self._record_skip_many(normalized, "submit_failed")
        return "scheduled"

    def _run_many(self, domains):
        try:
            sheets_provider, supabase_provider = self._provider_factory(self.config)
        except Exception as exc:
            for domain in domains:
                self._record(domain, "shadow_error", 0.0, exc.__class__.__name__, [])
            return
        for domain in domains:
            self._run_one(sheets_provider, supabase_provider, domain)

    def _run_one(self, sheets_provider, supabase_provider, domain):
        started = time.perf_counter()
        status = "shadow_error"
        safe_hashes = []
        error_class = ""
        try:
            for provider in (sheets_provider, supabase_provider):
                set_deadline = getattr(provider, "set_comparison_deadline", None)
                if callable(set_deadline):
                    set_deadline(self.config.io_timeout_seconds)
            result = self._comparison(
                sheets_provider, supabase_provider, domain, diagnostic_mode=True
            )
            domain_result = (result.get("categories") or {}).get(domain) or {}
            safe_hashes = [
                str(item.get("safe_identity_hash") or "")
                for item in (domain_result.get("safe_mismatch_details") or [])[:5]
                if str(item.get("safe_identity_hash") or "")
            ]
            if result.get("error_count") or domain_result.get("error_count"):
                status = "shadow_error"
            elif domain_result.get("unexplained_difference_count"):
                status = "unexplained_difference"
            elif result.get("mismatch_count"):
                status = "expected_historical_difference"
            else:
                status = "match"
        except Exception as exc:
            error_class = exc.__class__.__name__
            status = "shadow_error"
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 1)
            self._record(domain, status, duration_ms, error_class, safe_hashes)

    def _release(self, domains):
        with self._lock:
            present = any(domain in self._pending for domain in domains)
            self._pending.difference_update(domains)
            if present:
                self._capacity.release()

    def _record_skip(self, domain, reason):
        self._record(domain, "skipped_due_to_capacity", 0.0, "", [], reason=reason)
        return "skipped_due_to_capacity"

    def _record_skip_many(self, domains, reason):
        for domain in domains:
            self._record_skip(domain, reason)
        return "skipped_due_to_capacity"

    def _record(self, domain, status, duration_ms, error_class, safe_hashes, *, reason=""):
        event = {
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "domain": domain,
            "status": status,
            "duration_ms": duration_ms,
            "exception_class": error_class,
            "safe_identity_hashes": list(safe_hashes),
            "reason": reason,
        }
        with self._lock:
            self._telemetry.append(event)
            log_key = (domain, status, error_class, reason)
            now = time.monotonic()
            should_log = now - self._last_log.get(log_key, 0.0) >= self.config.log_interval_seconds
            if should_log:
                self._last_log[log_key] = now
                while len(self._last_log) > self.config.telemetry_limit:
                    self._last_log.pop(next(iter(self._last_log)))
        if should_log:
            log_method = logger.warning if status in {
                "unexplained_difference", "shadow_error", "skipped_due_to_capacity"
            } else logger.info
            log_method(
                "[DATA-SHADOW] domain=%s status=%s duration_ms=%s exception_class=%s reason=%s safe_hash_count=%s",
                domain, status, duration_ms, error_class or "none", reason or "none", len(safe_hashes),
            )

    def telemetry(self):
        with self._lock:
            return [dict(item) for item in self._telemetry]

    def pending_count(self):
        with self._lock:
            return len(self._pending)

    def diagnostics(self):
        events = self.telemetry()
        counts = {}
        for event in events:
            status = event["status"]
            counts[status] = counts.get(status, 0) + 1
        return {
            "enabled": runtime_shadow_enabled(self._environ),
            "pending": self.pending_count(),
            "maxWorkers": self.config.max_workers,
            "maxQueued": self.config.max_queued,
            "ioTimeoutSeconds": self.config.io_timeout_seconds,
            "retryLimit": self.config.retry_limit,
            "telemetryLimit": self.config.telemetry_limit,
            "telemetryCount": len(events),
            "statusCounts": counts,
        }

    def wait_for_idle(self, timeout=5.0):
        deadline = time.monotonic() + max(0.0, float(timeout))
        while self.pending_count() and time.monotonic() < deadline:
            time.sleep(0.005)
        return self.pending_count() == 0

    def shutdown(self, *, wait=True):
        with self._lock:
            self._stopping = True
            self._closed = True
            executor = self._executor
            self._executor = None
        if executor is not None:
            executor.shutdown(wait=wait, cancel_futures=True)


def build_runtime_shadow_providers(
    backend_root,
    expected_role,
    config: ShadowRuntimeConfig,
    environ: Mapping[str, str] | None = None,
):
    """Build fresh read-only providers for one background comparison job."""
    env = os.environ if environ is None else environ
    if not runtime_shadow_enabled(env):
        raise RuntimeError("runtime_shadow_not_safely_enabled")
    from services.apps_script_api import AppsScriptApiClient, load_apps_script_api_config

    apps_config, status = load_apps_script_api_config(
        backend_root, expected_role=expected_role
    )
    if not apps_config:
        raise RuntimeError(f"apps_script_shadow_unavailable:{status.get('status')}")
    sheets_client = AppsScriptApiClient(
        apps_config, timeout=config.io_timeout_seconds
    )
    sheets = SheetsDataProvider(sheets_client, max_retries=0)
    supabase_url = str(env.get("SUPABASE_URL") or "").strip()
    supabase_key = str(env.get("SUPABASE_ANON_KEY") or env.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()

    if not supabase_url or not supabase_key:
        try:
            import json
            from pathlib import Path
            candidate_paths = [
                Path(backend_root) / "config" / "runtime_config.json",
                Path(backend_root).parent / "backend" / "config" / "runtime_config.json",
            ]
            for cfg_p in candidate_paths:
                if cfg_p.exists():
                    with open(cfg_p, "r", encoding="utf-8") as f:
                        cfg_data = json.load(f)
                        supabase_url = supabase_url or str(cfg_data.get("supabase_url") or "").strip()
                        supabase_key = supabase_key or str(cfg_data.get("supabase_anon_key") or "").strip()
                    if supabase_url and supabase_key:
                        break
        except Exception:
            pass

    supabase = SupabaseDataProvider(
        supabase_url,
        supabase_key,
        timeout=config.io_timeout_seconds,
        retries=config.retry_limit,
    )
    return sheets, ReadOnlySupabaseShadowProvider(supabase)

from __future__ import annotations

import json
import os
from pathlib import Path

from .shadow import ShadowCompareDataProvider
from .sheets import SheetsDataProvider
from .supabase import SupabaseDataProvider

ALLOWED_PROVIDER_MODES = {"sheets", "supabase", "shadow_compare", "local_test"}


def _read_runtime_config_data_provider() -> str:
    try:
        candidate_paths = [
            Path(os.getenv("BACKEND_RUNTIME_CONFIG_FILE", "")).expanduser() if os.getenv("BACKEND_RUNTIME_CONFIG_FILE") else None,
            Path(__file__).resolve().parent.parent / "config" / "runtime_config.json",
            Path(__file__).resolve().parent.parent.parent / "desktop" / "dist-notification-manager" / "win-unpacked" / "resources" / "backend" / "config" / "runtime_config.json",
        ]
        for p in candidate_paths:
            if p and p.is_file():
                with open(p, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                val = str(cfg.get("data_provider") or "").strip().lower()
                if val in ALLOWED_PROVIDER_MODES:
                    return val
    except Exception:
        pass
    return ""


def _read_runtime_config_supabase() -> tuple[str, str]:
    url = ""
    key = ""
    try:
        candidate_paths = [
            Path(os.getenv("BACKEND_RUNTIME_CONFIG_FILE", "")).expanduser() if os.getenv("BACKEND_RUNTIME_CONFIG_FILE") else None,
            Path(__file__).resolve().parent.parent / "config" / "runtime_config.json",
            Path(__file__).resolve().parent.parent.parent / "desktop" / "dist-notification-manager" / "win-unpacked" / "resources" / "backend" / "config" / "runtime_config.json",
        ]
        for p in candidate_paths:
            if p and p.is_file():
                with open(p, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                url = url or str(cfg.get("supabase_url") or "").strip()
                key = key or str(cfg.get("supabase_anon_key") or "").strip()
                if url and key:
                    break
    except Exception:
        pass
    return url, key


def configured_provider_mode(environ=None) -> str:
    if environ is not None:
        raw = environ.get("MTS_DATA_PROVIDER")
        if raw is not None:
            mode = str(raw).strip().lower() or "sheets"
        else:
            mode = "sheets"
    else:
        raw = os.environ.get("MTS_DATA_PROVIDER")
        if raw is not None and str(raw).strip():
            mode = str(raw).strip().lower()
        else:
            mode = _read_runtime_config_data_provider() or "sheets"

    if mode not in ALLOWED_PROVIDER_MODES:
        raise ValueError(f"Unsupported MTS_DATA_PROVIDER: {mode}")
    return mode


def _supabase_provider(environ):
    env = os.environ if environ is None else environ
    url = str(env.get("SUPABASE_URL", "")).strip()
    key = str(env.get("SUPABASE_SERVICE_ROLE_KEY", "") or env.get("SUPABASE_ANON_KEY", "")).strip()
    if environ is None or environ is os.environ:
        if not url or not key:
            cfg_url, cfg_key = _read_runtime_config_supabase()
            url = url or cfg_url
            key = key or cfg_key
    return SupabaseDataProvider(
        url,
        key,
        timeout=float(env.get("SUPABASE_TIMEOUT_SECONDS", "10")),
    )


def build_data_provider(*, sheets_client=None, environ=None):
    env = os.environ if environ is None else environ
    mode = configured_provider_mode(env)
    if mode == "supabase":
        return _supabase_provider(env)
    sheets = SheetsDataProvider(sheets_client) if sheets_client is not None else None
    if mode == "sheets":
        if sheets is None:
            raise ValueError("sheets_client is required for sheets mode")
        return sheets
    if mode == "shadow_compare":
        if sheets is None:
            raise ValueError("sheets_client is required for shadow_compare mode")
        return ShadowCompareDataProvider(sheets, _supabase_provider(env))
    raise ValueError("local_test provider must be injected by tests")

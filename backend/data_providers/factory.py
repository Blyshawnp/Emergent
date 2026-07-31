from __future__ import annotations

import os

from .shadow import ShadowCompareDataProvider
from .sheets import SheetsDataProvider
from .supabase import SupabaseDataProvider

ALLOWED_PROVIDER_MODES = {"sheets", "supabase", "shadow_compare", "local_test"}


def configured_provider_mode(environ=None) -> str:
    env = os.environ if environ is None else environ
    mode = str(env.get("MTS_DATA_PROVIDER", "sheets")).strip().lower() or "sheets"
    if mode not in ALLOWED_PROVIDER_MODES:
        raise ValueError(f"Unsupported MTS_DATA_PROVIDER: {mode}")
    return mode


def _supabase_provider(environ):
    return SupabaseDataProvider(
        environ.get("SUPABASE_URL", ""),
        environ.get("SUPABASE_SERVICE_ROLE_KEY", ""),
        timeout=float(environ.get("SUPABASE_TIMEOUT_SECONDS", "10")),
    )


def build_data_provider(*, sheets_client, environ=None):
    env = os.environ if environ is None else environ
    mode = configured_provider_mode(env)
    sheets = SheetsDataProvider(sheets_client)
    if mode == "sheets":
        return sheets
    if mode == "supabase":
        return _supabase_provider(env)
    if mode == "shadow_compare":
        return ShadowCompareDataProvider(sheets, _supabase_provider(env))
    raise ValueError("local_test provider must be injected by tests")

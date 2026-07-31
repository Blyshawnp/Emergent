"""Data-provider boundary for gradual Sheets to Supabase migration."""

from .factory import build_data_provider, configured_provider_mode

__all__ = ["build_data_provider", "configured_provider_mode"]

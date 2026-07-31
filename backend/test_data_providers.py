import unittest
from unittest.mock import Mock

from data_providers.factory import build_data_provider, configured_provider_mode
from data_providers.shadow import ShadowCompareDataProvider


class FakeProvider:
    name = "fake"

    def __init__(self, rows=None, error=None):
        self.rows = rows or []
        self.error = error

    def health(self):
        return Mock(ok=True, provider=self.name, detail="ready")

    def list_resource(self, *args, **kwargs):
        if self.error:
            raise self.error
        return self.rows


class ProviderTests(unittest.TestCase):
    def test_default_is_sheets(self):
        self.assertEqual(configured_provider_mode({}), "sheets")
        client = Mock()
        self.assertEqual(build_data_provider(sheets_client=client, environ={}).name, "sheets")

    def test_service_key_required_only_for_supabase_mode(self):
        with self.assertRaises(ValueError):
            build_data_provider(sheets_client=Mock(), environ={"MTS_DATA_PROVIDER": "supabase"})

    def test_shadow_failure_never_changes_primary_response(self):
        provider = ShadowCompareDataProvider(FakeProvider([{"session_id": "s-1"}]), FakeProvider(error=TimeoutError()))
        self.assertEqual(provider.list_resource("history"), [{"session_id": "s-1"}])

    def test_invalid_mode_fails_closed(self):
        with self.assertRaises(ValueError):
            configured_provider_mode({"MTS_DATA_PROVIDER": "dual_write"})


if __name__ == "__main__":
    unittest.main()

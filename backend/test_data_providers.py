import unittest
import json
from unittest.mock import MagicMock, Mock, patch
from urllib.error import URLError

from data_providers.factory import build_data_provider, configured_provider_mode
from data_providers.shadow import ShadowCompareDataProvider
from data_providers.supabase import SupabaseDataProvider, SupabaseProviderError


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

    def test_lineage_rpc_uses_fixed_rpc_route_and_payload(self):
        provider = SupabaseDataProvider("https://example.supabase.co", "secret-key")
        provider._request = MagicMock(return_value={"result": "inserted"})
        row = {
            "entity_type": "candidates", "entity_id": "entity-1",
            "source_system": "google_sheets", "source_tab": "Candidate Sessions",
            "source_row_key": "candidate:test", "source_checksum": "checksum",
            "import_batch_id": "batch-1", "metadata": {},
        }
        self.assertEqual(provider.insert_lineage_if_absent(row)["result"], "inserted")
        args, kwargs = provider._request.call_args
        self.assertEqual(args[0], "rpc/insert_lineage_if_absent")
        self.assertEqual(kwargs["method"], "POST")
        self.assertEqual(kwargs["body"]["p_entity_id"], "entity-1")

    def test_lineage_rpc_malformed_response_fails_closed(self):
        provider = SupabaseDataProvider("https://example.supabase.co", "secret-key")
        provider._request = MagicMock(return_value=[])
        with self.assertRaisesRegex(SupabaseProviderError, "malformed"):
            provider.insert_lineage_if_absent({
                "entity_type": "candidates", "entity_id": "entity-1",
                "source_system": "google_sheets", "source_tab": "Candidate Sessions",
                "source_row_key": "candidate:test", "source_checksum": "checksum",
                "import_batch_id": "batch-1", "metadata": {},
            })

    def test_lineage_rpc_transport_error_has_no_table_fallback(self):
        provider = SupabaseDataProvider("https://example.supabase.co", "secret-key")
        provider._request = MagicMock(side_effect=SupabaseProviderError("Supabase request timed out or was unavailable"))
        provider.upsert_rows = MagicMock()
        with self.assertRaises(SupabaseProviderError):
            provider.insert_lineage_if_absent({
                "entity_type": "candidates", "entity_id": "entity-1",
                "source_system": "google_sheets", "source_tab": "Candidate Sessions",
                "source_row_key": "candidate:test", "source_checksum": "checksum",
                "import_batch_id": "batch-1", "metadata": {},
            })
        provider.upsert_rows.assert_not_called()

    def test_uncertain_commit_retry_can_return_idempotent_reuse(self):
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False
            def read(self):
                return json.dumps({"result": "already_exists_same_mapping"}).encode("utf-8")

        provider = SupabaseDataProvider("https://example.supabase.co", "secret-key", retries=1)
        row = {
            "entity_type": "candidates", "entity_id": "entity-1",
            "source_system": "google_sheets", "source_tab": "Candidate Sessions",
            "source_row_key": "candidate:test", "source_checksum": "checksum",
            "import_batch_id": "batch-1", "metadata": {},
        }
        with patch("data_providers.supabase.urlopen", side_effect=[URLError("response lost"), Response()]) as mocked:
            result = provider.insert_lineage_if_absent(row)
        self.assertEqual(result["result"], "already_exists_same_mapping")
        self.assertEqual(mocked.call_count, 2)


if __name__ == "__main__":
    unittest.main()

import unittest
import json
from unittest.mock import MagicMock, Mock, patch
from urllib.error import URLError

from data_providers.factory import build_data_provider, configured_provider_mode
from data_providers.shadow import ShadowCompareDataProvider
from data_providers.sheets import SheetsDataProvider
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

    def test_shadow_flag_does_not_replace_sheets_primary_provider(self):
        client = Mock()
        provider = build_data_provider(
            sheets_client=client,
            environ={
                "MTS_DATA_PROVIDER": "sheets",
                "MTS_SHADOW_COMPARE": "true",
                "MTS_DUAL_WRITE_ENABLED": "false",
            },
        )
        self.assertEqual(provider.name, "sheets")
        self.assertNotIsInstance(provider, ShadowCompareDataProvider)

    def test_service_key_required_only_for_supabase_mode(self):
        with self.assertRaises(ValueError):
            build_data_provider(sheets_client=Mock(), environ={"MTS_DATA_PROVIDER": "supabase"})

    def test_supabase_shadow_deadline_fails_before_an_overdue_request(self):
        provider = SupabaseDataProvider("https://example.supabase.co", "secret-key")
        with patch("data_providers.supabase.time.monotonic", side_effect=[100.0, 101.1]), \
             patch("data_providers.supabase.urlopen") as request:
            provider.set_comparison_deadline(1.0)
            with self.assertRaisesRegex(SupabaseProviderError, "deadline exceeded"):
                provider._request("notifications")
        request.assert_not_called()

    def test_sheets_shadow_deadline_bounds_apps_script_transport(self):
        client = Mock(timeout=180)
        provider = SheetsDataProvider(client)
        provider.set_comparison_deadline(10)
        self.assertEqual(client.timeout, 10.0)

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

    def test_direct_lineage_table_upsert_is_forbidden(self):
        provider = SupabaseDataProvider("https://example.supabase.co", "secret-key")
        provider._request = MagicMock()
        with self.assertRaisesRegex(ValueError, "Direct lineage table writes are forbidden"):
            provider.upsert_rows(
                "data_source_lineage", [{}], on_conflict="source_system,source_tab,source_row_key"
            )
        provider._request.assert_not_called()

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

    def test_pending_requests_projects_canonical_request_tables(self):
        provider = SupabaseDataProvider("https://example.supabase.co", "secret-key")
        responses = {
            "pending_requests": [],
            "newbie_shift_requests": [{
                "request_id": "newbie-1", "request_type": "initial_newbie_shift",
                "request_status": "pending", "source_session_id": "session-1",
            }],
            "candidate_corrections": [{
                "request_id": "correction-1", "request_type": "candidate_information_correction",
                "status": "approved", "source_session_id": "session-2",
            }],
        }
        provider._request = MagicMock(side_effect=lambda path, **_kwargs: responses[path])
        rows = provider.list_resource("pending_requests")
        self.assertEqual({row["request_id"] for row in rows}, {"newbie-1", "correction-1"})
        self.assertEqual({row["status"] for row in rows}, {"pending", "approved"})

    def test_recent_activity_derives_from_canonical_requests(self):
        provider = SupabaseDataProvider("https://example.supabase.co", "secret-key")
        responses = {
            "pending_requests": [],
            "newbie_shift_requests": [{
                "request_id": "newbie-1", "request_type": "initial_newbie_shift",
                "request_status": "approved", "source_session_id": "session-1",
                "updated_at": "2026-08-01T00:00:00Z",
            }],
            "candidate_corrections": [],
        }
        provider._request = MagicMock(side_effect=lambda path, **_kwargs: responses[path])
        rows = provider.list_resource("recent_activity")
        self.assertEqual(rows[0]["event_id"], "newbie-1")
        self.assertEqual(rows[0]["source_entity_id"], "session-1")

    def test_request_ids_are_scoped_to_request_category(self):
        provider = SupabaseDataProvider("https://example.supabase.co", "secret-key")
        responses = {
            "pending_requests": [],
            "newbie_shift_requests": [{
                "id": "newbie-id", "request_id": "shared", "request_status": "pending",
            }],
            "candidate_corrections": [{
                "id": "correction-id", "request_id": "shared", "status": "approved",
            }],
        }
        provider._request = MagicMock(side_effect=lambda path, **_kwargs: responses[path])
        rows = provider.list_resource("pending_requests")
        self.assertEqual(len(rows), 2)
        self.assertEqual(
            {row["category"] for row in rows},
            {"newbie-shift-requests", "candidate-information-correction-requests"},
        )


if __name__ == "__main__":
    unittest.main()

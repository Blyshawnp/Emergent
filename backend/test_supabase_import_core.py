import unittest
from unittest.mock import MagicMock

from tools.supabase_import.core import (
    build_catalog_match_index,
    catalog_display,
    deterministic_source_key,
    missing_candidate_headers,
    normalize_headset_review,
    stage_rows,
    transform_and_load_batch,
)


class SupabaseImportCoreTests(unittest.TestCase):
    def test_catalog_display_avoids_duplicate_brand(self):
        self.assertEqual(catalog_display("Logitech", "Logitech H390"), "Logitech H390")
        self.assertEqual(catalog_display("Logitech", "H390"), "Logitech H390")

    def test_deterministic_legacy_headset_match(self):
        index = build_catalog_match_index([{"Brand": "Logitech", "Model": "H390"}])
        result = normalize_headset_review({"Brand": "", "Model": "  logitech   h390 "}, index)
        self.assertEqual((result["brand"], result["model"]), ("Logitech", "H390"))
        self.assertEqual(result["normalization_status"], "deterministic_catalog_match")

    def test_ambiguous_legacy_headset_is_preserved(self):
        index = {"acme one": [("Acme", "One"), ("ACME", "One")]}
        result = normalize_headset_review({"Brand": "", "Model": "Acme One"}, index)
        self.assertIsNone(result["brand"])
        self.assertEqual(result["model"], "Acme One")
        self.assertEqual(result["normalization_status"], "unresolved_legacy_brand")

    def test_newbie_shift_number_preserves_leading_zero(self):
        rows = stage_rows("newbie-shift-requests", ["request_id", "newbie_shift_number"], [
            {"request_id": "request-1", "newbie_shift_number": "0012"}
        ])
        self.assertEqual(rows[0].raw_row["newbie_shift_number"], "0012")

    def test_request_tabs_use_request_id_before_session_id(self):
        rows = stage_rows("newbie-shift-requests", ["request_id", "session_id"], [
            {"request_id": "request-1", "session_id": "session-shared"},
            {"request_id": "request-2", "session_id": "session-shared"},
        ])
        self.assertEqual(
            [row.source_row_key for row in rows],
            ["request_id:request-1", "request_id:request-2"],
        )
        self.assertTrue(all(row.fallback_reason is None for row in rows))

    def test_exact_duplicate_request_id_is_still_classified_duplicate(self):
        rows = stage_rows("newbie-shift-requests", ["request_id", "session_id"], [
            {"request_id": "request-1", "session_id": "session-1"},
            {"request_id": "request-1", "session_id": "session-2"},
        ])
        self.assertEqual(rows[1].fallback_reason, "duplicate_identity_in_source_tab")

    def test_missing_lazy_headers_are_not_corruption(self):
        self.assertIn("newbie_shift_number", missing_candidate_headers(["session_id"]))

    def test_candidate_deletion_requests_load_into_generic_request_table(self):
        provider = MagicMock()
        provider._request.side_effect = [
            [{
                "id": "stage-1",
                "source_tab": "candidate-deletion-requests",
                "source_row_key": "request_id:delete-1",
                "source_checksum": "checksum-1",
                "normalization_status": "valid",
                "raw_row": {
                    "request_id": "delete-1",
                    "request_status": "approved",
                    "candidate_name": "Candidate",
                },
            }],
            [],
            [],
        ]
        provider.insert_lineage_if_absent.return_value = {"result": "inserted"}

        transform_and_load_batch(provider, "batch-1")

        pending_call = next(
            call for call in provider.upsert_rows.call_args_list
            if call.args[0] == "pending_requests"
        )
        self.assertEqual(pending_call.args[1][0]["request_id"], "delete-1")
        self.assertEqual(pending_call.args[1][0]["request_type"], "candidate_deletion")
        self.assertEqual(pending_call.kwargs["on_conflict"], "request_id")
        provider.insert_lineage_if_absent.assert_called_once()

    def test_every_source_row_stages_and_key_is_stable(self):
        rows = [{"session_id": "s-1"}, {"candidate_name": "not-an-identity"}]
        first = stage_rows("Candidate Sessions", ["session_id", "candidate_name"], rows)
        second = stage_rows("Candidate Sessions", ["session_id", "candidate_name"], rows)
        self.assertEqual(len(first), len(rows))
        self.assertEqual([item.source_row_key for item in first], [item.source_row_key for item in second])
        self.assertIsNotNone(first[1].fallback_reason)

    def test_exact_identity_beats_names(self):
        key, reason = deterministic_source_key("Candidate Sessions", 2, {"session_id": "s-1", "candidate_name": "Same"})
        self.assertEqual(key, "session_id:s-1")
        self.assertIsNone(reason)


    def test_safe_upsert_lineage_uses_rpc_not_table_upsert(self):
        from tools.supabase_import.core import safe_upsert_lineage
        provider = MagicMock()
        provider.insert_lineage_if_absent.return_value = {"result": "inserted"}
        lineage_rows = [{
            'entity_type': 'candidates', 'entity_id': 'uuid-1',
            'source_system': 'google_sheets', 'source_tab': 'Candidate Sessions',
            'source_row_key': 'session_id:s-1', 'source_checksum': 'abc123',
            'import_batch_id': 'batch-1', 'metadata': {}
        }]
        result = safe_upsert_lineage(provider, lineage_rows)
        provider.insert_lineage_if_absent.assert_called_once_with(lineage_rows[0])
        provider.upsert_rows.assert_not_called()
        self.assertEqual(result["inserted"], 1)

    def test_safe_upsert_lineage_empty_returns_zero_dict(self):
        """Empty lineage_rows returns early with all-zero result dict."""
        from tools.supabase_import.core import safe_upsert_lineage
        provider = MagicMock()
        result = safe_upsert_lineage(provider, [])
        self.assertIsInstance(result, dict)
        provider.upsert_rows.assert_not_called()

    def test_safe_upsert_lineage_preserves_all_semantic_outcomes(self):
        from tools.supabase_import.core import safe_upsert_lineage
        provider = MagicMock()
        lineage_row = {
            'entity_type': 'candidates', 'entity_id': 'uuid-1',
            'source_system': 'google_sheets', 'source_tab': 'Candidate Sessions',
            'source_row_key': 'session_id:s-1', 'source_checksum': 'abc',
            'import_batch_id': 'b1', 'metadata': {}
        }
        outcomes = [
            "inserted",
            "already_exists_same_mapping",
            "conflict_source_maps_to_different_entity",
            "conflict_entity_maps_to_different_source",
        ]
        provider.insert_lineage_if_absent.side_effect = [{"result": outcome} for outcome in outcomes]
        result = safe_upsert_lineage(provider, [dict(lineage_row) for _ in outcomes])
        for outcome in outcomes:
            self.assertEqual(result[outcome], 1)
        self.assertEqual(result["processed"], 4)
        self.assertEqual(len(result["conflicts"]), 2)
        self.assertNotIn("source_row_key", result["conflicts"][0])
        provider.upsert_rows.assert_not_called()

    def test_safe_upsert_lineage_malformed_response_fails_closed(self):
        from tools.supabase_import.core import safe_upsert_lineage
        provider = MagicMock()
        provider.insert_lineage_if_absent.return_value = {"unexpected": "shape"}
        with self.assertRaisesRegex(RuntimeError, "lineage_rpc_malformed_response"):
            safe_upsert_lineage(provider, [{
                'entity_type': 'candidates', 'entity_id': 'uuid-1',
                'source_system': 'google_sheets', 'source_tab': 'Candidate Sessions',
                'source_row_key': 'session_id:s-1', 'source_checksum': 'abc',
                'import_batch_id': 'b1', 'metadata': {}
            }])
        provider.upsert_rows.assert_not_called()

    def test_safe_upsert_lineage_without_rpc_fails_closed(self):
        from tools.supabase_import.core import safe_upsert_lineage
        class ProviderWithoutRpc:
            def upsert_rows(self, *_args, **_kwargs):
                raise AssertionError("unsafe fallback")
        with self.assertRaisesRegex(RuntimeError, "lineage_rpc_unavailable"):
            safe_upsert_lineage(ProviderWithoutRpc(), [])


if __name__ == "__main__":
    unittest.main()

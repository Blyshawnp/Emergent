import unittest

from tools.supabase_import.core import (
    build_catalog_match_index,
    catalog_display,
    deterministic_source_key,
    missing_candidate_headers,
    normalize_headset_review,
    stage_rows,
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

    def test_missing_lazy_headers_are_not_corruption(self):
        self.assertIn("newbie_shift_number", missing_candidate_headers(["session_id"]))

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


if __name__ == "__main__":
    unittest.main()

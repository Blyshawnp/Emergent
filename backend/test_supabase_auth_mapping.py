import unittest
from unittest.mock import MagicMock
from pathlib import Path
import sys

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from tools.supabase_import.core import (
    import_user_authorization_mapping,
    compare_user_authorization_mapping,
)


class SupabaseAuthMappingTests(unittest.TestCase):
    def setUp(self):
        self.mock_staged_users = [
            {"raw_row": {"name": "Ashley Shealey", "role": "admin", "enabled": ""}, "source_checksum": "c1"},
            {"raw_row": {"name": "Becky Sowles", "role": "admin", "enabled": ""}, "source_checksum": "c2"},
            {"raw_row": {"name": "Lisa Byrd", "role": "admin", "enabled": ""}, "source_checksum": "c3"},
            {"raw_row": {"name": "Kristi Green", "role": "admin", "enabled": ""}, "source_checksum": "c4"},
            {"raw_row": {"name": "Kimberly O'brien", "role": "admin", "enabled": ""}, "source_checksum": "c5"},
            {"raw_row": {"name": "Shawn Bly", "role": "owner", "enabled": "TRUE"}, "source_checksum": "c6"},
        ]

    def test_import_user_mapping_dry_run(self):
        sheets_mock = MagicMock()
        sheets_mock._tab_rows.return_value = [r["raw_row"] for r in self.mock_staged_users]
        supabase_mock = MagicMock()

        report = import_user_authorization_mapping(sheets_mock, supabase_mock, dry_run=True)
        self.assertTrue(report["ok"])
        self.assertTrue(report["dry_run"])
        self.assertEqual(report["total_source_rows"], 6)
        self.assertEqual(report["total_app_users_inserted"], 6)
        self.assertEqual(report["total_role_assignments_inserted"], 6)
        supabase_mock.upsert_rows.assert_not_called()

    def test_import_user_mapping_deterministic_ids(self):
        sheets_mock = MagicMock()
        sheets_mock._tab_rows.return_value = [r["raw_row"] for r in self.mock_staged_users]
        supabase_mock = MagicMock()

        report1 = import_user_authorization_mapping(sheets_mock, supabase_mock, dry_run=True)
        report2 = import_user_authorization_mapping(sheets_mock, supabase_mock, dry_run=True)
        ids1 = [u["user_id"] for u in report1["users"]]
        ids2 = [u["user_id"] for u in report2["users"]]
        self.assertEqual(ids1, ids2)

    def test_import_user_mapping_duplicate_handling(self):
        sheets_mock = MagicMock()
        sheets_mock._tab_rows.return_value = [
            {"name": "Ashley Shealey", "role": "admin", "enabled": ""},
            {"name": "ashley shealey", "role": "admin", "enabled": ""},
        ]
        supabase_mock = MagicMock()

        report = import_user_authorization_mapping(sheets_mock, supabase_mock, dry_run=True)
        self.assertEqual(report["total_source_rows"], 2)
        self.assertEqual(report["total_duplicates"], 1)
        self.assertEqual(report["total_app_users_inserted"], 1)

    def test_compare_user_mapping_parity(self):
        sheets_mock = MagicMock()
        sheets_mock._tab_rows.return_value = [r["raw_row"] for r in self.mock_staged_users]
        supabase_mock = MagicMock()
        supabase_mock._request.return_value = [
            {"id": "u1", "auth_user_id": None, "source_user_id": "name:Ashley Shealey", "display_name": "Ashley Shealey", "active": False},
            {"id": "u2", "auth_user_id": None, "source_user_id": "name:Becky Sowles", "display_name": "Becky Sowles", "active": False},
            {"id": "u3", "auth_user_id": None, "source_user_id": "name:Lisa Byrd", "display_name": "Lisa Byrd", "active": False},
            {"id": "u4", "auth_user_id": None, "source_user_id": "name:Kristi Green", "display_name": "Kristi Green", "active": False},
            {"id": "u5", "auth_user_id": None, "source_user_id": "name:Kimberly O'brien", "display_name": "Kimberly O'brien", "active": False},
            {"id": "u6", "auth_user_id": None, "source_user_id": "name:Shawn Bly", "display_name": "Shawn Bly", "active": True},
        ]

        comparison = compare_user_authorization_mapping(sheets_mock, supabase_mock)
        self.assertTrue(comparison["parity_ready"])
        self.assertEqual(comparison["source_count"], 6)
        self.assertEqual(comparison["app_users_count"], 6)
        self.assertEqual(comparison["exact_matches"], 6)
        self.assertEqual(comparison["missing_in_supabase"], 0)
        self.assertEqual(comparison["missing_in_sheets"], 0)
        self.assertEqual(comparison["not_enrolled_count"], 6)
        self.assertEqual(comparison["enrolled_count"], 0)

    def test_compare_user_mapping_detects_mismatch(self):
        sheets_mock = MagicMock()
        sheets_mock._tab_rows.return_value = [r["raw_row"] for r in self.mock_staged_users]
        supabase_mock = MagicMock()
        supabase_mock._request.return_value = [
            {"id": "u1", "auth_user_id": None, "source_user_id": "name:Ashley Shealey", "display_name": "Ashley Shealey", "active": False},
            {"id": "u2", "auth_user_id": None, "source_user_id": "name:Becky Sowles", "display_name": "Becky Sowles", "active": False},
            {"id": "u3", "auth_user_id": None, "source_user_id": "name:Lisa Byrd", "display_name": "Lisa Byrd", "active": False},
            {"id": "u4", "auth_user_id": None, "source_user_id": "name:Kristi Green", "display_name": "Kristi Green", "active": False},
            {"id": "u5", "auth_user_id": None, "source_user_id": "name:Kimberly O'brien", "display_name": "Kimberly O'brien", "active": False},
            {"id": "u6", "auth_user_id": None, "source_user_id": "name:Shawn Bly", "display_name": "Shawn Bly", "active": False},
        ]

        comparison = compare_user_authorization_mapping(sheets_mock, supabase_mock)
        self.assertFalse(comparison["parity_ready"])
        self.assertEqual(comparison["active_mismatches"], 1)
        self.assertEqual(comparison["exact_matches"], 5)


if __name__ == "__main__":
    unittest.main()

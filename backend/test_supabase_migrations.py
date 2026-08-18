import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class SupabaseMigrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = sorted((ROOT / "supabase" / "migrations").glob("*_mts_sam_*.sql"))
        cls.sql = "\n".join(path.read_text(encoding="utf-8") for path in cls.files).lower()

    def test_ordered_migrations_exist(self):
        self.assertGreaterEqual(len(self.files), 6)

    def test_dedicated_schema_and_core_objects_exist(self):
        self.assertIn("create schema if not exists mts_sam", self.sql)
        for table in ("candidate_sessions", "headset_catalog", "headset_reviews", "import_batches", "import_staging_rows", "audit_events"):
            self.assertIn(f"create table mts_sam.{table}", self.sql)

    def test_rls_and_anon_denial_are_explicit(self):
        self.assertIn("enable row level security", self.sql)
        self.assertIn("revoke all on schema mts_sam from public, anon, authenticated", self.sql)
        self.assertNotRegex(self.sql, r"grant\s+(select|insert|update|delete|all|usage)\s+.*\s+to\s+anon")

    def test_views_are_security_invoker(self):
        view_count = len(re.findall(r"create or replace view mts_sam\.", self.sql))
        self.assertGreaterEqual(view_count, 5)
        self.assertGreaterEqual(self.sql.count("security_invoker = true"), view_count)

    def test_no_embedded_secret_shapes(self):
        self.assertNotIn("service_role_key", self.sql)
        self.assertNotRegex(self.sql, r"eyj[a-za-z0-9_-]{20,}")

    def test_lineage_rpc_has_four_deterministic_outcomes_and_narrow_grant(self):
        correction = next(path for path in self.files if "harden_mts_sam_lineage_rpc_outcomes" in path.name)
        sql = correction.read_text(encoding="utf-8").lower()
        for outcome in (
            "inserted",
            "already_exists_same_mapping",
            "conflict_source_maps_to_different_entity",
            "conflict_entity_maps_to_different_source",
        ):
            self.assertIn(outcome, sql)
        self.assertNotIn("conflict_race_skipped", sql)
        self.assertIn("set search_path = ''", sql)
        self.assertIn("from public, anon, authenticated", sql)
        self.assertIn("to service_role", sql)
        self.assertIn("lock table mts_sam.data_source_lineage", sql)

    def test_forward_view_replacements_preserve_existing_column_order(self):
        correction = next(path for path in self.files if "harden_mts_sam_lineage_rpc_outcomes" in path.name)
        sql = re.sub(r"\s+", " ", correction.read_text(encoding="utf-8").lower())
        self.assertIn(
            "select s.id, s.session_id, case ",
            sql,
        )
        self.assertIn(
            "s.attempt_number, s.current_attempt_number, s.allowed_attempt_count, cs.authoritative_status, s.completed_at,",
            sql,
        )


if __name__ == "__main__":
    unittest.main()

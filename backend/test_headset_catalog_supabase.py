import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server


class FakeSupabaseProvider:
    def __init__(self):
        self.catalog = [
            {
                "id": "cat-1",
                "catalog_id": "cat-1",
                "source_row_key": "headset:Logitech:H390",
                "brand": "Logitech",
                "model": "H390",
                "status": "approved",
                "note": "",
                "created_at": "2026-08-01T00:00:00Z",
                "updated_at": "2026-08-01T00:00:00Z",
                "archived_at": None,
                "deleted_at": None,
                "source_payload": {"Brand": "Logitech", "Model": "H390", "Status": "approved", "Note": ""},
                "source_checksum": "abc1",
            },
            {
                "id": "cat-2",
                "catalog_id": "cat-2",
                "source_row_key": "headset:Jabra:Evolve 20",
                "brand": "Jabra",
                "model": "Evolve 20",
                "status": "approved",
                "note": "",
                "created_at": "2026-08-01T00:00:00Z",
                "updated_at": "2026-08-01T00:00:00Z",
                "archived_at": None,
                "deleted_at": None,
                "source_payload": {"Brand": "Jabra", "Model": "Evolve 20", "Status": "approved", "Note": ""},
                "source_checksum": "abc2",
            },
        ]
        self.reviews = [
            {
                "id": "rev-1",
                "review_id": "rev-id-1",
                "source_session_id": "sess-1",
                "candidate_name": "Test Candidate",
                "tester_name": "Test Evaluator",
                "brand": "Sennheiser",
                "model": "PC 8 USB",
                "status": "pending",
                "note": "Candidate submitted during test",
                "denial_reason": "",
                "decision_by": "",
                "decision_at": None,
                "created_at": "2026-08-02T00:00:00Z",
                "updated_at": "2026-08-02T00:00:00Z",
                "source_payload": {"Brand": "Sennheiser", "Model": "PC 8 USB", "Status": "pending"},
                "source_checksum": "revck1",
            }
        ]
        self.review_actions = []

    def list_resource(self, resource, *, filters=None, limit=1000, offset=0):
        if resource == "headset_catalog":
            rows = list(self.catalog)
            if filters:
                for k, v in filters.items():
                    val = v[3:] if isinstance(v, str) and v.startswith("eq.") else v
                    rows = [r for r in rows if str(r.get(k, "")).lower() == str(val).lower()]
            return rows[offset:offset + limit]
        if resource == "headset_reviews":
            rows = list(self.reviews)
            if filters:
                for k, v in filters.items():
                    val = v[3:] if isinstance(v, str) and v.startswith("eq.") else v
                    rows = [r for r in rows if str(r.get(k, "")).lower() == str(val).lower()]
            return rows[offset:offset + limit]
        if resource == "headset_review_actions":
            return list(self.review_actions)[offset:offset + limit]
        return []

    def upsert_rows(self, table, rows, *, on_conflict=None, resolution="merge-duplicates"):
        if table == "headset_catalog":
            for row in rows:
                existing = next(
                    (r for r in self.catalog if r["brand"].lower() == row["brand"].lower() and r["model"].lower() == row["model"].lower()),
                    None
                )
                if existing:
                    existing.update(row)
                else:
                    self.catalog.append(dict(row))
            return rows
        if table == "headset_reviews":
            for row in rows:
                existing = next(
                    (r for r in self.reviews if r["review_id"] == row["review_id"]),
                    None
                )
                if existing:
                    existing.update(row)
                else:
                    self.reviews.append(dict(row))
            return rows
        if table == "headset_review_actions":
            self.review_actions.extend([dict(r) for r in rows])
            return rows
        return rows

    def delete_rows(self, table, query_params, *, max_expected=None):
        if table == "headset_catalog":
            initial_count = len(self.catalog)
            brand_filter = query_params.get("brand", "")
            brand_val = brand_filter[3:] if brand_filter.startswith("eq.") else brand_filter
            model_filter = query_params.get("model", "")
            model_val = model_filter[3:] if model_filter.startswith("eq.") else model_filter
            self.catalog = [
                r for r in self.catalog
                if not (r["brand"].lower() == brand_val.lower() and r["model"].lower() == model_val.lower())
            ]
            return initial_count - len(self.catalog)
        return 0


class TestHeadsetCatalogSupabase(unittest.TestCase):
    def setUp(self):
        self.fake_provider = FakeSupabaseProvider()
        self.orig_cache = dict(server._headset_cache)
        self.orig_content_app = server.EXTERNAL_CONTENT.get("approved_headsets")
        self.orig_content_den = server.EXTERNAL_CONTENT.get("denied_headsets")
        server._headset_cache["groups"] = None
        server._headset_cache["denied"] = None
        server._headset_cache["last_fetch"] = 0

    def tearDown(self):
        server._headset_cache.update(self.orig_cache)
        server.EXTERNAL_CONTENT["approved_headsets"] = self.orig_content_app
        server.EXTERNAL_CONTENT["denied_headsets"] = self.orig_content_den

    def test_fetch_approved_headsets_supabase_mode(self):
        with mock.patch("server.configured_provider_mode", return_value="supabase"), \
             mock.patch("server._get_active_data_provider", return_value=self.fake_provider):
            groups, denied, err = asyncio.run(server._fetch_approved_headsets(force=True))
            self.assertEqual(err, "")
            self.assertEqual(len(groups), 2)
            brands = [g["brand"] for g in groups]
            self.assertIn("Logitech", brands)
            self.assertIn("Jabra", brands)
            self.assertEqual(server._headset_cache["groups"], groups)

    def test_headset_review_action_approve_from_pending(self):
        with mock.patch("server.configured_provider_mode", return_value="supabase"), \
             mock.patch("server._get_active_data_provider", return_value=self.fake_provider):
            payload = {
                "action": "approve",
                "brand": "Sennheiser",
                "model": "PC 8 USB",
                "review_id": "rev-id-1",
                "note": "Verified USB noise canceling",
                "actor": "SamAdmin",
            }
            res = server._headset_review_action(payload)
            self.assertTrue(res.get("ok"))
            self.assertEqual(res.get("status"), "approved")

            # Verify review was updated
            review = next(r for r in self.fake_provider.reviews if r["review_id"] == "rev-id-1")
            self.assertEqual(review["status"], "approved")
            self.assertEqual(review["decision_by"], "SamAdmin")

            # Verify audit action was recorded
            self.assertEqual(len(self.fake_provider.review_actions), 1)
            action = self.fake_provider.review_actions[0]
            self.assertEqual(action["action_type"], "approve")
            self.assertEqual(action["actor_name"], "SamAdmin")

            # Verify catalog entry was created
            cat_rows = [r for r in self.fake_provider.catalog if r["brand"] == "Sennheiser" and r["model"] == "PC 8 USB"]
            self.assertEqual(len(cat_rows), 1)
            self.assertEqual(cat_rows[0]["status"], "approved")
            self.assertEqual(cat_rows[0]["note"], "Verified USB noise canceling")

    def test_headset_review_action_approve_idempotent(self):
        with mock.patch("server.configured_provider_mode", return_value="supabase"), \
             mock.patch("server._get_active_data_provider", return_value=self.fake_provider):
            payload = {
                "action": "approve",
                "brand": "Logitech",
                "model": "H390",
                "note": "Updated note",
                "actor": "SamAdmin",
            }
            # Initial count of Logitech H390 in catalog is 1
            res = server._headset_review_action(payload)
            self.assertTrue(res.get("ok"))
            cat_rows = [r for r in self.fake_provider.catalog if r["brand"].lower() == "logitech" and r["model"].lower() == "h390"]
            self.assertEqual(len(cat_rows), 1, "Must not duplicate catalog rows on re-approval")
            self.assertEqual(cat_rows[0]["note"], "Updated note")

    def test_headset_review_action_deny(self):
        with mock.patch("server.configured_provider_mode", return_value="supabase"), \
             mock.patch("server._get_active_data_provider", return_value=self.fake_provider):
            payload = {
                "action": "deny",
                "brand": "Sennheiser",
                "model": "PC 8 USB",
                "review_id": "rev-id-1",
                "reason": "Headset does not connect via USB",
                "actor": "SamAdmin",
            }
            res = server._headset_review_action(payload)
            self.assertTrue(res.get("ok"))
            self.assertEqual(res.get("status"), "denied")

            review = next(r for r in self.fake_provider.reviews if r["review_id"] == "rev-id-1")
            self.assertEqual(review["status"], "denied")
            self.assertEqual(review["denial_reason"], "Headset does not connect via USB")

            # In catalog, should be marked denied
            cat_rows = [r for r in self.fake_provider.catalog if r["brand"] == "Sennheiser"]
            self.assertEqual(len(cat_rows), 1)
            self.assertEqual(cat_rows[0]["status"], "denied")

    def test_edit_headset_review_supabase(self):
        with mock.patch("server.configured_provider_mode", return_value="supabase"), \
             mock.patch("server._get_active_data_provider", return_value=self.fake_provider):
            payload = {
                "review_id": "rev-id-1",
                "brand": "Sennheiser",
                "model": "SC 60 USB",
                "note": "Corrected model number",
                "actor": "SamAdmin",
            }
            res = server._edit_headset_review(payload)
            self.assertTrue(res.get("ok"))
            self.assertEqual(res.get("model"), "SC 60 USB")

            review = next(r for r in self.fake_provider.reviews if r["review_id"] == "rev-id-1")
            self.assertEqual(review["model"], "SC 60 USB")
            self.assertEqual(review["note"], "Corrected model number")


if __name__ == "__main__":
    unittest.main()

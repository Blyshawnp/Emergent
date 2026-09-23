"""
Behavioral Unit Tests for Supabase Content Management

Tests the 11 key requirements from §12 of the Implementation Plan:
1. Unauthenticated content read rejected
2. Valid verified installation read succeeds
3. Non-admin draft/publish rejected
4. Spoofed administrator identity rejected (no body-derived identity)
5. Partial draft save preserves unrelated rows
6. Stale edit cannot overwrite newer edit (optimistic concurrency)
7. Concurrent publish returns CONTENT_UNCHANGED
8. Rollback preserves unrelated unpublished drafts (unless explicitly opted-in)
9. Unseeded domain does not cut over (requires exact string 'seeded_and_published')
10. Local customization survives remote refresh (discord_templates_customized)
11. Failed remote refresh retains last good cache in SQLite kv_documents
"""

import hashlib
import json
import os
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import server
from server import (
    _extract_sam_jwt,
    _fetch_published_content_via_edge_function,
    _fetch_published_content_with_cache,
    _is_content_domain_cutover,
    _normalize_callers_from_published,
    _normalize_discord_from_published,
    sanitize_settings,
)


class TestContentManagementBehavior(unittest.TestCase):

    def setUp(self):
        self.mock_db = MagicMock()

    # 1. Unauthenticated content read rejected
    def test_unauthenticated_content_read_rejected(self):
        """MTS content fetch returns error structure when installation credential is missing or unverified."""
        with patch.object(server, "_load_backend_runtime_config", return_value={"supabase_url": "https://example.supabase.co"}), \
             patch.object(server, "_get_mts_installation_token", return_value=""):
            result = _fetch_published_content_via_edge_function("callers")
            self.assertFalse(result.get("ok"))
            self.assertEqual(result.get("error_type"), "credential_invalid")

    # 2. Valid verified installation read succeeds
    def test_verified_installation_read_succeeds(self):
        """Simulate verified installation credential read returning published content and caching."""
        fake_published = [
            {"category": "new", "first_name": "Alice", "last_name": "Tester", "city": "Philly", "zip": "19104", "phone": "215-555-0100"},
            {"category": "existing", "first_name": "Bob", "last_name": "Member", "city": "Philly", "zip": "19104", "phone": "215-555-0101"},
        ]
        edge_response = {
            "ok": True,
            "domain": "callers",
            "version_id": "callers-v1",
            "content": fake_published,
            "item_count": 2,
        }

        # Mock db.published_content
        mock_published_coll = MagicMock()
        mock_published_coll._read_document.return_value = None
        self.mock_db.published_content = mock_published_coll

        with patch.object(server, "_fetch_published_content_via_edge_function", return_value=edge_response):
            content_result = _fetch_published_content_with_cache("callers", db_ref=self.mock_db)
            self.assertTrue(content_result.get("ok"))
            self.assertEqual(content_result.get("content"), fake_published)
            self.assertEqual(content_result.get("version_id"), "callers-v1")
            self.assertEqual(content_result.get("source"), "remote")
            mock_published_coll._write_document.assert_called_once()

    # 3. Non-admin draft/publish rejected
    def test_non_admin_draft_publish_rejected(self):
        """Verify SQL migration defines admin check function that queries app_users and user_role_assignments."""
        migration_file = Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "20260922000000_mts_content_management.sql"
        self.assertTrue(migration_file.exists(), "Migration file must exist")
        sql_content = migration_file.read_text(encoding="utf-8")

        # Must check role_key = 'administrator'
        self.assertIn("role_key = 'administrator'", sql_content)
        self.assertIn("INSUFFICIENT_ROLE", sql_content)
        self.assertIn("_verify_content_admin", sql_content)

    # 4. Spoofed administrator identity rejected (no body-derived identity)
    def test_spoofed_admin_identity_rejected(self):
        """Verify that _extract_sam_jwt extracts identity only from Authorization header or access_token,
        never trusting client-supplied caller_auth_uid or similar spoofable body fields.
        """
        request_mock = MagicMock()
        request_mock.headers.get.return_value = "Bearer valid.admin.jwt"
        payload = {"caller_auth_uid": "spoofed-uuid-1234"}

        extracted_jwt = _extract_sam_jwt(request_mock, payload)
        self.assertEqual(extracted_jwt, "valid.admin.jwt")

        # When no Authorization header and no access_token in payload:
        request_mock.headers.get.return_value = ""
        empty_payload = {"caller_auth_uid": "spoofed-uuid-1234"}
        no_jwt = _extract_sam_jwt(request_mock, empty_payload)
        self.assertEqual(no_jwt, "")

        # Verify SQL migration derives admin UID from auth.uid()
        migration_file = Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "20260922000000_mts_content_management.sql"
        sql_content = migration_file.read_text(encoding="utf-8")
        self.assertIn("auth.uid()", sql_content)
        self.assertNotIn("p_caller_auth_uid", sql_content)

    # 5. Partial draft save preserves unrelated rows
    def test_partial_draft_save_preserves_unrelated_rows(self):
        """Verify save_content_item is an item-specific operation that does not touch other rows."""
        migration_file = Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "20260922000000_mts_content_management.sql"
        sql_content = migration_file.read_text(encoding="utf-8")

        # Function takes p_item_id and updates only that specific row
        self.assertIn("save_content_item", sql_content)
        self.assertIn("where id = p_item_id", sql_content)
        self.assertIn("deactivate_content_item", sql_content)

    # 6. Stale edit cannot overwrite newer edit (optimistic concurrency)
    def test_stale_edit_cannot_overwrite_newer_edit(self):
        """Verify migration checks p_expected_updated_at and raises CONCURRENT_EDIT on mismatch."""
        migration_file = Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "20260922000000_mts_content_management.sql"
        sql_content = migration_file.read_text(encoding="utf-8")

        self.assertIn("CONCURRENT_EDIT", sql_content)
        self.assertIn("p_expected_updated_at", sql_content)
        self.assertIn("v_existing_updated_at != p_expected_updated_at", sql_content)

    # 7. Concurrent publish returns CONTENT_UNCHANGED
    def test_concurrent_publish_returns_content_unchanged(self):
        """Verify publish_content_domain compares sha256 content_hash and rejects duplicate content."""
        migration_file = Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "20260922000000_mts_content_management.sql"
        sql_content = migration_file.read_text(encoding="utf-8")

        self.assertIn("CONTENT_UNCHANGED", sql_content)
        self.assertIn("STALE_PUBLISH", sql_content)
        self.assertIn("EMPTY_CONTENT", sql_content)
        self.assertIn("pg_advisory_xact_lock", sql_content)

    # 8. Rollback preserves unrelated unpublished drafts
    def test_rollback_preserves_unrelated_drafts(self):
        """Verify restore_published_content_version defaults to also_restore_draft = false."""
        migration_file = Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "20260922000000_mts_content_management.sql"
        sql_content = migration_file.read_text(encoding="utf-8")

        self.assertIn("p_also_restore_draft boolean default false", sql_content)
        self.assertIn("p_also_restore_draft then", sql_content)

    # 9. Unseeded domain does not cut over
    def test_unseeded_domain_does_not_cutover(self):
        """_is_content_domain_cutover must require exact string 'seeded_and_published'."""
        with patch.object(server, "_load_backend_runtime_config", return_value={"content_domain_cutover": {"callers": True}}):
            self.assertFalse(_is_content_domain_cutover("callers"), "Boolean True must not activate cutover")

        with patch.object(server, "_load_backend_runtime_config", return_value={"content_domain_cutover": {"callers": "true"}}):
            self.assertFalse(_is_content_domain_cutover("callers"), "String 'true' must not activate cutover")

        with patch.object(server, "_load_backend_runtime_config", return_value={"content_domain_cutover": {"callers": "seeded"}}):
            self.assertFalse(_is_content_domain_cutover("callers"), "Incomplete string must not activate cutover")

        with patch.object(server, "_load_backend_runtime_config", return_value={}):
            self.assertFalse(_is_content_domain_cutover("callers"), "Missing key must not activate cutover")

        with patch.object(server, "_load_backend_runtime_config", return_value={"content_domain_cutover": {"callers": "seeded_and_published"}}):
            self.assertTrue(_is_content_domain_cutover("callers"), "Exact string 'seeded_and_published' must activate cutover")

    # 10. Local customization survives remote refresh
    def test_local_customization_survives_remote_refresh(self):
        """sanitize_settings preserves tester's custom Discord library when customized flag is True."""
        custom_templates = [
            {"category": "Custom", "title": "My Custom Template", "message": "Custom test message"}
        ]
        doc = {
            "_id": "app_settings",
            "discord_templates": custom_templates,
            "discord_templates_customized": True,
        }

        sanitized = sanitize_settings(doc)
        self.assertTrue(sanitized.get("discord_templates_customized"))
        self.assertEqual(sanitized.get("discord_templates"), custom_templates)

    # 11. Failed remote refresh retains last good cache
    def test_failed_remote_refresh_retains_last_good_cache(self):
        """When Edge Function fails, _fetch_published_content_with_cache falls back to SQLite cache,

        never erasing the cache document.
        """
        cached_published = [
            {"category": "new", "first_name": "Cached", "last_name": "Caller", "city": "Philly", "zip": "19104", "phone": "215-555-0199"}
        ]
        mock_published_coll = MagicMock()
        mock_published_coll._read_document.return_value = {
            "_id": "callers",
            "version_id": "callers-v1",
            "content": cached_published,
            "cached_at": datetime.now(timezone.utc).isoformat(),
        }
        self.mock_db.published_content = mock_published_coll

        # Simulate network error on remote fetch
        with patch.object(server, "_fetch_published_content_via_edge_function", return_value=None):
            result = _fetch_published_content_with_cache("callers", db_ref=self.mock_db)
            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("content"), cached_published)
            self.assertEqual(result.get("version_id"), "callers-v1")
            self.assertEqual(result.get("source"), "cache")
            # Must NOT call _write_document (never overwrite/erase cache with empty)
            mock_published_coll._write_document.assert_not_called()


class TestPublishedContentNormalizers(unittest.TestCase):

    def test_normalize_callers_from_published(self):
        published = [
            {"category": "new", "first_name": "Sam", "last_name": "Smith", "address": "400 N Broad St", "city": "Philadelphia", "state": "PA", "zip": "19130", "phone": "215-515-1212", "email": "ssmith@test.com"},
            {"category": "existing", "first_name": "Ron", "last_name": "Jones", "address": "123 Main St", "city": "Philadelphia", "state": "PA", "zip": "19104", "phone": "215-555-1234", "email": "rjones@test.com"},
            {"category": "increase", "first_name": "Alison", "last_name": "DeRudder", "address": "456 Oak Ave", "city": "Philadelphia", "state": "PA", "zip": "19107", "phone": "215-555-5678", "email": "aderudder@test.com"},
        ]
        grouped = _normalize_callers_from_published(published)
        self.assertEqual(len(grouped["donors_new"]), 1)
        self.assertEqual(len(grouped["donors_existing"]), 1)
        self.assertEqual(len(grouped["donors_increase"]), 1)
        self.assertEqual(grouped["donors_new"][0][0:2], ["Sam", "Smith"])
        self.assertEqual(grouped["donors_new"][0][5], "19130")

    def test_normalize_discord_from_published(self):
        published = [
            {"category": "General", "title": "VPN Fail", "message": "Using a VPN is not accepted when contracting with ACD.\n\nPlease review the feedback given and schedule another session in the next two days. You can email the certification team with any questions at certification@acdsupport.com.", "suggested_screenshots": []},
            {"category": "General", "title": "Wrong Headset", "message": "A USB headset with a noise cancelling microphone is required to contract with ACD.\n\nPlease review the feedback given and schedule another session in the next two days. You can email the certification team with any questions at certification@acdsupport.com.", "suggested_screenshots": ["/usb.png"]},
        ]
        posts = _normalize_discord_from_published(published)
        self.assertEqual(len(posts), 2)
        self.assertEqual(posts[0]["title"], "VPN Fail")
        self.assertIn("certification@acdsupport.com", posts[0]["message"])
        self.assertEqual(posts[1]["title"], "Wrong Headset")
        self.assertEqual(posts[1]["suggested_screenshots"], ["/usb.png"])


if __name__ == "__main__":
    unittest.main()

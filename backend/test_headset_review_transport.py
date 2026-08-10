import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server


class _AppsScriptClient:
    def __init__(self, post_result=None, post_error=None, get_results=None):
        self.post_result = post_result or {}
        self.post_error = post_error
        self.get_results = get_results or {}
        self.posts = []
        self.gets = []

    def post(self, action, payload):
        self.posts.append((action, payload))
        if self.post_error:
            raise self.post_error
        return dict(self.post_result)

    def get(self, action, _params=None):
        self.gets.append((action, _params))
        if action in self.get_results:
            return dict(self.get_results[action])
        if action == "getHeadsets":
            return {"rows": []}
        return {"rows": []}


class _ValuesApi:
    def __init__(self):
        self.appended = []

    def append(self, **kwargs):
        self.appended.append(kwargs)
        return self

    def execute(self):
        return {}


class _SheetsApi:
    def __init__(self):
        self.values_api = _ValuesApi()

    def values(self):
        return self.values_api


class _Service:
    def __init__(self, sheets_api):
        self.sheets_api = sheets_api

    def spreadsheets(self):
        return self.sheets_api


class HeadsetReviewTransportTests(unittest.TestCase):
    def setUp(self):
        self.original_approved = server.EXTERNAL_CONTENT.get("approved_headsets")
        self.original_denied = server.EXTERNAL_CONTENT.get("denied_headsets")
        server.EXTERNAL_CONTENT["approved_headsets"] = []
        server.EXTERNAL_CONTENT["denied_headsets"] = []
        self.payload = {
            "source_session_id": "session-1",
            "candidate_name": "Candidate Example",
            "tester_name": "Tester Example",
            "headset_model": "ExampleBrand Model 9000",
            "note": "Trainer confirmed the submitted model.",
        }

    def tearDown(self):
        server.EXTERNAL_CONTENT["approved_headsets"] = self.original_approved
        server.EXTERNAL_CONTENT["denied_headsets"] = self.original_denied

    def test_apps_script_creation_uses_stable_id_without_direct_service(self):
        client = _AppsScriptClient()
        with mock.patch.object(server, "_shared_sheet_context", return_value={"ok": True, "appsScriptClient": client}):
            first = server._append_headset_review_log(self.payload)
            second = server._append_headset_review_log(self.payload)

        self.assertTrue(first["ok"])
        self.assertEqual(first["review_id"], second["review_id"])
        self.assertEqual(client.posts[0][0], "submitHeadsetReview")
        self.assertEqual(client.posts[0][1]["source_session_id"], "session-1")
        self.assertEqual(client.posts[0][1]["candidate_name"], "Candidate Example")
        self.assertEqual(client.posts[0][1]["tester_name"], "Tester Example")

    def test_review_id_is_stable_when_spelling_changes_for_same_source_session(self):
        client = _AppsScriptClient()
        with mock.patch.object(server, "_shared_sheet_context", return_value={"ok": True, "appsScriptClient": client}):
            original = server._append_headset_review_log(self.payload)
            corrected = server._append_headset_review_log({**self.payload, "headset_model": "ExampleBrand Model 9001"})
        self.assertEqual(original["review_id"], corrected["review_id"])

    def test_direct_sheets_creation_writes_v2_payload_once(self):
        sheets_api = _SheetsApi()
        context = {
            "ok": True,
            "service": _Service(sheets_api),
            "sheet_id": "masked-in-test",
            "setupStatus": {"statuses": [{"tab": server.HEADSET_REVIEW_LOG_TAB, "schema": "review"}]},
        }
        with mock.patch.object(server, "_shared_sheet_context", return_value=context), \
                mock.patch.object(server, "_shared_read_rows", side_effect=[
                    [{"session_id": "session-1"}],
                    [],
                ]):
            result = server._append_headset_review_log(self.payload)

        self.assertTrue(result["ok"])
        self.assertEqual(len(sheets_api.values_api.appended), 1)
        values = sheets_api.values_api.appended[0]["body"]["values"][0]
        public = dict(zip(server.HEADSET_REVIEW_LOG_HEADERS, values))
        self.assertEqual(public["review_id"], result["review_id"])
        self.assertEqual(public["source_session_id"], "session-1")
        self.assertEqual(public["Status"], "pending")
        self.assertEqual(public["Brand"], "ExampleBrand")
        self.assertEqual(public["Model"], "Model 9000")

    def test_direct_creation_reuses_existing_source_review_after_spelling_correction(self):
        sheets_api = _SheetsApi()
        context = {
            "ok": True, "service": _Service(sheets_api), "sheet_id": "masked-in-test",
            "setupStatus": {"statuses": [{"tab": server.HEADSET_REVIEW_LOG_TAB, "schema": "review"}]},
        }
        existing = dict(zip(server.HEADSET_REVIEW_LOG_HEADERS, [
            "existing-review", "session-1", "Candidate Example", "Tester Example",
            "ExampleBrand", "Corrected Model", "pending", "", "created", "updated", "", "", "",
        ]))
        existing["_row_number"] = 2
        with mock.patch.object(server, "_shared_sheet_context", return_value=context), \
                mock.patch.object(server, "_shared_read_rows", side_effect=[
                    [{"session_id": "session-1"}],
                    [existing],
                ]):
            result = server._append_headset_review_log(self.payload)
        self.assertTrue(result["ok"])
        self.assertEqual(result["reason"], "duplicate_pending")
        self.assertEqual(result["review_id"], "existing-review")
        self.assertEqual(result["model"], "Corrected Model")
        self.assertEqual(sheets_api.values_api.appended, [])

    def test_direct_creation_rejects_missing_parent_session(self):
        sheets_api = _SheetsApi()
        context = {
            "ok": True, "service": _Service(sheets_api), "sheet_id": "masked-in-test",
            "setupStatus": {"statuses": [{"tab": server.HEADSET_REVIEW_LOG_TAB, "schema": "review"}]},
        }
        with mock.patch.object(server, "_shared_sheet_context", return_value=context), \
                mock.patch.object(server, "_shared_read_rows", return_value=[]):
            result = server._append_headset_review_log(self.payload)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "parent_session_unavailable")
        self.assertEqual(sheets_api.values_api.appended, [])

    def test_approved_headset_and_invalid_request_do_not_create_rows(self):
        server.EXTERNAL_CONTENT["approved_headsets"] = [{"brand": "ExampleBrand", "models": ["Model 9000"]}]
        approved = server._append_headset_review_log(self.payload)
        invalid = server._append_headset_review_log({"headset_model": "Unknown Model"})
        self.assertEqual(approved["reason"], "approved_headset")
        self.assertFalse(invalid["ok"])
        self.assertEqual(invalid["error"], "Headset review request data is incomplete.")

    def test_transport_failure_is_sanitized(self):
        client = _AppsScriptClient(post_error=RuntimeError("raw transport payload that must stay private"))
        with mock.patch.object(server, "_shared_sheet_context", return_value={"ok": True, "appsScriptClient": client}):
            result = server._append_headset_review_log(self.payload)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "Headset review request could not be submitted.")
        self.assertNotIn("raw transport", result["error"])

    def test_session_start_assigns_final_parent_identity_without_remote_write(self):
        background_tasks = mock.Mock()
        payload = {**self.payload, "headset_review_requested": True}
        with mock.patch.object(server.db.sessions, "replace_one", new=mock.AsyncMock()) as replace_one, \
                mock.patch.object(server.db.sessions, "update_one", new=mock.AsyncMock()) as update_one, \
                mock.patch.object(server, "_append_headset_review_log") as remote_append:
            result = asyncio.run(server.start_session(payload, None, background_tasks))

        self.assertTrue(result["ok"])
        self.assertEqual(result["session"]["headset_review_sync_status"], "pending")
        self.assertEqual(result["session"]["history_id"], result["session"]["session_id"])
        replace_one.assert_awaited_once()
        update_one.assert_awaited_once()
        background_tasks.add_task.assert_not_called()
        remote_append.assert_not_called()

    def test_finished_resumed_session_sync_reuses_source_session_and_review_identity(self):
        session = {
            "session_id": "continuation-1", "resume_source_history_id": "session-1",
            "headset_review_id": "review-1", "candidate_name": "Candidate Example",
            "tester_name": "Tester Example", "headset_brand": "SYNTHETIC USB MIGRATION HEADSET",
        }
        append = mock.Mock(return_value={"ok": True, "review_id": "review-1", "status": "pending"})
        with mock.patch.object(server, "_append_headset_review_log", append):
            result = asyncio.run(server._sync_finished_session_headset_review(session))
        submitted = append.call_args.args[0]
        self.assertTrue(result["ok"])
        self.assertEqual(submitted["review_id"], "review-1")
        self.assertEqual(submitted["source_session_id"], "session-1")

    def test_finished_session_prefers_final_history_identity_over_transient_session_id(self):
        session = {
            "session_id": "transient-1", "history_id": "stable-1",
            "candidate_name": "Candidate Example", "tester_name": "Tester Example",
            "headset_brand": "SYNTHETIC USB MIGRATION HEADSET",
        }
        append = mock.Mock(return_value={"ok": True, "review_id": "review-1", "status": "pending"})
        with mock.patch.object(server, "_append_headset_review_log", append):
            result = asyncio.run(server._sync_finished_session_headset_review(session))
        self.assertTrue(result["ok"])
        self.assertEqual(append.call_args.args[0]["source_session_id"], "stable-1")

    def test_direct_candidate_deletion_rejects_linked_headset_review(self):
        sheets_api = _SheetsApi()
        context = {
            "ok": True, "service": _Service(sheets_api), "sheet_id": "masked-in-test",
            "setupStatus": {"statuses": [{"tab": server.HEADSET_REVIEW_LOG_TAB, "schema": "review"}]},
        }
        candidate = {"session_id": "session-1", "candidate_name": "Candidate Example", "_row_number": 2}
        review = {"review_id": "review-1", "source_session_id": "session-1", "_row_number": 2}
        with mock.patch.object(server, "_shared_sheet_context", return_value=context), \
                mock.patch.object(server, "_shared_read_rows", side_effect=[[candidate], [], [review]]):
            result = server._shared_admin_candidate_action({
                "action": "delete_candidate_history",
                "targets": [{"session_id": "session-1"}],
            })
        self.assertFalse(result["ok"])
        self.assertIn("linked headset review", result["error"].lower())
        self.assertEqual(sheets_api.values_api.appended, [])

    def test_finish_writes_candidate_parent_before_headset_review(self):
        events = []
        doc = {
            "session_id": "active-1", "history_id": "stable-1",
            "candidate_name": "Candidate Example", "tester_name": "Tester Example",
            "headset_brand": "SYNTHETIC USB MIGRATION HEADSET",
            "headset_review_requested": True, "headset_review_sync_status": "pending",
        }
        saved = {**doc, "status": "Incomplete", "final_status": "Incomplete"}
        background_review = mock.AsyncMock(side_effect=lambda _row: (
            events.append("review") or {"ok": True, "review_id": "review-1", "status": "pending"}
        ))
        with mock.patch.object(server.db.sessions, "find_one", new=mock.AsyncMock(return_value=doc)), \
                mock.patch.object(server.db.sessions, "delete_one", new=mock.AsyncMock()), \
                mock.patch.object(server, "_upsert_history_record", new=mock.AsyncMock(return_value=(saved, "inserted"))), \
                mock.patch.object(server, "_sync_shared_candidate_tracking", side_effect=lambda _row: (
                    events.append("parent") or {"ok": True}
                )), \
                mock.patch.object(server, "_sync_finished_session_headset_review", new=background_review), \
                mock.patch.object(server, "_update_saved_history_fields", return_value=True), \
                mock.patch.object(server.db, "backup"):
            result = asyncio.run(server.finish_session_simple(None))
        self.assertTrue(result["ok"])
        self.assertEqual(events, ["parent", "review"])
        self.assertEqual(result["record"]["headset_review_sync_status"], "synced")
        self.assertEqual(result["record"]["headset_review_id"], "review-1")

    def test_apps_script_decision_targets_stable_review_id(self):
        client = _AppsScriptClient({"updated": True})
        payload = {
            "action": "approve",
            "review_id": "review-1",
            "brand": "ExampleBrand",
            "model": "Model 9000",
            "actor": "SAM Admin",
        }
        with mock.patch.object(server, "_shared_sheet_context", return_value={"ok": True, "appsScriptClient": client}):
            result = server._headset_review_action(payload)
        self.assertTrue(result["ok"])
        self.assertEqual(client.posts[0][0], "approveHeadset")
        self.assertEqual(client.posts[0][1]["review_id"], "review-1")
        self.assertEqual(client.posts[0][1]["actor"], "SAM Admin")

    def test_apps_script_edit_targets_exact_review_and_preserves_pending_state(self):
        client = _AppsScriptClient({
            "updated": True, "review_id": "review-1", "source_session_id": "session-1",
            "brand": "SYNTHETIC USB", "model": "MIGRATION HEADSET", "status": "pending",
        })
        with mock.patch.object(server, "_shared_sheet_context", return_value={"ok": True, "appsScriptClient": client}):
            result = server._headset_review_action({
                "action": "edit", "review_id": "review-1", "brand": "SYNTHETIC USB",
                "model": "  MIGRATION   HEADSET ", "note": "Corrected", "actor": "SAM Admin",
            })
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "pending")
        self.assertEqual(client.posts[0][0], "editHeadsetReview")
        self.assertEqual(client.posts[0][1]["review_id"], "review-1")

    def test_apps_script_snapshot_exposes_exact_catalog_identity_without_schema_change(self):
        client = _AppsScriptClient(get_results={
            "getHeadsetReviewLog": {"rows": []},
            "getSheetRange": {"values": [
                server.HEADSETS_HEADERS,
                ["ExampleBrand", "Model 9000", "approved", "Catalog note"],
            ]},
        })
        with mock.patch.object(server, "_shared_sheet_context", return_value={"ok": True, "appsScriptClient": client}):
            result = server._headset_review_snapshot()

        self.assertTrue(result["ok"])
        self.assertEqual(len(result["approved"]), 1)
        row = result["approved"][0]
        self.assertEqual(row["catalog_row_number"], 2)
        self.assertTrue(row["catalog_identity"].startswith("headset-catalog-"))
        self.assertEqual(row["brand"], "ExampleBrand")
        self.assertEqual(row["model"], "Model 9000")
        self.assertIn(("getSheetRange", {"range": "'headsets'!A:D"}), client.gets)

    def test_apps_script_catalog_delete_targets_one_exact_physical_row(self):
        values = [
            server.HEADSETS_HEADERS,
            ["DeleteBrand", "Delete Model", "approved", "Delete note"],
            ["KeepBrand", "Keep Model", "approved", "Keep note"],
        ]
        identity = server._headset_catalog_identity(2, "DeleteBrand", "Delete Model", "approved", "Delete note")
        client = _AppsScriptClient(
            post_result={"replies": [{"deleteDimension": {"deletedRows": 1}}]},
            get_results={
                "getSheetRange": {"values": values},
                "getSheetMetadata": {"sheets": [{"properties": {"title": "headsets", "sheetId": 777}}]},
            },
        )
        with mock.patch.object(server, "_shared_sheet_context", return_value={"ok": True, "appsScriptClient": client}):
            result = server._headset_review_action({
                "action": "delete",
                "catalog_identity": identity,
                "catalog_row_number": 2,
                "brand": "DeleteBrand",
                "model": "Delete Model",
            })

        self.assertTrue(result["ok"])
        self.assertTrue(result["deleted"])
        self.assertEqual(result["changed_rows"], 1)
        self.assertEqual(client.posts[0][0], "batchUpdateSpreadsheet")
        delete_range = client.posts[0][1]["requests"][0]["deleteDimension"]["range"]
        self.assertEqual(delete_range, {
            "sheetId": 777, "dimension": "ROWS", "startIndex": 1, "endIndex": 2,
        })

    def test_catalog_mutation_rejects_stale_identity_without_broad_fallback(self):
        client = _AppsScriptClient(get_results={
            "getSheetRange": {"values": [
                server.HEADSETS_HEADERS,
                ["KeepBrand", "Keep Model", "approved", "Current note"],
            ]},
        })
        with mock.patch.object(server, "_shared_sheet_context", return_value={"ok": True, "appsScriptClient": client}):
            result = server._headset_review_action({
                "action": "delete",
                "catalog_identity": "headset-catalog-stale",
                "catalog_row_number": 2,
                "brand": "KeepBrand",
                "model": "Keep Model",
            })

        self.assertFalse(result["ok"])
        self.assertEqual(client.posts, [])
        self.assertEqual(result["error"], "This approved headset changed after it was loaded. Refresh Headset Review and try again.")

    def test_apps_script_catalog_deny_updates_only_the_exact_row_and_preserves_schema(self):
        values = [
            server.HEADSETS_HEADERS,
            ["DenyBrand", "Deny Model", "approved", "Original note"],
        ]
        identity = server._headset_catalog_identity(2, "DenyBrand", "Deny Model", "approved", "Original note")
        client = _AppsScriptClient(
            post_result={"updated": True, "updatedRows": 1},
            get_results={"getSheetRange": {"values": values}},
        )
        with mock.patch.object(server, "_shared_sheet_context", return_value={"ok": True, "appsScriptClient": client}):
            result = server._headset_review_action({
                "action": "deny",
                "catalog_identity": identity,
                "catalog_row_number": 2,
                "brand": "DenyBrand",
                "model": "Deny Model",
                "reason": "Other",
                "note": "Exact denial note",
            })

        self.assertTrue(result["ok"])
        self.assertEqual(result["previous_status"], "approved")
        self.assertEqual(result["new_status"], "denied")
        self.assertEqual(client.posts[0], (
            "updateSheetRange",
            {
                "range": "'headsets'!A2:D2",
                "values": [["DenyBrand", "Deny Model", "denied", "Exact denial note"]],
            },
        ))

    def test_direct_sheets_decision_updates_matching_review_id_and_headset_list(self):
        sheets_api = _SheetsApi()
        context = {
            "ok": True,
            "service": _Service(sheets_api),
            "sheet_id": "masked-in-test",
            "setupStatus": {"statuses": [{"tab": server.HEADSET_REVIEW_LOG_TAB, "schema": "review"}]},
        }
        review_row = dict(zip(server.HEADSET_REVIEW_LOG_HEADERS, [
            "review-1", "session-1", "Candidate Example", "Tester Example",
            "ExampleBrand", "Model 9000", "pending", "Trainer note",
            "2026-07-15T12:00:00+00:00", "2026-07-15T12:00:00+00:00", "", "", "",
        ]))
        review_row["_row_number"] = 2

        with mock.patch.object(server, "_shared_sheet_context", return_value=context), \
                mock.patch.object(server, "_shared_read_rows", return_value=[review_row]), \
                mock.patch.object(server, "_read_headsets_rows", return_value=[]), \
                mock.patch.object(server, "_shared_update_existing_row") as update_row, \
                mock.patch.object(server, "_sync_headset_content_cache"):
            result = server._headset_review_action({
                "action": "deny",
                "review_id": "review-1",
                "brand": "ExampleBrand",
                "model": "Model 9000",
                "reason": "Headset does not connect via USB",
                "actor": "SAM Admin",
            })

        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], "denied")
        update_row.assert_called_once()
        update_args = update_row.call_args.args
        self.assertEqual(update_args[2], server.HEADSET_REVIEW_LOG_TAB)
        self.assertEqual(update_args[4], 2)
        updated_review = dict(zip(server.HEADSET_REVIEW_LOG_HEADERS, update_args[5]))
        self.assertEqual(updated_review["review_id"], "review-1")
        self.assertEqual(updated_review["Status"], "denied")
        self.assertEqual(updated_review["decision_by"], "SAM Admin")
        self.assertEqual(sheets_api.values_api.appended[0]["body"]["values"][0], [
            "ExampleBrand", "Model 9000", "denied", "Headset does not connect via USB",
        ])

    def test_direct_approval_uses_authoritative_corrected_row_not_stale_card_values(self):
        sheets_api = _SheetsApi()
        context = {
            "ok": True, "service": _Service(sheets_api), "sheet_id": "masked-in-test",
            "setupStatus": {"statuses": [{"tab": server.HEADSET_REVIEW_LOG_TAB, "schema": "review"}]},
        }
        review_row = dict(zip(server.HEADSET_REVIEW_LOG_HEADERS, [
            "review-1", "session-1", "Candidate Example", "Tester Example",
            "SYNTHETIC USB", "MIGRATION HEADSET", "pending", "", "created", "updated", "", "", "",
        ]))
        review_row["_row_number"] = 2
        with mock.patch.object(server, "_shared_sheet_context", return_value=context), \
                mock.patch.object(server, "_shared_read_rows", return_value=[review_row]), \
                mock.patch.object(server, "_read_headsets_rows", return_value=[]), \
                mock.patch.object(server, "_shared_update_existing_row"), \
                mock.patch.object(server, "_sync_headset_content_cache"):
            result = server._headset_review_action({
                "action": "approve", "review_id": "review-1",
                "brand": "SYNTHETIC USB", "model": "MIGRATION HEDSET", "actor": "SAM Admin",
            })
        self.assertTrue(result["ok"])
        self.assertEqual(sheets_api.values_api.appended[0]["body"]["values"][0][:2], ["SYNTHETIC USB", "MIGRATION HEADSET"])


if __name__ == "__main__":
    unittest.main()

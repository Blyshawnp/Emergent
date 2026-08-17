from __future__ import annotations

import json
import time
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from .base import DataProvider, ProviderHealth, RESOURCE_TABLES


class SupabaseProviderError(RuntimeError):
    """A redacted Supabase provider failure."""


class SupabaseDataProvider(DataProvider):
    name = "supabase"
    lineage_write_mode = "rpc_only"
    _RECONCILIATION_RPCS = frozenset({
        "begin_reconciliation_execution", "execute_reconciliation_insert",
        "execute_reconciliation_candidate_session_update",
        "execute_reconciliation_candidate_correction_update", "fail_reconciliation_batch",
        "finalize_reconciliation_batch", "preview_reconciliation_rollback",
        "rollback_reconciliation_batch", "preview_reconciliation_retry_eligibility",
    })

    def __init__(self, url: str, service_role_key: str, *, timeout: float = 10.0, retries: int = 2):
        self._url = str(url or "").rstrip("/")
        self._key = str(service_role_key or "")
        self._timeout = max(1.0, float(timeout))
        self._retries = max(0, int(retries))
        self._comparison_cache = {}
        self._comparison_deadline = None
        if not self._url.startswith("https://") or not self._key:
            raise ValueError("Supabase backend configuration is incomplete")

    def __repr__(self) -> str:
        return "SupabaseDataProvider(configured=True)"

    def set_comparison_deadline(self, seconds):
        """Apply one absolute deadline across a runtime shadow domain projection."""
        self._comparison_deadline = time.monotonic() + max(1.0, float(seconds))

    def _request_timeout(self):
        if self._comparison_deadline is None:
            return self._timeout
        remaining = self._comparison_deadline - time.monotonic()
        if remaining <= 0:
            raise SupabaseProviderError("Supabase shadow comparison deadline exceeded")
        return max(0.05, min(self._timeout, remaining))

    def _request(self, path: str, *, query: Mapping[str, Any] | None = None, method="GET", body=None, prefer=None):
        encoded_path = "/".join(quote(segment, safe="") for segment in str(path).split("/"))
        url = f"{self._url}/rest/v1/{encoded_path}"
        if query:
            url += "?" + urlencode({str(k): str(v) for k, v in query.items()})
        headers = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            "Accept": "application/json",
            "Accept-Profile": "mts_sam",
        }
        if body is not None:
            headers["Content-Type"] = "application/json"
        if method in ("POST", "PATCH", "DELETE") or body is not None:
            headers["Content-Profile"] = "mts_sam"
        if prefer:
            headers["Prefer"] = prefer
        encoded_body = json.dumps(body, separators=(",", ":"), default=str).encode("utf-8") if body is not None else None
        request = Request(url, method=method, headers=headers, data=encoded_body)
        for attempt in range(self._retries + 1):
            try:
                with urlopen(request, timeout=self._request_timeout()) as response:
                    return json.loads(response.read().decode("utf-8-sig"))
            except HTTPError as exc:
                try:
                    err_body = exc.read().decode("utf-8-sig")
                except Exception:
                    err_body = "Unable to read error body"
                if exc.code < 500 or attempt >= self._retries:
                    raise SupabaseProviderError(f"Supabase request failed with HTTP {exc.code}: {err_body}") from exc
            except (TimeoutError, URLError) as exc:
                if attempt >= self._retries:
                    raise SupabaseProviderError("Supabase request timed out or was unavailable") from exc
            time.sleep(0.15 * (2**attempt))
        raise SupabaseProviderError("Supabase request failed")

    def insert_lineage_if_absent(self, row: Mapping[str, Any]):
        """Call the sole trusted lineage RPC in the private mts_sam schema."""
        required = (
            "entity_type", "entity_id", "source_system", "source_tab",
            "source_row_key", "source_checksum", "import_batch_id",
        )
        missing = [key for key in required if row.get(key) in (None, "")]
        if missing:
            raise ValueError(f"Lineage RPC payload is incomplete: {','.join(missing)}")
        result = self._request(
            "rpc/insert_lineage_if_absent",
            method="POST",
            body={
                "p_entity_type": row["entity_type"],
                "p_entity_id": row["entity_id"],
                "p_source_system": row["source_system"],
                "p_source_tab": row["source_tab"],
                "p_source_row_key": row["source_row_key"],
                "p_source_checksum": row["source_checksum"],
                "p_import_batch_id": row["import_batch_id"],
                "p_metadata": dict(row.get("metadata") or {}),
                "p_reconciliation_batch_id": row.get("reconciliation_batch_id"),
                "p_reconciliation_plan_item_id": row.get("reconciliation_plan_item_id"),
            },
        )
        if not isinstance(result, dict) or not isinstance(result.get("result"), str):
            raise SupabaseProviderError("Supabase lineage RPC returned a malformed response")
        return result

    def _reconciliation_rpc(self, name: str, body: Mapping[str, Any]):
        if name not in self._RECONCILIATION_RPCS:
            raise ValueError("Unsupported reconciliation RPC")
        result = self._request(f"rpc/{name}", method="POST", body=dict(body))
        if not isinstance(result, dict) or not isinstance(result.get("result"), str):
            raise SupabaseProviderError(f"Supabase {name} RPC returned a malformed response")
        return result

    def begin_reconciliation_execution(self, plan, items):
        return self._reconciliation_rpc(
            "begin_reconciliation_execution", self._reconciliation_execution_body(plan, items)
        )

    def _reconciliation_execution_body(self, plan, items):
        counts = plan.get("canonical_operations") or {}
        accounted = {"candidates", "candidate_sessions", "session_attempts", "headset_catalog", "headset_reviews",
                     "supervisor_transfers", "newbie_shift_requests", "pending_requests"}
        ending = {name: values.get("expected_ending_count") for name, values in (plan.get("entity_counts") or {}).items()
                  if name in accounted}
        return {
            "p_project_ref": plan["project_ref"], "p_source_snapshot_at": plan.get("source_snapshot_timestamp") or plan["generated_at"],
            "p_source_snapshot_checksum": plan["source_snapshot_checksum"], "p_plan_checksum": plan["plan_checksum"],
            "p_plan_expires_at": plan["expires_at"], "p_provider_state": plan["provider_state"],
            "p_source_rows": plan.get("source_rows_considered") or 0, "p_inserts": counts.get("inserts") or 0,
            "p_updates": counts.get("updates") or 0, "p_lineage": (plan.get("lineage_operations") or {}).get("expected_new") or 0,
            "p_expected_ending_counts": ending, "p_actor_metadata": {"client": "supabase_import_cli", "plan_bound": True},
            "p_target_preconditions": dict(plan.get("_private_target_preconditions") or {}),
            "p_items": list(items),
        }

    def preview_reconciliation_retry_eligibility(self, plan, items):
        body = self._reconciliation_execution_body(plan, items)
        result = self._request(
            "rpc/preview_reconciliation_retry_eligibility",
            method="POST",
            body={key: body[key] for key in (
                "p_project_ref", "p_source_snapshot_checksum", "p_plan_checksum",
                "p_plan_expires_at", "p_provider_state", "p_items",
                "p_target_preconditions",
            )},
        )
        if (
            not isinstance(result, dict)
            or not isinstance(result.get("eligible"), bool)
            or not isinstance(result.get("blockers"), list)
            or not isinstance(result.get("result"), str)
        ):
            raise SupabaseProviderError("Supabase retry eligibility RPC returned a malformed response")
        return result

    def execute_reconciliation_insert(self, batch_id, item_id, payload, expected, lineage):
        return self._reconciliation_rpc("execute_reconciliation_insert", {
            "p_batch_id": batch_id, "p_plan_item_id": item_id, "p_payload": dict(payload),
            "p_expected_values": dict(expected), "p_lineage": dict(lineage),
        })

    def execute_reconciliation_candidate_session_update(self, batch_id, item_id, precondition, changes, expected):
        return self._reconciliation_rpc("execute_reconciliation_candidate_session_update", {
            "p_batch_id": batch_id, "p_plan_item_id": item_id, "p_precondition": dict(precondition),
            "p_changes": dict(changes), "p_expected_values": dict(expected),
        })

    def execute_reconciliation_candidate_correction_update(self, batch_id, item_id, precondition, changes, expected):
        return self._reconciliation_rpc("execute_reconciliation_candidate_correction_update", {
            "p_batch_id": batch_id, "p_plan_item_id": item_id, "p_precondition": dict(precondition),
            "p_changes": dict(changes), "p_expected_values": dict(expected),
        })

    def fail_reconciliation_batch(self, batch_id, item_id, error_code):
        return self._reconciliation_rpc("fail_reconciliation_batch", {
            "p_batch_id": batch_id, "p_plan_item_id": item_id, "p_error_code": str(error_code)[:120],
        })

    def finalize_reconciliation_batch(self, batch_id):
        return self._reconciliation_rpc("finalize_reconciliation_batch", {"p_batch_id": batch_id})

    def preview_reconciliation_rollback(self, batch_id):
        result = self._request(
            "rpc/preview_reconciliation_rollback",
            method="POST",
            body={"p_batch_id": batch_id},
        )
        if (
            not isinstance(result, dict)
            or not isinstance(result.get("eligible"), bool)
            or not isinstance(result.get("blockers"), list)
        ):
            raise SupabaseProviderError("Supabase rollback preview RPC returned a malformed response")
        return result

    def rollback_reconciliation_batch(self, batch_id):
        return self._reconciliation_rpc("rollback_reconciliation_batch", {"p_batch_id": batch_id})

    def upsert_rows(self, table: str, rows, *, on_conflict: str, resolution: str = "merge-duplicates"):
        if table == "data_source_lineage":
            raise ValueError("Direct lineage table writes are forbidden; use insert_lineage_if_absent")
        ALLOWED_WRITE_TABLES = {
            "import_batches", "import_staging_rows", "import_row_results", "reconciliation_results",
            "app_users", "app_roles", "user_role_assignments", "application_settings", "sync_state",
            "audit_events", "candidates", "candidate_sessions", "session_attempts",
            "candidate_status_actions", "candidate_corrections", "extra_attempt_grants", "supervisor_transfers",
            "newbie_shift_requests", "newbie_shift_reschedules", "headset_catalog", "headset_reviews",
            "headset_review_actions", "pending_requests", "notifications", "notification_deliveries",
            "activity_events", "synchronization_events"
        }
        if table not in ALLOWED_WRITE_TABLES:
            raise ValueError(f"Unsupported Supabase write table: {table}")
        if not rows:
            return []
        result = self._request(
            table,
            query={"on_conflict": on_conflict},
            method="POST",
            body=list(rows),
            prefer=f"resolution={resolution},return=representation",
        )
        if not isinstance(result, list):
            raise SupabaseProviderError("Supabase returned an invalid upsert response")
        return result

    def delete_rows(self, table: str, query_params: Mapping[str, Any], *, max_expected: int | None = None) -> int:
        ALLOWED_DELETE_TABLES = {
            "import_batches", "import_staging_rows", "import_row_results", "reconciliation_results",
            "app_users", "app_roles", "user_role_assignments", "application_settings", "sync_state",
            "audit_events", "data_source_lineage", "candidates", "candidate_sessions", "session_attempts",
            "candidate_status_actions", "candidate_corrections", "extra_attempt_grants", "supervisor_transfers",
            "newbie_shift_requests", "newbie_shift_reschedules", "headset_catalog", "headset_reviews",
            "headset_review_actions", "pending_requests", "notifications", "notification_deliveries",
            "activity_events", "synchronization_events"
        }
        if table not in ALLOWED_DELETE_TABLES:
            raise ValueError(f"Unsupported Supabase delete table: {table}")
        if not query_params:
            raise ValueError("Empty delete query filters are rejected to prevent broad deletions")
        try:
            result = self._request(
                table,
                query=query_params,
                method="DELETE",
                prefer="return=representation"
            )
        except Exception as exc:
            raise SupabaseProviderError(f"Supabase delete failed on {table}: {exc}") from exc
        if not isinstance(result, list):
            raise SupabaseProviderError(f"Supabase delete returned invalid response format for {table}")
        deleted_count = len(result)
        if max_expected is not None and deleted_count > max_expected:
            raise SupabaseProviderError(
                f"Delete safety check failed: deleted {deleted_count} rows, which exceeds max expected of {max_expected}"
            )
        return deleted_count

    def health(self) -> ProviderHealth:
        try:
            self._request("sync_state", query={"select": "provider", "limit": 1})
            return ProviderHealth(True, self.name, "ready")
        except SupabaseProviderError as exc:
            return ProviderHealth(False, self.name, str(exc))

    def list_resource(self, resource, *, filters=None, limit=1000, offset=0):
        if str(resource) == "candidates" and not filters:
            return self._list_candidate_projection(limit=limit, offset=offset)
        if str(resource) == "pending_requests" and not filters:
            return self._list_request_projection(limit=limit, offset=offset)
        if str(resource) == "recent_activity" and not filters:
            requests = self._list_request_projection(limit=5000, offset=0)
            projected = [{
                **row,
                "event_id": row.get("request_id"),
                "event_key": row.get("request_id"),
                "event_type": row.get("request_type"),
                "occurred_at": row.get("updated_at") or row.get("created_at"),
                "source_entity_id": row.get("source_session_id"),
            } for row in requests]
            projected.sort(key=lambda row: str(row.get("occurred_at") or ""), reverse=True)
            return projected[offset:offset + limit]
        table = RESOURCE_TABLES.get(str(resource))
        if not table:
            raise ValueError(f"Unsupported canonical resource: {resource}")
        if limit < 1 or limit > 5000 or offset < 0:
            raise ValueError("Invalid pagination")
        query = {"select": "*", "limit": limit, "offset": offset}
        for key, value in (filters or {}).items():
            if not str(key).replace("_", "").isalnum():
                raise ValueError("Invalid filter field")
            query[str(key)] = f"eq.{value}"
        result = self._request(table, query=query)
        if not isinstance(result, list):
            raise SupabaseProviderError("Supabase returned an invalid resource response")
        if str(resource) == "headset_catalog":
            result = [{
                **row,
                "selectable": row.get("status") == "approved" and not row.get("archived_at") and not row.get("deleted_at"),
                "archived": bool(row.get("archived_at")) or row.get("status") == "archived",
                "deleted": bool(row.get("deleted_at")) or row.get("status") == "deleted",
            } for row in result]
        elif str(resource) == "history":
            statuses = self._cached_read("current_candidate_status_view", {"select": "*", "limit": 5000})
            status_by_session = {str(row.get("session_id") or ""): row.get("authoritative_status") for row in statuses}
            result = [{**row, "authoritative_status": status_by_session.get(str(row.get("session_id") or ""))} for row in result]
        elif str(resource) == "candidate_tracking":
            result = [{**row, "category": self._tracking_category(row)} for row in result]
        return result

    @staticmethod
    def _tracking_category(row):
        if row.get("archived"):
            return "archived"
        if row.get("needs_sup_transfer"):
            return "pending_supervisor_transfer"
        if str(row.get("newbie_shift_request_status") or "").strip().casefold() == "pending":
            return "newbie_shift"
        status = str(row.get("authoritative_status") or "").strip().casefold().replace("_", "-")
        if "final" in status and "fail" in status:
            return "failed_final_attempt"
        if status in {"fail", "failed"}:
            return "failed_not_final"
        if status in {"pass", "passed", "resumed-pass"}:
            return "passed"
        if "withdrew" in status or "withdrawn" in status:
            return "withdrawn"
        return "incomplete"

    def _cached_read(self, table, query):
        key = (table, tuple(sorted((str(k), str(v)) for k, v in query.items())))
        if key not in self._comparison_cache:
            result = self._request(table, query=query)
            if not isinstance(result, list):
                raise SupabaseProviderError(f"Supabase returned invalid comparison rows for {table}")
            self._comparison_cache[key] = result
        return self._comparison_cache[key]

    def _list_candidate_projection(self, *, limit, offset):
        candidates = self._cached_read("candidates", {"select": "*", "limit": 5000})
        history = self._cached_read("candidate_history_view", {"select": "*", "limit": 5000})
        lineage = self._cached_read(
            "data_source_lineage",
            {"select": "entity_id,source_row_key", "entity_type": "eq.candidates", "limit": 5000},
        )
        latest_by_candidate = {}
        for row in history:
            candidate_id = str(row.get("candidate_id") or "")
            stamp = str(row.get("completed_at") or row.get("updated_at") or "")
            current = latest_by_candidate.get(candidate_id)
            if current is None or stamp >= current[0]:
                latest_by_candidate[candidate_id] = (stamp, row)
        lineage_by_candidate = {
            str(row.get("entity_id") or ""): str(row.get("source_row_key") or "")
            for row in lineage
        }
        projected = []
        for candidate in candidates:
            candidate_id = str(candidate.get("id") or "")
            latest = latest_by_candidate.get(candidate_id, ("", {}))[1]
            projected.append({
                **candidate,
                "latest_session_id": latest.get("session_id"),
                "authoritative_status": latest.get("authoritative_status"),
                "archived": latest.get("archived"),
                "lineage_identity": lineage_by_candidate.get(candidate_id, ""),
            })
        return projected[offset:offset + limit]

    def _list_request_projection(self, *, limit, offset):
        generic = self._cached_read("pending_requests", {"select": "*", "limit": 5000})
        newbie = self._cached_read("newbie_shift_requests", {"select": "*", "limit": 5000})
        corrections = self._cached_read("candidate_corrections", {"select": "*", "limit": 5000})
        projected = []
        for row in generic:
            request_type = row.get("request_type") or "candidate_deletion"
            category = row.get("category")
            if not category:
                category = {
                    "candidate_deletion": "candidate-deletion-requests",
                    "candidate_information_correction": "candidate-information-correction-requests",
                    "initial_newbie_shift": "newbie-shift-requests",
                }.get(str(request_type).strip().casefold(), request_type)
            projected.append({
                **row,
                "request_type": request_type,
                "category": category,
                "request_status": row.get("status"),
            })
        for row in newbie:
            projected.append({
                **row,
                "request_type": row.get("request_type") or "initial_newbie_shift",
                "category": "newbie-shift-requests",
                "status": row.get("request_status"),
            })
        for row in corrections:
            projected.append({
                **row,
                "request_type": row.get("request_type") or "candidate_information_correction",
                "category": "candidate-information-correction-requests",
                "request_status": row.get("status"),
            })
        by_request = {}
        for row in projected:
            request_id = str(row.get("request_id") or "").strip()
            category = str(row.get("category") or "").strip()
            if request_id and category:
                by_request[(category, request_id)] = row
        ordered = sorted(
            by_request.values(),
            key=lambda row: str(row.get("updated_at") or row.get("decision_at") or row.get("created_at") or ""),
            reverse=True,
        )
        return ordered[offset:offset + limit]

"""
Mock Testing Suite - FastAPI Backend
All routes in a single file for simplicity. Uses SQLite for local persistence.
"""
import os
import json
import sys
import logging
import sqlite3
import shutil
import threading
import csv
import io
import re
import hmac
import hashlib
import time
import uuid
import secrets
import ipaddress
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager
from functools import lru_cache
from zoneinfo import ZoneInfo
import urllib.request
import urllib.error
import urllib.parse
from urllib.parse import quote, urlparse
from urllib.request import urlopen

import httpx
from fastapi import FastAPI, APIRouter, BackgroundTasks, HTTPException, Request
import asyncio
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel
from services.form_filler import fill_form as fill_cert_form
from data_providers.runtime_shadow import (
    ShadowComparisonRuntime,
    build_runtime_shadow_providers,
)
from data_providers.dual_write import get_dual_write_manager, is_dual_write_enabled
from data_providers.factory import configured_provider_mode, build_data_provider
from data_providers.supabase import SupabaseDataProvider
from services.apps_script_api import apps_script_api_role

ROOT_DIR = Path(__file__).parent
if (ROOT_DIR / '.env').is_file():
    load_dotenv(ROOT_DIR / '.env', override=False)
if (ROOT_DIR.parent / '.env').is_file():
    load_dotenv(ROOT_DIR.parent / '.env', override=False)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)
logger.info("[STARTUP] backend process start")

_shadow_runtime = None
_cached_active_provider = None


def _get_active_data_provider():
    global _cached_active_provider
    mode = configured_provider_mode()
    if mode == "supabase":
        if _cached_active_provider is None or not isinstance(_cached_active_provider, SupabaseDataProvider):
            _cached_active_provider = build_data_provider()
        return _cached_active_provider
    elif mode == "sheets":
        ctx = _shared_sheet_context()
        client = ctx.get("appsScriptClient") or ctx.get("service")
        return build_data_provider(sheets_client=client)
    return build_data_provider()


def _runtime_shadow_provider_factory(config):
    return build_runtime_shadow_providers(
        ROOT_DIR,
        apps_script_api_role(),
        config,
    )


def _schedule_shadow_domains(*domains):
    runtime = _shadow_runtime
    if runtime is None:
        return []
    submit_many = getattr(runtime, "submit_many", None)
    if callable(submit_many):
        try:
            return [submit_many(domains)]
        except Exception as exc:
            logger.warning(
                "[DATA-SHADOW] domains=%s scheduling_failed=%s",
                len(domains), exc.__class__.__name__,
            )
            return ["shadow_error"]
    outcomes = []
    for domain in domains:
        try:
            outcomes.append(runtime.submit(domain))
        except Exception as exc:
            logger.warning(
                "[DATA-SHADOW] domain=%s scheduling_failed=%s",
                str(domain or ""), exc.__class__.__name__,
            )
            outcomes.append("shadow_error")
    return outcomes

# ══════════════════════════════════════════════════════════════════
# CONSTANTS / DEFAULTS
# ══════════════════════════════════════════════════════════════════
DEFAULT_APP_VERSION = "1.0.1"
DEFAULT_NOTIFICATION_SHEET_URL = "https://docs.google.com/spreadsheets/d/1OkDE9SxnNA0WEHa-TeiZ3b2j5AZ9qiJi1Hv4Lmn8YSE/edit?gid=0#gid=0"
ADMIN_TOKEN_HEADER = "X-MTS-Admin-Token"
# Paths or path prefixes that do NOT require the packaged admin token.
# Entries are matched as prefixes (so "/api/settings" will exempt "/api/settings/*").
AUTH_EXEMPT_PATHS = {
    # Lightweight public startup checks
    "/api/health",
    # Public settings and defaults used by frontend during startup
    "/api/settings",
    "/api/settings/defaults",
    # Help content
    "/api/help/content",
    # Session/lookup endpoints used on startup
    "/api/session/current",
    "/api/shared/candidates/lookup",
    "/api/shared/pending-sup-transfers",
    # Normal user session history
    "/api/history",
    # SAM setup steps that must be callable during initial configuration
    "/api/sam/setup/status",
    "/api/sam/setup/complete",
}


def _require_admin_token(request: Request):
    expected = (os.getenv("MTS_ADMIN_TOKEN") or "").strip()
    provided = (request.headers.get(ADMIN_TOKEN_HEADER) or "").strip()
    if not expected or not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=403, detail="Admin access is required for this endpoint.")


def _admin_token_configured():
    return bool((os.getenv("MTS_ADMIN_TOKEN") or "").strip())


def _is_loopback_request(request: Request):
    host = ""
    try:
        host = (request.client.host or "").strip().lower()
    except Exception:
        host = ""
    return host in {"127.0.0.1", "localhost", "::1"}


def _is_development_mode():
    env_values = [
        os.getenv("MTS_DEV_MODE"),
        os.getenv("MTS_DEBUG"),
        os.getenv("APP_ENV"),
        os.getenv("ENV"),
    ]
    normalized = {str(value or "").strip().lower() for value in env_values}
    return bool(normalized & {"1", "true", "yes", "development", "dev", "debug"})


def _can_use_local_diagnostic_auth_fallback(request: Request):
    return _is_loopback_request(request) and _is_development_mode()


def _safe_file_label(value):
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        return Path(text).name
    except Exception:
        return ""


def _load_desktop_app_version():
    env_version = (os.getenv("APP_VERSION") or "").strip()
    if env_version:
        return env_version

    package_json = ROOT_DIR.parent / "desktop" / "package.json"
    try:
        with package_json.open("r", encoding="utf-8") as f:
            return (json.load(f).get("version") or "").strip() or DEFAULT_APP_VERSION
    except Exception as exc:
        logger.warning("[STARTUP] Failed to read desktop/package.json version: %s", exc)
        return DEFAULT_APP_VERSION


APP_VERSION = _load_desktop_app_version()
DEFAULT_SQLITE_FILENAME = "mock_testing_suite.sqlite3"
DEFAULT_CERT_SHEET_URL = "https://acddirect-my.sharepoint.com/:x:/p/becky_sowles/IQDxXC0z-rUHS6oowjotk0e6AZeldAj2eFiqT8oNiOEAWjA?rtime=5Q1giSl33kg"


def _resolve_sqlite_path():
    configured_path = (os.getenv("SQLITE_DB_PATH") or "").strip()
    if configured_path:
        return Path(configured_path).expanduser()

    app_data_dir = (os.getenv("APP_DATA_DIR") or "").strip()
    if app_data_dir:
        return Path(app_data_dir).expanduser() / DEFAULT_SQLITE_FILENAME

    return ROOT_DIR / "data" / DEFAULT_SQLITE_FILENAME


def _is_packaged_runtime():
    return bool(getattr(sys, "frozen", False)) or bool((os.getenv("APP_RESOURCES_PATH") or "").strip())


def _packaged_runtime_mode():
    return "packaged" if _is_packaged_runtime() else "dev"


def _packaged_log_dir():
    configured = (os.getenv("BACKEND_LOG_DIR") or "").strip()
    if configured:
        return Path(configured).expanduser()
    sqlite_path = _resolve_sqlite_path()
    if sqlite_path:
        return sqlite_path.expanduser().resolve().parent / "logs"
    return ROOT_DIR / "logs"


def _configure_packaged_file_logging():
    if not _is_packaged_runtime():
        return ""
    try:
        log_dir = _packaged_log_dir()
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / "backend-packaged.log"
        existing_paths = {
            str(getattr(handler, "baseFilename", "") or "")
            for handler in logging.getLogger().handlers
        }
        if str(log_path) not in existing_paths:
            file_handler = logging.FileHandler(log_path, encoding="utf-8")
            file_handler.setLevel(logging.INFO)
            file_handler.setFormatter(logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s"))
            logging.getLogger().addHandler(file_handler)
        return str(log_path)
    except Exception as exc:
        logger.warning("[STARTUP] Unable to configure packaged backend file logging: %s", exc)
        return ""


PACKAGED_BACKEND_LOG_PATH = _configure_packaged_file_logging()


class SQLiteCursor:
    def __init__(self, collection, docs, projection=None):
        self.collection = collection
        self.docs = docs
        self.projection = projection

    def sort(self, field, direction):
        reverse = direction < 0
        self.docs.sort(key=lambda doc: str(doc.get(field, "")), reverse=reverse)
        return self

    async def to_list(self, length):
        docs = self.docs if length is None else self.docs[:length]
        return [self.collection.project(doc, self.projection) for doc in docs]


class SQLiteCollection:
    def __init__(self, store, name):
        self.store = store
        self.name = name

    @staticmethod
    def clone(doc):
        return json.loads(json.dumps(doc or {}, ensure_ascii=False, default=str))

    @staticmethod
    def encode(doc):
        return json.dumps(SQLiteCollection.clone(doc), ensure_ascii=False, default=str)

    @staticmethod
    def decode(data):
        if isinstance(data, dict):
            return SQLiteCollection.clone(data)
        return json.loads(data or "{}")

    @classmethod
    def project(cls, doc, projection=None):
        projected = cls.clone(doc)
        if projection and projection.get("_id") == 0:
            projected.pop("_id", None)
        return projected

    def _read_document(self, doc_id):
        row = self.store.fetchone(
            "SELECT data FROM kv_documents WHERE collection = ? AND doc_id = ?",
            (self.name, doc_id),
        )
        return json.loads(row["data"]) if row else None

    def _write_document(self, doc):
        document = self.clone(doc)
        doc_id = document.get("_id")
        if not doc_id:
            raise ValueError(f"{self.name} documents require an _id")
        self.store.execute(
            """
            INSERT INTO kv_documents (collection, doc_id, data, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(collection, doc_id) DO UPDATE SET
                data = excluded.data,
                updated_at = CURRENT_TIMESTAMP
            """,
            (self.name, str(doc_id), json.dumps(document, ensure_ascii=False, default=str)),
        )

    async def find_one(self, query=None, projection=None):
        query = query or {}
        if self.name == "history":
            docs = self._read_history_docs()
            for doc in docs:
                if all(doc.get(key) == value for key, value in query.items()):
                    return self.project(doc, projection)
            return None

        doc_id = query.get("_id")
        if not doc_id:
            return None
        doc = self._read_document(str(doc_id))
        return self.project(doc, projection) if doc else None

    async def insert_one(self, doc):
        document = self.clone(doc)
        if self.name == "history":
            document.pop("_id", None)
            self.store.execute(
                "INSERT INTO history_documents (data, timestamp, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
                (
                    json.dumps(document, ensure_ascii=False, default=str),
                    str(document.get("timestamp_iso") or document.get("timestamp") or ""),
                ),
            )
            return

        self._write_document(document)

    async def update_one(self, query, update, upsert=False):
        query = query or {}
        existing = await self.find_one(query)
        if not existing and not upsert:
            return

        doc_id = query.get("_id") or (existing or {}).get("_id")
        document = existing or {"_id": doc_id}
        if "$set" in update or "$unset" in update:
            values = update.get("$set", {})
            document.update(self.clone(values))
            for key in (update.get("$unset") or {}).keys():
                document.pop(key, None)
        else:
            values = update
            document.update(self.clone(values))
        self._write_document(document)

    async def replace_one(self, query, replacement, upsert=False):
        query = query or {}
        existing = await self.find_one(query)
        if not existing and not upsert:
            return

        document = self.clone(replacement)
        if "_id" not in document and query.get("_id"):
            document["_id"] = query["_id"]
        self._write_document(document)

    async def delete_one(self, query):
        query = query or {}
        if self.name == "history":
            return

        doc_id = query.get("_id")
        if not doc_id:
            return
        self.store.execute(
            "DELETE FROM kv_documents WHERE collection = ? AND doc_id = ?",
            (self.name, str(doc_id)),
        )

    async def delete_many(self, query=None):
        query = query or {}
        if self.name == "history" and not query:
            self.store.execute("DELETE FROM history_documents")
            return
        if not query:
            self.store.execute("DELETE FROM kv_documents WHERE collection = ?", (self.name,))

    def _read_history_docs(self):
        rows = self.store.fetchall(
            "SELECT data FROM history_documents ORDER BY id ASC",
            (),
        )
        return [json.loads(row["data"]) for row in rows]

    def find(self, query=None, projection=None):
        query = query or {}
        if self.name == "history":
            docs = self._read_history_docs()
        else:
            rows = self.store.fetchall(
                "SELECT data FROM kv_documents WHERE collection = ?",
                (self.name,),
            )
            docs = [json.loads(row["data"]) for row in rows]

        if query:
            docs = [
                doc for doc in docs
                if all(doc.get(key) == value for key, value in query.items())
            ]
        return SQLiteCursor(self, docs, projection)


class SQLiteDocumentStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.conn = self._connect_with_recovery()
        self.conn.row_factory = sqlite3.Row
        self._initialize_schema()
        self.settings = SQLiteCollection(self, "settings")
        self.sessions = SQLiteCollection(self, "sessions")
        self.history = SQLiteCollection(self, "history")
        logger.info("[STARTUP] SQLite database: %s", self.path)

    def _backup_corrupt_database(self, reason):
        if not self.path.exists():
            return ""
        backup_path = self.path.with_suffix(f".corrupt-{datetime.now().strftime('%Y%m%d-%H%M%S')}.sqlite3")
        try:
            shutil.copy2(self.path, backup_path)
            logger.error("[STARTUP] Backed up unreadable SQLite database to %s: %s", backup_path, reason)
            return str(backup_path)
        except Exception as exc:
            logger.error("[STARTUP] Failed to back up unreadable SQLite database %s: %s", self.path, exc)
            return ""

    def _connect_with_recovery(self):
        try:
            conn = sqlite3.connect(self.path, check_same_thread=False)
            integrity = conn.execute("PRAGMA integrity_check").fetchone()
            if not integrity or str(integrity[0]).lower() != "ok":
                try:
                    conn.close()
                except Exception:
                    pass
                return self._recover_confirmed_corrupt_database(integrity[0] if integrity else "unknown integrity failure")
            return conn
        except sqlite3.DatabaseError as exc:
            if not self._corruption_confirmed_by_integrity_check(exc):
                logger.error("[STARTUP] SQLite open failed without confirmed corruption. Database was not deleted: %s", exc)
                raise
            return self._recover_confirmed_corrupt_database(exc)

    def _corruption_confirmed_by_integrity_check(self, original_exc):
        if not self.path.exists():
            return False
        try:
            probe = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True, check_same_thread=False)
            try:
                integrity = probe.execute("PRAGMA integrity_check").fetchone()
            finally:
                probe.close()
            return bool(integrity and str(integrity[0]).lower() != "ok")
        except sqlite3.DatabaseError as probe_exc:
            message = f"{original_exc} {probe_exc}".lower()
            corruption_markers = (
                "database disk image is malformed",
                "file is not a database",
                "database is corrupt",
                "malformed database schema",
            )
            return any(marker in message for marker in corruption_markers)
        except sqlite3.Error as probe_exc:
            logger.error("[STARTUP] SQLite integrity check could not confirm corruption: %s", probe_exc)
            return False

    def _recover_confirmed_corrupt_database(self, reason):
        self._backup_corrupt_database(reason)
        try:
            self.path.unlink(missing_ok=True)
        except Exception as unlink_exc:
            logger.error("[STARTUP] Failed to remove confirmed-corrupt SQLite database %s: %s", self.path, unlink_exc)
            raise
        return sqlite3.connect(self.path, check_same_thread=False)

    def _initialize_schema(self):
        with self.lock, self.conn:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA synchronous=NORMAL")
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS kv_documents (
                    collection TEXT NOT NULL,
                    doc_id TEXT NOT NULL,
                    data TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (collection, doc_id)
                )
                """
            )
            self.conn.execute(
                """
                CREATE TABLE IF NOT EXISTS history_documents (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    data TEXT NOT NULL,
                    timestamp TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            self.conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history_documents (timestamp DESC, id DESC)"
            )

    def execute(self, sql, params=()):
        with self.lock, self.conn:
            return self.conn.execute(sql, params)

    def fetchone(self, sql, params=()):
        with self.lock:
            return self.conn.execute(sql, params).fetchone()

    def fetchall(self, sql, params=()):
        with self.lock:
            return self.conn.execute(sql, params).fetchall()

    async def has_any_data(self):
        kv_count = self.fetchone("SELECT COUNT(*) AS count FROM kv_documents")["count"]
        history_count = self.fetchone("SELECT COUNT(*) AS count FROM history_documents")["count"]
        return kv_count > 0 or history_count > 0

    def backup(self, label="backup"):
        if not self.path.exists():
            return ""
        backup_dir = self.path.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        safe_label = re.sub(r"[^a-zA-Z0-9_-]+", "-", str(label or "backup")).strip("-") or "backup"
        backup_path = backup_dir / f"{self.path.stem}-{safe_label}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.sqlite3"
        with self.lock:
            target = sqlite3.connect(backup_path)
            try:
                self.conn.backup(target)
            finally:
                target.close()
        logger.info("[SQLITE] Backup created: %s", backup_path)
        return str(backup_path)

    def close(self):
        with self.lock:
            self.conn.close()


db = SQLiteDocumentStore(_resolve_sqlite_path())


DEFAULTS_DIR_NAME = "defaults"
DEFAULT_ADMIN_CONTENT_SHEET_URL = "https://docs.google.com/spreadsheets/d/1R5ccO5BvKWj4lY5OHUX6K03bVzFF0wdjuUCki3Og6VA/edit?gid=1461356416#gid=1461356416"
DEFAULT_HELP_DOC_URL = "https://docs.google.com/document/d/1OkU-j6IJMV9foXKqiWaSnqmYPQXPMyuC9p0WjJX2yLI/edit?tab=t.0"
DEFAULT_FAQ_DOC_URL = "https://docs.google.com/document/d/1gRXHn3hB8mXaogqNX14NZ7NtN7gYdLXGTyNuOs6Siu8/edit?tab=t.0"

DEFAULTS_FILE_MAP = {
    "callers": "callers.csv",
    "shows": "shows.csv",
    "call_types": "call-types.csv",
    "sup_reasons": "sup-reasons.csv",
    "call_coaching": "call-coaching.csv",
    "sup_coaching": "sup-coaching.csv",
    "call_fails": "call-fail-reasons.csv",
    "sup_fails": "sup-fail-reasons.csv",
    "discord_templates": "discord-posts.csv",
    "discord_screenshots": "screenshots.csv",
    "approved_headsets": "headsets.csv",
    "help_markdown": "help.md",
    "faq_markdown": "faq.md",
    "admin_setup_markdown": "admin-setup.md",
    "mts_tutorial_videos": "mts-tutorial-videos.csv",
    "sam_tutorial_videos": "sam-tutorial-videos.csv",
    "gemini_coaching_prompt": "gemini-coaching-prompt.md",
    "gemini_fail_prompt": "gemini-fail-prompt.md",
}

CONTENT_SHEET_TAB_MAP = {
    "callers": "callers",
    "shows": "shows",
    "call_types": "call-types",
    "sup_reasons": "sup-reasons",
    "call_coaching": "call-coaching",
    "sup_coaching": "sup-coaching",
    "call_fails": "call-fail-reasons",
    "sup_fails": "sup-fail-reasons",
    "discord_templates": "discord-posts",
    "discord_screenshots": "screenshots",
    "approved_headsets": "headsets",
    "mts_tutorial_videos": "mts-tutorial-videos",
    "sam_tutorial_videos": "sam-tutorial-videos",
    "gemini_coaching_prompt": "gemini-coaching-prompt",
    "gemini_fail_prompt": "gemini-fail-prompt",
}

CONTENT_SHEET_TAB_ALIASES = {
    "callers": ("Callers",),
    "shows": ("Shows",),
    "call_coaching": ("coaching", "call-coaching"),
    "call_fails": ("fail reasons", "call-fails", "call-fail-reasons"),
    "sup_fails": ("sup-fail-reasons", "sup-fails"),
}

LOCAL_DEFAULT_FILE_ALIASES = {
    "headsets.csv": ("approved-headsets.csv",),
    "call-fail-reasons.csv": ("call-fails.csv",),
    "sup-fail-reasons.csv": ("sup-fails.csv",),
}


def _runtime_config_candidates():
    candidates = []
    configured_runtime = (os.getenv("BACKEND_RUNTIME_CONFIG_FILE") or "").strip()
    if configured_runtime:
        candidates.append(Path(configured_runtime).expanduser())
    resources_root = (os.getenv("APP_RESOURCES_PATH") or "").strip()
    if resources_root:
        candidates.append(Path(resources_root) / "backend" / "config" / "runtime_config.json")
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            candidates.append(Path(meipass) / "config" / "runtime_config.json")
        candidates.append(Path(sys.executable).resolve().parent / "config" / "runtime_config.json")
    candidates.append(ROOT_DIR / "config" / "runtime_config.json")
    return candidates


_runtime_config_status = {
    "path": "",
    "found": False,
    "error": "",
}

_defaults_status = {
    "path": "",
    "found": False,
}

_ticker_fetch_status = {
    "source": "builtin",
    "status": "not fetched",
    "timestamp": "",
    "message_count": 0,
}

# Per-section source tracking. Populated by content loaders during startup so
# /api/config-status and the startup log can show admins where each piece of
# content came from. Values: source in {google, local_csv, local_json,
# emergency_hardcoded}; served_from
# is computed lazily at request time (sqlite vs memory).
_content_source_status = {}
_google_sheet_auth_status = {
    "ok": False,
    "status": "not_attempted",
    "credentials_configured": False,
    "client_email_configured": False,
    "private_key_id_configured": False,
    "last_tab": "",
    "last_error": "",
    "timestamp": "",
}
_google_sheet_content_errors = []
_startup_runtime_diagnostics = {}


def _content_count(value):
    if isinstance(value, list):
        return len(value)
    if isinstance(value, dict):
        return len(value)
    if isinstance(value, str):
        return sum(1 for line in value.splitlines() if line.strip())
    return 0


def _set_content_source(section_key, source, value=None, *, ok=True, detail=""):
    _content_source_status[section_key] = {
        "source": source,
        "count": _content_count(value),
        "ok": bool(ok),
        "detail": str(detail or ""),
    }


def _is_meaningful_gemini_prompt_text(value):
    text = str(value or "").strip()
    words = re.findall(r"[A-Za-z0-9]+", text)
    return len(text) >= 80 and len(words) >= 12


def _normalize_gemini_prompt_for_compare(value):
    lines = []
    previous_blank = False
    for raw_line in str(value or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = re.sub(r"[ \t]+", " ", raw_line.strip())
        if not line:
            if not previous_blank:
                lines.append("")
            previous_blank = True
            continue
        lines.append(line)
        previous_blank = False
    return "\n".join(lines).strip()


# Canonical list of content sections tracked across loaders. Keep in sync with
# DEFAULTS_FILE_MAP / CONTENT_SHEET_TAB_MAP plus the donor sub-keys produced by
# _normalize_callers and the markdown keys produced by the Help/FAQ doc loader.
TRACKED_CONTENT_KEYS = (
    "donors_new",
    "donors_existing",
    "donors_increase",
    "call_types",
    "sup_reasons",
    "shows",
    "call_coaching",
    "sup_coaching",
    "call_fails",
    "sup_fails",
    "discord_templates",
    "discord_screenshots",
    "approved_headsets",
    "denied_headsets",
    "help_markdown",
    "faq_markdown",
    "admin_setup_markdown",
    "mts_tutorial_videos",
    "sam_tutorial_videos",
    "gemini_coaching_prompt",
    "gemini_fail_prompt",
)


def _mask_config_value(value):
    text = str(value or "").strip()
    if not text:
        return ""
    sheet_id = _extract_google_sheet_id(text)
    if sheet_id:
        masked_id = sheet_id[:6] + "..." + sheet_id[-4:] if len(sheet_id) > 12 else "***"
        return text.replace(sheet_id, masked_id)
    if len(text) <= 16:
        return "***"
    return f"{text[:8]}...{text[-4:]}"


def _status_timestamp():
    return datetime.now(timezone.utc).isoformat()


def _set_ticker_fetch_status(source, status, message_count=0):
    _ticker_fetch_status.update({
        "source": source,
        "status": status,
        "timestamp": _status_timestamp(),
        "message_count": int(message_count or 0),
    })
    logger.info(
        "[TICKER] Source=%s valid_rows=%s status=%s",
        str(source or "unknown").upper(),
        int(message_count or 0),
        status,
    )


def _defaults_dir_candidates():
    candidates = []
    resources_root = (os.getenv("APP_RESOURCES_PATH") or "").strip()
    if resources_root:
        candidates.append(Path(resources_root) / "backend" / DEFAULTS_DIR_NAME)
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            candidates.append(Path(meipass) / DEFAULTS_DIR_NAME)
        candidates.append(Path(sys.executable).resolve().parent / DEFAULTS_DIR_NAME)
    candidates.append(ROOT_DIR / DEFAULTS_DIR_NAME)
    return candidates


def _admin_content_csv_tab_candidates():
    candidates = []
    resources_root = (os.getenv("APP_RESOURCES_PATH") or "").strip()
    if resources_root:
        candidates.append(Path(resources_root) / "docs" / "admin-content-package" / "csv-tabs")
        candidates.append(Path(resources_root) / "admin-content-package" / "csv-tabs")
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            candidates.append(Path(meipass) / "docs" / "admin-content-package" / "csv-tabs")
            candidates.append(Path(meipass) / "admin-content-package" / "csv-tabs")
        candidates.append(Path(sys.executable).resolve().parent / "docs" / "admin-content-package" / "csv-tabs")
        candidates.append(Path(sys.executable).resolve().parent / "admin-content-package" / "csv-tabs")
    candidates.append(ROOT_DIR.parent / "docs" / "admin-content-package" / "csv-tabs")
    return candidates


def _local_default_source_dirs():
    seen = set()
    sources = []
    for label, candidates in (
        ("admin-content-package csv-tabs", _admin_content_csv_tab_candidates()),
        ("backend/defaults", _defaults_dir_candidates()),
    ):
        for candidate in candidates:
            try:
                normalized = str(candidate.resolve())
            except Exception:
                normalized = str(candidate)
            if normalized.lower() in seen:
                continue
            seen.add(normalized.lower())
            if candidate.is_dir():
                sources.append((label, candidate))
                break
    return sources


def _resolve_defaults_dir():
    for candidate in _defaults_dir_candidates():
        if candidate.is_dir():
            _defaults_status.update({"path": str(candidate), "found": True})
            return candidate
    _defaults_status.update({"path": "", "found": False})
    return None


def _extract_google_doc_id(value):
    text = str(value or "").strip()
    if not text:
        return ""

    match = re.search(r"/document/d/([a-zA-Z0-9-_]+)", text)
    if match:
        return match.group(1)

    parsed = urlparse(text)
    if parsed.scheme or "/" in text:
        return ""
    return text


def _extract_google_sheet_id(value):
    text = str(value or "").strip()
    if not text:
        return ""

    match = re.search(r"/spreadsheets/d/([a-zA-Z0-9-_]+)", text)
    if match:
        return match.group(1)

    parsed = urlparse(text)
    if parsed.scheme or "/" in text:
        return ""
    return text


def _resolve_content_sheet_id(runtime_config):
    candidates = [
        runtime_config.get("admin_content_sheet_id"),
        runtime_config.get("admin_content_sheet_url"),
        runtime_config.get("content_sheet_id"),
        runtime_config.get("content_sheet_url"),
        DEFAULT_ADMIN_CONTENT_SHEET_URL,
    ]

    for candidate in candidates:
        sheet_id = _extract_google_sheet_id(candidate)
        if sheet_id:
            return sheet_id
    return ""


def _resolve_google_doc_id(runtime_config, url_keys, id_keys, fallback_url=""):
    candidates = []
    for key in id_keys:
        candidates.append((runtime_config or {}).get(key))
    for key in url_keys:
        candidates.append((runtime_config or {}).get(key))
    if fallback_url:
        candidates.append(fallback_url)

    for candidate in candidates:
        doc_id = _extract_google_doc_id(candidate)
        if doc_id:
            return doc_id
    return ""


def _fetch_google_sheet_tab_csv(sheet_id, tab_name):
    authenticated_text = _fetch_google_sheet_tab_csv_authenticated(sheet_id, tab_name)
    if authenticated_text:
        return authenticated_text

    action = APPS_SCRIPT_CONTENT_ACTIONS.get(str(tab_name or "").strip().lower())
    if action:
        try:
            from services.apps_script_api import create_apps_script_sheet_service

            service_result = create_apps_script_sheet_service(ROOT_DIR)
            if service_result.get("ok"):
                rows = _apps_script_rows(service_result["client"], action)
                csv_text = _apps_script_rows_to_csv(rows)
                if csv_text:
                    logger.info("[CONTENT] Loaded managed content '%s' through Apps Script.", tab_name)
                    return csv_text
        except Exception as exc:
            logger.info(
                "[CONTENT] Apps Script managed-content read was unavailable for '%s'; trying legacy CSV export: %s",
                tab_name,
                exc,
            )

    encoded_tab_name = quote(tab_name, safe="")
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv&sheet={encoded_tab_name}"
    with urlopen(url, timeout=10) as response:
        return response.read().decode("utf-8-sig")


def _early_service_account_file():
    resources_root = (os.getenv("APP_RESOURCES_PATH") or "").strip()
    resource_config_dir = Path(resources_root) / "backend" / "config" if resources_root else None
    candidates = [
        os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE"),
        os.getenv("GOOGLE_APPLICATION_CREDENTIALS"),
        str(resource_config_dir / "google-service-account.json") if resource_config_dir else "",
        str(resource_config_dir / "service-account.json") if resource_config_dir else "",
        str(Path(sys.executable).resolve().parent / "config" / "google-service-account.json") if getattr(sys, "frozen", False) else "",
        str(Path(sys.executable).resolve().parent / "config" / "service-account.json") if getattr(sys, "frozen", False) else "",
        str(ROOT_DIR / "config" / "google-service-account.json"),
        str(ROOT_DIR / "config" / "service-account.json"),
    ]
    for candidate in candidates:
        path_text = str(candidate or "").strip()
        if not path_text:
            continue
        path = Path(path_text).expanduser()
        if path.is_file():
            return path
    return None


def _read_service_account_public_info(path):
    info = {
        "exists": False,
        "configured": bool(path),
        "file": _safe_file_label(path),
        "client_email_configured": False,
        "private_key_id_configured": False,
        "error": "",
    }
    if not path:
        return info
    try:
        resolved = Path(path).expanduser()
        info["file"] = resolved.name
        info["exists"] = resolved.is_file()
        if not info["exists"]:
            return info
        with resolved.open("r", encoding="utf-8") as f:
            data = json.load(f)
        info["client_email_configured"] = bool(str(data.get("client_email") or "").strip())
        info["private_key_id_configured"] = bool(str(data.get("private_key_id") or "").strip())
    except Exception as exc:
        info["error"] = str(exc)
    return info


def _record_google_sheet_auth_status(status, *, ok=False, path=None, tab_name="", error=""):
    public_info = _read_service_account_public_info(path) if path else {}
    _google_sheet_auth_status.update({
        "ok": bool(ok),
        "status": str(status or ""),
        "credentials_configured": bool(path or public_info.get("configured")),
        "client_email_configured": bool(public_info.get("client_email_configured") or _google_sheet_auth_status.get("client_email_configured")),
        "private_key_id_configured": bool(public_info.get("private_key_id_configured") or _google_sheet_auth_status.get("private_key_id_configured")),
        "last_tab": str(tab_name or ""),
        "last_error": str(error or public_info.get("error") or ""),
        "timestamp": _status_timestamp(),
    })


def _record_google_sheet_content_error(content_key, tab_name, error):
    _google_sheet_content_errors.append({
        "content_key": str(content_key or ""),
        "tab": str(tab_name or ""),
        "error": str(error or ""),
        "timestamp": _status_timestamp(),
    })
    if len(_google_sheet_content_errors) > 50:
        del _google_sheet_content_errors[:-50]


APPS_SCRIPT_CONTENT_ACTIONS = {
    "headsets": "getHeadsets",
    "screenshots": "getScreenshots",
    "discord-posts": "getDiscordPosts",
    "mts-tutorial-videos": "getMtsTutorialVideos",
    "sam-tutorial-videos": "getSamTutorialVideos",
    "settings": "getSettings",
    "notification-recipients": "getNotificationRecipients",
}


def _is_missing_apps_script_route_error(error):
    text = str(error or "").casefold()
    return "unknown action" in text or "compatibility route is unavailable" in text


def _apps_script_rows(client, action, params=None):
    result = client.get(action, params or {})
    rows = result.get("rows") if isinstance(result, dict) else None
    if not isinstance(rows, list):
        raise ValueError(f"Apps Script action {action} returned no rows array.")
    return [row for row in rows if isinstance(row, dict)]


def _apps_script_rows_to_csv(rows):
    if not rows:
        return ""
    headers = []
    for row in rows:
        for key in row.keys():
            if key not in headers:
                headers.append(key)
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=headers, lineterminator="\n", extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()


def _fetch_google_sheet_tab_csv_authenticated(sheet_id, tab_name):
    creds_path = _early_service_account_file()
    if not creds_path:
        _record_google_sheet_auth_status("missing_credentials", ok=False, tab_name=tab_name, error="No service account credentials found.")
        logger.info("[CONTENT] Authenticated Google Sheet read unavailable for '%s': no service account credentials", tab_name)
        return ""
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        scopes = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
        creds = service_account.Credentials.from_service_account_file(str(creds_path), scopes=scopes)
        service = build("sheets", "v4", credentials=creds, cache_discovery=False)
        result = service.spreadsheets().values().get(
            spreadsheetId=sheet_id,
            range=f"'{tab_name}'!A:Z",
        ).execute()
        values = result.get("values") or []
        if not values:
            return ""
        output = io.StringIO()
        writer = csv.writer(output, lineterminator="\n")
        for row in values:
            writer.writerow(row)
        logger.info("[CONTENT] Loaded Google Sheet tab '%s' through service account", tab_name)
        _record_google_sheet_auth_status("authenticated_read_ok", ok=True, path=creds_path, tab_name=tab_name)
        return output.getvalue()
    except Exception as exc:
        _record_google_sheet_auth_status("authenticated_read_failed", ok=False, path=creds_path, tab_name=tab_name, error=exc)
        logger.info("[CONTENT] Authenticated Google Sheet read failed for '%s'; trying public CSV export: %s", tab_name, exc)
        return ""


def _content_sheet_tab_candidates(content_key, tab_name):
    seen = set()
    candidates = [tab_name, *(CONTENT_SHEET_TAB_ALIASES.get(content_key) or ())]
    for candidate in candidates:
        normalized = str(candidate or "").strip()
        if normalized and normalized.lower() not in seen:
            seen.add(normalized.lower())
            yield normalized


def _fetch_google_doc_text(doc_id, fmt="md"):
    url = f"https://docs.google.com/document/d/{doc_id}/export?format={fmt}"
    with urlopen(url, timeout=10) as response:
        return response.read().decode("utf-8-sig")


_FAQ_QUESTION_RE = re.compile(r"^\**\s*Q\s*[:.\-]\s*(.+?)\s*\**\s*$", re.IGNORECASE)
_FAQ_ANSWER_RE = re.compile(r"^\**\s*A\s*[:.\-]\s*(.*)$", re.IGNORECASE)
_MD_HEADING_RE = re.compile(r"^##\s+\S", re.MULTILINE)


def _normalize_faq_markdown(text):
    """Accept admin FAQ markdown in either ``## Question`` form or ``Q:``/``A:``
    paragraph form (which is what Google Docs txt/md exports produce when an
    admin types ``Q:`` and ``A:`` lines). Returns ``(markdown, question_count)``.

    A return of ``question_count == 0`` means the doc had no recognizable Q&A
    structure - callers should treat that as malformed and fall back to local
    defaults rather than serving an empty FAQ.
    """
    if not text or not text.strip():
        return "", 0

    raw = text.replace("\r\n", "\n")
    if _MD_HEADING_RE.search(raw):
        return raw, len(_MD_HEADING_RE.findall(raw))

    out_lines = []
    title_emitted = False
    seen_question = False

    for line in raw.split("\n"):
        stripped = line.strip()
        if not stripped:
            out_lines.append("")
            continue

        q_match = _FAQ_QUESTION_RE.match(stripped)
        if q_match and q_match.group(1).strip():
            if not title_emitted:
                out_lines.insert(0, "")
                out_lines.insert(0, "# Mock Testing Suite FAQ")
                title_emitted = True
            out_lines.append("")
            out_lines.append(f"## {q_match.group(1).strip().rstrip('*').strip()}")
            seen_question = True
            continue

        a_match = _FAQ_ANSWER_RE.match(stripped)
        if a_match:
            answer = a_match.group(1).strip().rstrip("*").strip()
            if answer:
                out_lines.append(answer)
            continue

        cleaned = stripped.strip("*").strip()
        if cleaned:
            out_lines.append(cleaned)

    if not seen_question:
        return raw, 0

    normalized = "\n".join(out_lines).strip() + "\n"
    return normalized, len(_MD_HEADING_RE.findall(normalized))


def _read_csv_rows(csv_text):
    rows = list(csv.DictReader(io.StringIO(csv_text or "")))
    headers = list(rows[0].keys()) if rows else []
    if headers:
        logger.info("[SAM] Parsed CSV headers: %s", headers)
    return rows


def _normalize_text_list(rows, required_headers=None):
    if required_headers:
        headers = set((rows[0] or {}).keys()) if rows else set()
        if not headers.issuperset(required_headers):
            raise ValueError(f"missing headers: {sorted(required_headers - headers)}")

    items = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        values = [str(value or "").strip() for value in row.values()]
        first_value = next((value for value in values if value), "")
        if first_value:
            items.append(first_value)
    return items


def _normalize_content_header(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


FAIL_REASON_HEADER_ALIASES = {
    "failreason",
    "failreasons",
    "reason",
    "reasons",
    "label",
}

COACHING_ONLY_HEADER_ALIASES = {
    "childrenpipedelimited",
    "children",
    "childitems",
    "helper",
    "helpertext",
    "notes",
}

DISCORD_POST_HEADER_ALIASES = {
    "title",
    "trigger",
    "name",
    "label",
}

DISCORD_POST_MESSAGE_ALIASES = {
    "message",
    "post",
    "template",
    "body",
    "text",
    "content",
}

DISCORD_POST_SUGGESTED_SCREENSHOTS_ALIASES = {
    "suggestedscreenshots",
    "suggestedscreenshot",
    "screenshots",
}

CONTENT_CATEGORY_HEADER_ALIASES = {
    "category",
    "group",
    "section",
    "type",
}

DEFAULT_CONTENT_CATEGORY = "Uncategorized"

SCREENSHOT_TITLE_HEADER_ALIASES = {
    "title",
    "name",
    "label",
}

SCREENSHOT_PATH_HEADER_ALIASES = {
    "imagepath",
    "imageurl",
    "image",
    "path",
    "url",
    "file",
    "filename",
}

HEADSET_HEADER_ALIASES = {
    "brand",
    "model",
    "models",
    "headset",
    "headsets",
    "approvedheadset",
    "approvedheadsets",
}

HEADSET_VALUE_MARKERS = {
    "logitech",
    "jabra",
    "plantronics",
    "poly",
    "polycom",
    "yealink",
    "sennheiser",
    "epos",
    "blackwire",
    "encorepro",
    "h390",
    "headset",
    "headphones",
}

DEFAULT_MANAGED_SETTINGS_KEYS = {
    "shows",
    "donors_new",
    "donors_existing",
    "donors_increase",
    "call_types",
    "sup_reasons",
    "discord_templates",
    "discord_screenshots",
    "call_coaching",
    "sup_coaching",
    "call_fails",
    "sup_fails",
    "vpnProxyCheckMode",
}

REQUIRED_FAIL_REASONS = {
    "call_fails": ["Did not search for member"],
}

CERTIFICATION_SUPPORT_EMAIL = "certification@acdsupport.com"
LEGACY_CERTIFICATION_SUPPORT_EMAIL = "certification@acddirect.com"


def _normalize_legacy_certification_email_text(value):
    if not isinstance(value, str):
        return value
    if LEGACY_CERTIFICATION_SUPPORT_EMAIL not in value:
        return value
    logger.warning("[CONTENT] Legacy certification support email normalized in managed text.")
    return value.replace(LEGACY_CERTIFICATION_SUPPORT_EMAIL, CERTIFICATION_SUPPORT_EMAIL)


def _normalize_managed_content_certification_email(value):
    if isinstance(value, str):
        return _normalize_legacy_certification_email_text(value)
    if isinstance(value, list):
        return [_normalize_managed_content_certification_email(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize_managed_content_certification_email(item) for key, item in value.items()}
    return value


def _managed_custom_flag(key):
    return f"{key}_customized"


def _merge_required_fail_reasons(items, section_key):
    merged = []
    seen = set()
    has_other = False
    for item in items or []:
        text = str(item or "").strip()
        if not text:
            continue
        key = text.lower()
        if key == "other":
            has_other = True
            continue
        if key in seen:
            continue
        seen.add(key)
        merged.append(text)
    for required in REQUIRED_FAIL_REASONS.get(section_key, []):
        text = str(required or "").strip()
        if not text:
            continue
        key = text.lower()
        if key == "other":
            has_other = True
            continue
        if key in seen:
            continue
        seen.add(key)
        merged.append(text)
    if has_other:
        merged.append("Other")
    return merged



def _fail_reason_fallback(section_key):
    if section_key == "call_fails":
        return _merge_required_fail_reasons(CALL_FAILS, section_key)
    if section_key == "sup_fails":
        return list(SUP_FAILS)
    return []


def _rows_have_headset_shape(rows):
    headers = {
        _normalize_content_header(header)
        for row in rows or []
        for header in (row or {}).keys()
    }
    return bool(headers & HEADSET_HEADER_ALIASES)


def _csv_header_lookup(rows):
    lookup = {}
    for row in rows or []:
        for header in (row or {}).keys():
            normalized = _normalize_content_header(header)
            if normalized and normalized not in lookup:
                lookup[normalized] = header
    return lookup


def _find_csv_header(rows, aliases):
    lookup = _csv_header_lookup(rows)
    return next((lookup[alias] for alias in aliases if alias in lookup), "")


def _row_value(row, header_map, aliases):
    for alias in aliases:
        header = header_map.get(_normalize_content_header(alias))
        if header is not None:
            return row.get(header)
    return ""


def _rows_have_discord_post_shape(rows):
    lookup = _csv_header_lookup(rows)
    return bool(lookup.keys() & DISCORD_POST_HEADER_ALIASES) and bool(lookup.keys() & DISCORD_POST_MESSAGE_ALIASES)


def _rows_have_screenshot_shape(rows):
    lookup = _csv_header_lookup(rows)
    return bool(lookup.keys() & SCREENSHOT_TITLE_HEADER_ALIASES) and bool(lookup.keys() & SCREENSHOT_PATH_HEADER_ALIASES)


def _rows_have_coaching_shape(rows):
    lookup = _csv_header_lookup(rows)
    return bool(lookup.keys() & COACHING_ONLY_HEADER_ALIASES)


def _rows_have_fail_reason_shape(rows):
    lookup = _csv_header_lookup(rows)
    return bool(lookup.keys() & {"failreason", "failreasons"})


def _values_look_like_headsets(values):
    normalized_values = [str(value or "").strip().lower() for value in values if str(value or "").strip()]
    if not normalized_values:
        return False

    marker_hits = sum(
        1
        for value in normalized_values
        if any(marker in value for marker in HEADSET_VALUE_MARKERS)
    )
    return marker_hits >= 2 or (marker_hits >= 1 and len(normalized_values) <= 3)


def _values_match_other_section(values, section_key):
    current_defaults = {
        "call_fails": CALL_FAILS,
        "sup_fails": SUP_FAILS,
        "call_coaching": [item.get("label") for item in CALL_COACHING if isinstance(item, dict)],
        "sup_coaching": [item.get("label") for item in SUP_COACHING if isinstance(item, dict)],
    }
    other_key = {
        "call_fails": "sup_fails",
        "sup_fails": "call_fails",
        "call_coaching": "sup_coaching",
        "sup_coaching": "call_coaching",
    }.get(section_key)
    if not other_key:
        return False
    normalized = {str(value or "").strip().lower() for value in values if str(value or "").strip()}
    if not normalized:
        return False
    current = {str(value or "").strip().lower() for value in current_defaults.get(section_key, []) if str(value or "").strip()}
    other = {str(value or "").strip().lower() for value in current_defaults.get(other_key, []) if str(value or "").strip()}
    other_hits = len(normalized & other)
    current_hits = len(normalized & current)
    return other_hits >= 2 and other_hits > current_hits


def _normalize_fail_reasons(rows, section_key, source_label, use_builtin_fallback=False):
    rows = rows or []
    fallback = _fail_reason_fallback(section_key) if use_builtin_fallback else []
    if not rows:
        return []

    fallback_label = "built-in" if use_builtin_fallback else "local/default"
    header_lookup = {}
    for row in rows:
        for header in (row or {}).keys():
            normalized = _normalize_content_header(header)
            if normalized and normalized not in header_lookup:
                header_lookup[normalized] = header

    fail_header = next(
        (header_lookup[alias] for alias in FAIL_REASON_HEADER_ALIASES if alias in header_lookup),
        "",
    )

    if not fail_header:
        logger.warning(
            "[CONTENT] %s does not contain a FailReason/Reason column. Using %s %s fallback.",
            source_label,
            fallback_label,
            section_key,
        )
        return _merge_required_fail_reasons(fallback, section_key)

    if _rows_have_headset_shape(rows):
        logger.warning(
            "[CONTENT] %s has headset-like columns and was rejected for %s. Using %s fail reasons.",
            source_label,
            section_key,
            fallback_label,
        )
        return _merge_required_fail_reasons(fallback, section_key)

    if _rows_have_coaching_shape(rows):
        logger.warning(
            "[CONTENT] %s has coaching-only columns and was rejected for %s. Using %s fail reasons.",
            source_label,
            section_key,
            fallback_label,
        )
        return _merge_required_fail_reasons(fallback, section_key)

    items = []
    seen = set()
    for row in rows:
        value = str((row or {}).get(fail_header) or "").strip()
        if not value:
            continue
        dedupe_key = value.lower()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        items.append(value)

    if _values_look_like_headsets(items):
        logger.warning(
            "[CONTENT] %s produced headset-like values for %s and was rejected. Using %s fail reasons.",
            source_label,
            section_key,
            fallback_label,
        )
        return _merge_required_fail_reasons(fallback, section_key)
    if _values_match_other_section(items, section_key):
        logger.warning(
            "[CONTENT] %s produced values from the wrong fail-reason section for %s. Using %s fail reasons.",
            source_label,
            section_key,
            fallback_label,
        )
        return _merge_required_fail_reasons(fallback, section_key)

    return _merge_required_fail_reasons(items, section_key)


def _normalize_shows(rows):
    items = []
    header_map = _csv_header_lookup(rows)
    logger.info("[SAM] Shows column headers: %s", list(header_map.values()))
    for row in rows:
        row = row or {}
        show_name = str(_row_value(row, header_map, {"showname", "show", "name", "title"}) or "").strip()
        if not show_name:
            continue
        items.append([
            show_name,
            str(_row_value(row, header_map, {"onetimeamount", "onetime", "one-timeamount", "donationamount"}) or "").strip(),
            str(_row_value(row, header_map, {"monthlyamount", "monthly", "sustainingamount"}) or "").strip(),
            str(_row_value(row, header_map, {"gift", "reward", "thankyougift", "premium"}) or "").strip(),
            str(_row_value(row, header_map, {"notes", "note", "scenarioinstructions", "scenarioinstruction", "scenario"}) or "").strip(),
        ])
    logger.info("[SAM] Loaded %d shows", len(items))
    return items


def _normalize_caller_category(value):
    text = str(value or "").strip().lower()
    aliases = {
        "new": "new",
        "new donor": "new",
        "new donors": "new",
        "existing": "existing",
        "existing member": "existing",
        "existing members": "existing",
        "increase": "increase",
        "increase sustaining": "increase",
        "increase sustaining amount": "increase",
        "increase current sustaining amount": "increase",
    }
    return aliases.get(text, "")


def _normalize_callers(rows):
    grouped = {
        "donors_new": [],
        "donors_existing": [],
        "donors_increase": [],
    }
    header_map = _csv_header_lookup(rows)
    logger.info("[SAM] Callers column headers: %s", list(header_map.values()))

    for row in rows:
        row = row or {}
        category = _normalize_caller_category(_row_value(row, header_map, {"category", "type", "callertype", "donortype", "membertype"}))
        first = str(_row_value(row, header_map, {"first", "firstname", "first_name"}) or "").strip()
        last = str(_row_value(row, header_map, {"last", "lastname", "last_name"}) or "").strip()
        if not category or (not first and not last):
            continue
        entry = [
            first,
            last,
            str(_row_value(row, header_map, {"address", "street", "streetaddress"}) or "").strip(),
            str(_row_value(row, header_map, {"city"}) or "").strip(),
            str(_row_value(row, header_map, {"state", "st"}) or "").strip(),
            str(_row_value(row, header_map, {"zip", "zipcode", "postalcode"}) or "").strip(),
            str(_row_value(row, header_map, {"phone", "phonenumber", "telephone"}) or "").strip(),
            str(_row_value(row, header_map, {"email", "emailaddress"}) or "").strip(),
            str(_row_value(row, header_map, {"notes", "note", "scenarioinstructions", "scenarioinstruction", "scenario"}) or "").strip(),
        ]
        if category == "new":
            grouped["donors_new"].append(entry)
        elif category == "existing":
            grouped["donors_existing"].append(entry)
        elif category == "increase":
            grouped["donors_increase"].append(entry)
    logger.info(
        "[SAM] Loaded %d callers (%d new, %d existing, %d increase)",
        sum(len(value) for value in grouped.values()),
        len(grouped["donors_new"]),
        len(grouped["donors_existing"]),
        len(grouped["donors_increase"]),
    )
    return grouped


def _normalize_callers_for_category(rows, category):
    grouped = {
        "donors_new": [],
        "donors_existing": [],
        "donors_increase": [],
    }
    normalized_category = _normalize_caller_category(category)
    if not normalized_category:
        return grouped
    header_map = _csv_header_lookup(rows)
    logger.info("[SAM] %s callers column headers: %s", normalized_category, list(header_map.values()))

    for row in rows or []:
        row = row or {}
        first = str(_row_value(row, header_map, {"first", "firstname", "first_name"}) or "").strip()
        last = str(_row_value(row, header_map, {"last", "lastname", "last_name"}) or "").strip()
        if not first and not last:
            continue
        entry = [
            first,
            last,
            str(_row_value(row, header_map, {"address", "street", "streetaddress"}) or "").strip(),
            str(_row_value(row, header_map, {"city"}) or "").strip(),
            str(_row_value(row, header_map, {"state", "st"}) or "").strip(),
            str(_row_value(row, header_map, {"zip", "zipcode", "postalcode"}) or "").strip(),
            str(_row_value(row, header_map, {"phone", "phonenumber", "telephone"}) or "").strip(),
            str(_row_value(row, header_map, {"email", "emailaddress"}) or "").strip(),
            str(_row_value(row, header_map, {"notes", "note", "scenarioinstructions", "scenarioinstruction", "scenario"}) or "").strip(),
        ]
        if normalized_category == "new":
            grouped["donors_new"].append(entry)
        elif normalized_category == "existing":
            grouped["donors_existing"].append(entry)
        elif normalized_category == "increase":
            grouped["donors_increase"].append(entry)
    logger.info("[SAM] Loaded %d %s callers", len(grouped[f"donors_{normalized_category}"]), normalized_category)
    return grouped


REQUIRED_DTE_SCREENSHOTS = [
    {"category": "DTE", "title": "DTE Taskbar", "image_url": "/DTE-Taskbar.png"},
    {"category": "DTE", "title": "DTE Allow", "image_url": "/DTE-allow.png"},
    {"category": "DTE", "title": "DTE Permission", "image_url": "/DTE-permission.png"},
    {"category": "DTE", "title": "DTE Profile", "image_url": "/DTE-profile.png"},
    {"category": "DTE", "title": "DTE Ready", "image_url": "/DTE-ready.png"},
]


REQUIRED_DISCORD_SUGGESTED_SCREENSHOTS = {
    "sup-launch dte #1": ["/DTE-Taskbar.png"],
    "sup-launch dte #2": ["/DTE-allow.png"],
    "sup-launch dte #3": ["/DTE-permission.png"],
    "sup-launch dte #4": ["/DTE-profile.png"],
    "change dte status": ["/DTE-ready.png"],
}


def _normalize_discord_message(value):
    normalized = []
    previous_was_blank = False
    for raw_line in str(value or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw_line.rstrip(" \t")
        is_blank = not line.strip()
        if is_blank:
            if normalized and not previous_was_blank:
                normalized.append("")
        else:
            normalized.append(line)
        previous_was_blank = is_blank
    while normalized and normalized[-1] == "":
        normalized.pop()
    return "\n".join(normalized)


def _normalize_discord_posts(rows):
    rows = rows or []
    if not rows:
        return []
    if _rows_have_screenshot_shape(rows) and not _rows_have_discord_post_shape(rows):
        logger.warning("[CONTENT] Screenshot-shaped rows were rejected for Discord posts.")
        return []
    if _rows_have_headset_shape(rows):
        logger.warning("[CONTENT] Headset-shaped rows were rejected for Discord posts.")
        return []

    category_header = _find_csv_header(rows, CONTENT_CATEGORY_HEADER_ALIASES)
    title_header = _find_csv_header(rows, DISCORD_POST_HEADER_ALIASES)
    message_header = _find_csv_header(rows, DISCORD_POST_MESSAGE_ALIASES)
    suggested_header = _find_csv_header(rows, DISCORD_POST_SUGGESTED_SCREENSHOTS_ALIASES)
    header_map = _csv_header_lookup(rows)
    if not title_header or not message_header:
        logger.warning("[CONTENT] Discord posts rows require Title and Message columns.")
        return []

    items = []
    for row in rows:
        row = row or {}
        category = str(row.get(category_header) or "").strip() if category_header else ""
        category = category or DEFAULT_CONTENT_CATEGORY
        title = str(row.get(title_header) or "").strip()
        message = _normalize_discord_message(row.get(message_header))
        if title:
            item = {"category": category, "title": title, "message": message}
            suggested_values = []
            has_suggested_columns = bool(suggested_header)
            if suggested_header:
                suggested_values.extend(str(row.get(suggested_header) or "").split("|"))
            for index in range(1, 4):
                aliases = {f"suggestedscreenshot{index}", f"screenshot{index}"}
                if any(_normalize_content_header(alias) in header_map for alias in aliases):
                    value = _row_value(row, header_map, aliases)
                    has_suggested_columns = True
                    suggested_values.append(value)
            if has_suggested_columns:
                item["suggested_screenshots"] = [str(value or "").strip() for value in suggested_values if str(value or "").strip()][:3]
            elif title.strip().lower() in REQUIRED_DISCORD_SUGGESTED_SCREENSHOTS:
                item["suggested_screenshots"] = REQUIRED_DISCORD_SUGGESTED_SCREENSHOTS[title.strip().lower()]
            items.append(item)
    return items


def _normalize_screenshots(rows):
    rows = rows or []
    if not rows:
        return []
    if _rows_have_discord_post_shape(rows) and not _rows_have_screenshot_shape(rows):
        logger.warning("[CONTENT] Discord-post-shaped rows were rejected for screenshots.")
        return []
    if _rows_have_headset_shape(rows):
        logger.warning("[CONTENT] Headset-shaped rows were rejected for screenshots.")
        return []

    category_header = _find_csv_header(rows, CONTENT_CATEGORY_HEADER_ALIASES)
    title_header = _find_csv_header(rows, SCREENSHOT_TITLE_HEADER_ALIASES)
    image_header = _find_csv_header(rows, SCREENSHOT_PATH_HEADER_ALIASES)
    if not title_header or not image_header:
        logger.warning("[CONTENT] Screenshot rows require Title and ImagePath columns.")
        return []

    items = []
    for row in rows:
        row = row or {}
        category = str(row.get(category_header) or "").strip() if category_header else ""
        category = category or DEFAULT_CONTENT_CATEGORY
        title = str(row.get(title_header) or "").strip()
        image_path = str(row.get(image_header) or "").strip()
        if title:
            items.append({"category": category, "title": title, "image_url": image_path})
    existing_paths = {str(item.get("image_url") or "").strip().lower() for item in items}
    for screenshot in REQUIRED_DTE_SCREENSHOTS:
        if screenshot["image_url"].lower() not in existing_paths:
            items.append(dict(screenshot))
            existing_paths.add(screenshot["image_url"].lower())
    return items


def _coaching_fallback(section_key):
    if section_key == "call_coaching":
        return list(CALL_COACHING)
    if section_key == "sup_coaching":
        return list(SUP_COACHING)
    return []


def _normalize_coaching(rows, include_ids, section_key="", source_label="coaching"):
    rows = rows or []
    fallback = _coaching_fallback(section_key)
    if _rows_have_headset_shape(rows):
        logger.warning(
            "[CONTENT] %s has headset-like columns and was rejected for %s. Using built-in coaching defaults.",
            source_label,
            section_key or "coaching",
        )
        return fallback
    if _rows_have_discord_post_shape(rows) or _rows_have_screenshot_shape(rows) or _rows_have_fail_reason_shape(rows):
        logger.warning(
            "[CONTENT] %s has the wrong schema and was rejected for %s. Using built-in coaching defaults.",
            source_label,
            section_key or "coaching",
        )
        return fallback

    items = []
    for row in rows:
        row = row or {}
        label = str(row.get("Label") or "").strip()
        if not label:
            continue
        item = {"label": label}
        if include_ids:
            item["id"] = str(row.get("ID") or "").strip() or _slugify_label(label)
        helper = str(row.get("Helper") or "").strip()
        children = [
            child.strip()
            for child in str(row.get("ChildrenPipeDelimited") or "").split("|")
            if child.strip()
        ]
        if helper:
            item["helper"] = helper
        if children:
            item["children"] = children
        items.append(item)

    labels = [item.get("label", "") for item in items]
    if _values_look_like_headsets(labels):
        logger.warning(
            "[CONTENT] %s produced headset-like values for %s and was rejected. Using built-in coaching defaults.",
            source_label,
            section_key or "coaching",
        )
        return fallback
    if _values_match_other_section(labels, section_key):
        logger.warning(
            "[CONTENT] %s produced values from the wrong coaching section for %s. Using built-in coaching defaults.",
            source_label,
            section_key or "coaching",
        )
        return fallback
    return _merge_required_coaching_defaults(section_key, items)


def _natural_sort_key(value):
    return tuple(
        int(part) if part.isdigit() else part.casefold()
        for part in re.split(r"(\d+)", " ".join(str(value or "").split()))
    )


def _normalize_approved_headsets(rows):
    grouped = {}
    ignored_brands = {"source note", "source url", "example"}

    for row in rows:
        row = row or {}
        brand = " ".join(str(row.get("Brand") or "").split())
        model = " ".join(str(row.get("Model") or "").split())
        status = _normalize_headset_catalog_status(row.get("Status"), legacy_blank_approved=True)
        if not brand or brand.lower() in ignored_brands or not model:
            continue
        if status != "approved":
            continue
        brand_key = brand.casefold()
        model_key = model.casefold()
        group = grouped.setdefault(brand_key, {"brand": brand, "models": {}})
        group["models"].setdefault(model_key, model)

    normalized = []
    for group in sorted(grouped.values(), key=lambda item: _natural_sort_key(item["brand"])):
        models = sorted(group["models"].values(), key=_natural_sort_key)
        if models:
            normalized.append({"brand": group["brand"], "models": models})
    return normalized


def _normalize_denied_headsets(rows):
    denied = []
    seen = set()
    for row in rows or []:
        row = row or {}
        brand = " ".join(str(row.get("Brand") or "").split())
        model = " ".join(str(row.get("Model") or "").split())
        status = _normalize_headset_catalog_status(row.get("Status"))
        key = (brand.casefold(), model.casefold())
        if brand and model and key not in seen and status == "denied":
            seen.add(key)
            denied.append({
                "brand": brand,
                "model": model,
                "status": "denied",
                "note": str(row.get("Note") or "").strip(),
            })
    return sorted(denied, key=lambda item: (_natural_sort_key(item["brand"]), _natural_sort_key(item["model"])))


def _normalize_headset_catalog_status(value, legacy_blank_approved=False):
    """Return the one internal catalog status used by MTS and SAM."""
    normalized = " ".join(str(value or "").strip().lower().split())
    if not normalized:
        return "approved" if legacy_blank_approved else "unknown"
    if normalized in {"approved", "active", "allowed"}:
        return "approved"
    if normalized in {"denied", "rejected"}:
        return "denied"
    if normalized in {"archived", "archive"}:
        return "archived"
    if normalized in {"deleted", "removed", "tombstoned"}:
        return "deleted"
    if normalized in {"inactive", "withdrawn"}:
        return "inactive"
    return "unknown"


TUTORIAL_VIDEO_HEADERS = [
    "Category", "VideoKey", "Title", "Description", "YouTubeURL", "Duration",
    "HelpTopicKey", "SortOrder", "Active", "Audience", "Notes",
]
MTS_TUTORIAL_CATEGORIES = {
    "Quick Start", "Getting Started", "Candidate Lookup", "Approved Headsets", "Mock Calls",
    "Supervisor Transfers", "Smart Resume", "Technical Issues", "Newbie Shifts", "Rescheduling",
    "Review and Form Fill", "History", "Discord Posts", "Settings", "Help and Shortcuts", "Troubleshooting",
}
SAM_TUTORIAL_CATEGORIES = {
    "Quick Start", "Dashboard", "Notifications", "Live Preview", "Candidate Search", "Candidate Tracking",
    "Pending Supervisor Transfers", "Pending Requests", "Headset Review", "Reports", "Updates", "Settings", "Help", "Troubleshooting",
}
YOUTUBE_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
YOUTUBE_VIDEO_HOSTS = {"youtube.com", "www.youtube.com", "youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"}


def _tutorial_youtube_video_id(value):
    text = str(value or "").strip()
    if not text or "<" in text or ">" in text:
        return ""
    if YOUTUBE_VIDEO_ID_RE.fullmatch(text):
        return text
    try:
        parsed = urlparse(text)
    except Exception:
        return ""
    host = str(parsed.hostname or "").lower()
    if parsed.scheme != "https" or host not in YOUTUBE_VIDEO_HOSTS:
        return ""
    parts = [part for part in str(parsed.path or "").split("/") if part]
    candidate = ""
    if host == "youtu.be":
        candidate = parts[0] if parts else ""
    elif parsed.path == "/watch":
        from urllib.parse import parse_qs
        candidate = (parse_qs(parsed.query).get("v") or [""])[0]
    elif parts and parts[0] in {"embed", "shorts", "live"}:
        candidate = parts[1] if len(parts) > 1 else ""
    return candidate if YOUTUBE_VIDEO_ID_RE.fullmatch(candidate or "") else ""


def _normalize_tutorial_videos(rows, app):
    if not isinstance(rows, list) or not rows:
        return []
    present_headers = {str(key or "").strip() for key in (rows[0] or {}).keys()}
    if not set(TUTORIAL_VIDEO_HEADERS).issubset(present_headers):
        logger.warning("[CONTENT] %s tutorial rows have invalid headers; using packaged fallback.", str(app).upper())
        return []
    categories = SAM_TUTORIAL_CATEGORIES if app == "sam" else MTS_TUTORIAL_CATEGORIES
    normalized, seen_keys = [], set()
    for row in rows:
        video_key = str(row.get("VideoKey") or "").strip()
        title = str(row.get("Title") or "").strip()
        if not video_key or not title or video_key.casefold() in seen_keys:
            continue
        category = str(row.get("Category") or "").strip()
        youtube_url = str(row.get("YouTubeURL") or "").strip()
        if youtube_url and not _tutorial_youtube_video_id(youtube_url):
            continue
        try:
            sort_order = int(str(row.get("SortOrder") or "9999").strip())
        except (TypeError, ValueError):
            sort_order = 9999
        normalized.append({
            "Category": category if category in categories else "Other Tutorials", "VideoKey": video_key,
            "Title": title, "Description": str(row.get("Description") or "").strip(),
            "YouTubeURL": youtube_url, "Duration": str(row.get("Duration") or "").strip(),
            "HelpTopicKey": str(row.get("HelpTopicKey") or "").strip(), "SortOrder": sort_order,
            "Active": str(row.get("Active") or "").strip(), "Audience": str(row.get("Audience") or "").strip(),
        })
        seen_keys.add(video_key.casefold())
    return normalized


def _load_local_defaults_content():
    source_dirs = _local_default_source_dirs()
    defaults_dir = _resolve_defaults_dir()
    if not source_dirs:
        logger.warning("[CONTENT] No local admin csv-tabs or backend/defaults directory found; using built-in defaults when needed")
        return {}

    logger.info("[SAM] Falling back to local CSV/markdown defaults")
    for label, path in source_dirs:
        logger.info("[CONTENT] Local defaults source available: %s at %s", label, path)
    loaded = {}

    def local_filename_candidates(filename):
        seen = set()
        for candidate in (filename, *(LOCAL_DEFAULT_FILE_ALIASES.get(filename) or ())):
            normalized = str(candidate or "").strip()
            if normalized and normalized.lower() not in seen:
                seen.add(normalized.lower())
                yield normalized

    def find_local_file(filename, required=True):
        for label, directory in source_dirs:
            for local_name in local_filename_candidates(filename):
                path = directory / local_name
                if path.is_file():
                    logger.info("[CONTENT] Using %s from %s (%s)", local_name, label, path)
                    return path
        if required:
            logger.warning("[CONTENT] Missing local defaults file in all sources: %s", filename)
        return None

    def read_csv_file(filename):
        path = find_local_file(filename, required=True)
        if not path:
            return None
        try:
            text = path.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            logger.warning("[CONTENT] %s is not UTF-8; reading with Windows-1252 compatibility", path)
            text = path.read_text(encoding="cp1252")
        return _read_csv_rows(text)

    def read_optional_csv_file(filename):
        path = find_local_file(filename, required=False)
        if not path:
            return None
        try:
            text = path.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            logger.warning("[CONTENT] %s is not UTF-8; reading with Windows-1252 compatibility", path)
            text = path.read_text(encoding="cp1252")
        return _read_csv_rows(text)

    def read_headsets_csv_file():
        # The admin content package can contain only source notes for this tab.
        # Prefer the bundled runtime CSV so offline headset lookup remains usable.
        for label, directory in source_dirs:
            if label != "backend/defaults":
                continue
            path = directory / DEFAULTS_FILE_MAP["approved_headsets"]
            if path.is_file():
                return _read_csv_rows(path.read_text(encoding="utf-8-sig"))
        return read_csv_file(DEFAULTS_FILE_MAP["approved_headsets"]) or []

    def read_text_file(filename):
        path = find_local_file(filename, required=True)
        if not path:
            return None
        return path.read_text(encoding="utf-8")

    try:
        rows = read_csv_file(DEFAULTS_FILE_MAP["callers"])
        if rows is not None:
            logger.info("[SAM] Loaded callers from backend/defaults/%s", DEFAULTS_FILE_MAP["callers"])
            parsed_callers = _normalize_callers(rows)
            loaded.update(parsed_callers)
            logger.info(
                "[SAM] Split callers by Category: %d new, %d existing, %d increase",
                len(parsed_callers.get("donors_new") or []),
                len(parsed_callers.get("donors_existing") or []),
                len(parsed_callers.get("donors_increase") or []),
            )
    except Exception as exc:
        logger.warning("[CONTENT] Failed to parse local callers defaults: %s", exc)

    headset_rows = read_headsets_csv_file()
    local_csv_loaders = {
        "shows": lambda: _normalize_shows(read_csv_file(DEFAULTS_FILE_MAP["shows"]) or []),
        "call_types": lambda: _normalize_text_list(read_csv_file(DEFAULTS_FILE_MAP["call_types"]) or []),
        "sup_reasons": lambda: _normalize_text_list(read_csv_file(DEFAULTS_FILE_MAP["sup_reasons"]) or []),
        "call_coaching": lambda: _normalize_coaching(read_csv_file(DEFAULTS_FILE_MAP["call_coaching"]) or [], include_ids=True, section_key="call_coaching", source_label="local call-coaching.csv"),
        "sup_coaching": lambda: _normalize_coaching(read_csv_file(DEFAULTS_FILE_MAP["sup_coaching"]) or [], include_ids=False, section_key="sup_coaching", source_label="local sup-coaching.csv"),
        "call_fails": lambda: _normalize_fail_reasons(read_csv_file(DEFAULTS_FILE_MAP["call_fails"]) or [], "call_fails", "local call-fail-reasons.csv", use_builtin_fallback=True),
        "sup_fails": lambda: _normalize_fail_reasons(read_csv_file(DEFAULTS_FILE_MAP["sup_fails"]) or [], "sup_fails", "local sup-fail-reasons.csv", use_builtin_fallback=True),
        "discord_templates": lambda: _normalize_discord_posts(read_csv_file(DEFAULTS_FILE_MAP["discord_templates"]) or []),
        "discord_screenshots": lambda: _normalize_screenshots(read_csv_file(DEFAULTS_FILE_MAP["discord_screenshots"]) or []),
        "approved_headsets": lambda: _normalize_approved_headsets(headset_rows),
        "denied_headsets": lambda: _normalize_denied_headsets(headset_rows),
        "mts_tutorial_videos": lambda: _normalize_tutorial_videos(read_csv_file(DEFAULTS_FILE_MAP["mts_tutorial_videos"]) or [], "mts"),
        "sam_tutorial_videos": lambda: _normalize_tutorial_videos(read_csv_file(DEFAULTS_FILE_MAP["sam_tutorial_videos"]) or [], "sam"),
    }

    for key, loader in local_csv_loaders.items():
        try:
            parsed = loader()
            if parsed:
                loaded[key] = parsed
        except Exception as exc:
            logger.warning("[CONTENT] Failed to parse local defaults for %s: %s", key, exc)

    for key in (
        "help_markdown",
        "faq_markdown",
        "admin_setup_markdown",
        "gemini_coaching_prompt",
        "gemini_fail_prompt",
    ):
        try:
            text = read_text_file(DEFAULTS_FILE_MAP[key])
            if isinstance(text, str) and text.strip():
                loaded[key] = text
        except Exception as exc:
            logger.warning("[CONTENT] Failed to read local defaults for %s: %s", key, exc)

    return _normalize_managed_content_certification_email(loaded)


def _parse_gemini_prompt_sheet_override(csv_text, local_prompt, prompt_name):
    rows = list(csv.reader(io.StringIO(csv_text or "")))
    meaningful_rows = [
        row for row in rows
        if any(str(cell or "").strip() for cell in row)
    ]
    if len(meaningful_rows) != 2:
        logger.warning("[Gemini] Invalid Google Sheet %s prompt structure; using markdown fallback", prompt_name)
        return ""

    header_row, prompt_row = meaningful_rows
    header = str(header_row[0] if header_row else "").strip()
    extra_header_values = [str(cell or "").strip() for cell in header_row[1:] if str(cell or "").strip()]
    extra_prompt_values = [str(cell or "").strip() for cell in prompt_row[1:] if str(cell or "").strip()]
    if header != "prompt" or extra_header_values or extra_prompt_values:
        logger.warning("[Gemini] Invalid Google Sheet %s prompt structure; using markdown fallback", prompt_name)
        return ""

    prompt = str(prompt_row[0] if prompt_row else "").strip()
    if not prompt:
        logger.warning("[Gemini] Invalid Google Sheet %s prompt structure; using markdown fallback", prompt_name)
        return ""
    if _values_look_like_headsets([prompt]):
        logger.warning("[Gemini] Invalid Google Sheet %s prompt structure; using markdown fallback", prompt_name)
        return ""
    if not _is_meaningful_gemini_prompt_text(prompt):
        logger.warning("[Gemini] Invalid Google Sheet %s prompt structure; using markdown fallback", prompt_name)
        return ""

    if _normalize_gemini_prompt_for_compare(prompt) == _normalize_gemini_prompt_for_compare(local_prompt):
        logger.info("[Gemini] Google Sheet %s prompt matches markdown default; using bundled prompt", prompt_name)
        return ""

    logger.info("[Gemini] Google Sheet %s override active", prompt_name)
    return prompt


CONTENT_SHEET_PARSERS = {
    "callers": lambda csv_text: _normalize_callers(_read_csv_rows(csv_text)),
    "shows": lambda csv_text: {"shows": _normalize_shows(_read_csv_rows(csv_text))},
    "call_types": lambda csv_text: {"call_types": _normalize_text_list(_read_csv_rows(csv_text))},
    "sup_reasons": lambda csv_text: {"sup_reasons": _normalize_text_list(_read_csv_rows(csv_text))},
    "call_coaching": lambda csv_text: {"call_coaching": _normalize_coaching(_read_csv_rows(csv_text), include_ids=True, section_key="call_coaching", source_label="Google Sheet tab call-coaching")},
    "sup_coaching": lambda csv_text: {"sup_coaching": _normalize_coaching(_read_csv_rows(csv_text), include_ids=False, section_key="sup_coaching", source_label="Google Sheet tab sup-coaching")},
    "call_fails": lambda csv_text: {"call_fails": _normalize_fail_reasons(_read_csv_rows(csv_text), "call_fails", "Google Sheet tab call-fail-reasons")},
    "sup_fails": lambda csv_text: {"sup_fails": _normalize_fail_reasons(_read_csv_rows(csv_text), "sup_fails", "Google Sheet tab sup-fail-reasons")},
    "discord_templates": lambda csv_text: {"discord_templates": _normalize_discord_posts(_read_csv_rows(csv_text))},
    "discord_screenshots": lambda csv_text: {"discord_screenshots": _normalize_screenshots(_read_csv_rows(csv_text))},
    "approved_headsets": lambda csv_text: {
        "approved_headsets": _normalize_approved_headsets(_read_csv_rows(csv_text)),
        "denied_headsets": _normalize_denied_headsets(_read_csv_rows(csv_text)),
    },
    "mts_tutorial_videos": lambda csv_text: {"mts_tutorial_videos": _normalize_tutorial_videos(_read_csv_rows(csv_text), "mts")},
    "sam_tutorial_videos": lambda csv_text: {"sam_tutorial_videos": _normalize_tutorial_videos(_read_csv_rows(csv_text), "sam")},
}


def _load_google_sheet_content(runtime_config, local_content=None):
    sheet_id = _resolve_content_sheet_id(runtime_config or {})
    if not sheet_id:
        return {}

    loaded = {}
    local_content = local_content or {}
    for content_key, tab_name in CONTENT_SHEET_TAB_MAP.items():
        loaded_this_key = False
        last_error = None
        for candidate_tab in _content_sheet_tab_candidates(content_key, tab_name):
            logger.info("[SAM] Loading %s from Google Sheets tab '%s'...", content_key, candidate_tab)
            logger.info("[CONTENT] Loading Google Sheet tab '%s' for %s", candidate_tab, content_key)
            try:
                csv_text = _fetch_google_sheet_tab_csv(sheet_id, candidate_tab)
                rows_for_diagnostics = _read_csv_rows(csv_text)
                row_count = len(rows_for_diagnostics)
                headers = list(rows_for_diagnostics[0].keys()) if rows_for_diagnostics else []
                logger.info("[SAM] Active sheet tab '%s' headers: %s", candidate_tab, headers)
                logger.info("[SAM] Active sheet tab '%s' row count: %d", candidate_tab, row_count)
                if content_key == "gemini_coaching_prompt":
                    parsed = {
                        content_key: _parse_gemini_prompt_sheet_override(
                            csv_text,
                            local_content.get(content_key) or "",
                            "coaching",
                        )
                    }
                elif content_key == "gemini_fail_prompt":
                    parsed = {
                        content_key: _parse_gemini_prompt_sheet_override(
                            csv_text,
                            local_content.get(content_key) or "",
                            "fail",
                        )
                    }
                else:
                    parsed = CONTENT_SHEET_PARSERS[content_key](csv_text)
                if content_key in {"gemini_coaching_prompt", "gemini_fail_prompt"} and not any(parsed.values()):
                    break
                for key, value in parsed.items():
                    if value:
                        loaded[key] = value
                        loaded_this_key = True
                        logger.info("[SAM] Loaded %d %s from Google Sheets tab '%s'", _content_count(value), key, candidate_tab)
                if content_key == "callers" and loaded_this_key:
                    logger.info("[SAM] Loaded callers from Google Sheet tab callers")
                    logger.info(
                        "[SAM] Split callers by Category: %d new, %d existing, %d increase",
                        len(parsed.get("donors_new") or []),
                        len(parsed.get("donors_existing") or []),
                        len(parsed.get("donors_increase") or []),
                    )
                if loaded_this_key:
                    break
                if row_count:
                    logger.warning(
                        "[SAM] Falling back to CSV for %s because Google Sheets parsed no usable rows from tab '%s'",
                        content_key,
                        candidate_tab,
                    )
                    logger.warning(
                        "[CONTENT] Google Sheet tab '%s' has %d row(s) but produced no usable %s data - check tab columns; using local defaults",
                        candidate_tab,
                        row_count,
                        content_key,
                    )
                else:
                    logger.warning(
                        "[SAM] Falling back to CSV for %s because Google Sheets tab '%s' is empty",
                        content_key,
                        candidate_tab,
                    )
                    logger.warning(
                        "[CONTENT] Google Sheet tab '%s' was empty; using local defaults for %s",
                        candidate_tab,
                        content_key,
                    )
            except Exception as exc:
                last_error = exc
                _record_google_sheet_content_error(content_key, candidate_tab, exc)
                logger.warning("[SAM] Falling back to CSV for %s after Google Sheets failure on tab '%s': %s", content_key, candidate_tab, exc)
                logger.warning(
                    "[CONTENT] Failed to load Google Sheet tab '%s'; using local defaults for %s and continuing other tabs: %s",
                    candidate_tab,
                    content_key,
                    exc,
                )
        if not loaded_this_key and last_error:
            logger.warning("[SAM] No Google Sheets tab candidate loaded for %s; last error: %s", content_key, last_error)
    return _normalize_managed_content_certification_email(loaded)

def _load_help_faq_google_doc_overrides(runtime_config):
    loaded = {}
    docs_to_load = {
        "help_markdown": (
            ("admin_help_doc_url", "help_doc_url"),
            ("admin_help_doc_id", "help_doc_id"),
            DEFAULT_HELP_DOC_URL,
        ),
        "faq_markdown": (
            ("admin_faq_doc_url", "faq_doc_url"),
            ("admin_faq_doc_id", "faq_doc_id"),
            DEFAULT_FAQ_DOC_URL,
        ),
    }

    for content_key, (url_keys, id_keys, fallback_url) in docs_to_load.items():
        doc_id = _resolve_google_doc_id(runtime_config, url_keys, id_keys, fallback_url)
        if not doc_id:
            continue

        text = ""
        # Prefer markdown export (preserves heading structure). Fall back to
        # plain text if the doc owner has Markdown disabled or the export errors.
        try:
            text = _fetch_google_doc_text(doc_id, fmt="md")
        except Exception as exc_md:
            try:
                text = _fetch_google_doc_text(doc_id, fmt="txt")
                logger.info(
                    "[CONTENT] Google Doc %s fetched as txt (md export failed: %s)",
                    content_key,
                    exc_md,
                )
            except Exception as exc_txt:
                logger.warning(
                    "[CONTENT] Failed to load Google Doc override for %s; using local defaults: %s",
                    content_key,
                    exc_txt,
                )
                continue

        if not text or not text.strip():
            logger.warning(
                "[CONTENT] Google Doc override for %s was empty; using local defaults",
                content_key,
            )
            continue

        if content_key == "faq_markdown":
            normalized, question_count = _normalize_faq_markdown(text)
            if question_count == 0:
                logger.warning(
                    "[CONTENT] Google Doc %s had no recognizable Q&A entries; using local defaults",
                    content_key,
                )
                continue
            loaded[content_key] = _normalize_legacy_certification_email_text(normalized)
            logger.info(
                "[CONTENT] Loaded %d FAQ entries from Google Doc",
                question_count,
            )
        else:
            loaded[content_key] = _normalize_legacy_certification_email_text(text)
    return loaded


def _load_external_content():
    try:
        local_content = _load_local_defaults_content()
        logger.info("[CONTENT] local defaults loaded")
    except Exception as exc:
        logger.warning("[CONTENT] Local defaults load failed; continuing with built-in defaults: %s", exc)
        local_content = {}

    merged = {}
    for key, value in (local_content or {}).items():
        merged[key] = value
        _set_content_source(key, "local_csv", value, ok=True, detail="admin-content-package csv-tabs, then backend/defaults")
        _content_source_status[key]["background_status"] = "loading"
        _content_source_status[key]["background_loading"] = True

    # Ensure other tracked keys are populated with background_status=loading
    for key in TRACKED_CONTENT_KEYS:
        if key not in _content_source_status:
            _content_source_status[key] = {
                "source": "builtin",
                "count": 0,
                "ok": True,
                "detail": "emergency hardcoded fallback",
                "background_status": "loading",
                "background_loading": True,
            }

    return merged


async def _background_remote_content_task():
    global CALL_TYPES, SUP_REASONS, SHOWS, NEW_DONORS, EXISTING_MEMBERS, INCREASE_SUSTAINING
    global DISCORD_TEMPLATES, DISCORD_SCREENSHOTS, CALL_COACHING, CALL_FAILS, SUP_COACHING, SUP_FAILS
    global HELP_DOC_MARKDOWN, FAQ_DOC_MARKDOWN, ADMIN_SETUP_MARKDOWN
    global EXTERNAL_CONTENT

    try:
        import asyncio

        logger.info("[CONTENT] background Google content refresh started")
        runtime_config = _load_backend_runtime_config()
        remote_pipeline_failures = []
        # Local defaults were loaded synchronously before the server became ready.
        # Reuse that snapshot instead of rescanning every bundled CSV/markdown file.
        local_content = dict(EXTERNAL_CONTENT)

        try:
            sheet_content = await asyncio.to_thread(_load_google_sheet_content, runtime_config, local_content)
        except Exception as exc:
            logger.warning("[CONTENT] Google Sheet content pipeline failed: %s", exc)
            remote_pipeline_failures.append(f"sheets: {exc}")
            sheet_content = {}

        try:
            doc_content = await asyncio.to_thread(_load_help_faq_google_doc_overrides, runtime_config)
        except Exception as exc:
            logger.warning("[CONTENT] Google Doc content pipeline failed: %s", exc)
            remote_pipeline_failures.append(f"docs: {exc}")
            doc_content = {}

        live_screenshots_ok = False
        if sheet_content.get("discord_screenshots"):
            live_screenshots_ok = True

        if not live_screenshots_ok:
            if local_content.get("discord_screenshots"):
                sheet_content["discord_screenshots"] = local_content.get("discord_screenshots")
                logger.info(
                    "[CONTENT] Live screenshots empty, disabled, or failed. Using packaged default screenshots."
                )

        # Merge sheet content
        for key, value in (sheet_content or {}).items():
            EXTERNAL_CONTENT[key] = value
            detail = "google_sheet_override" if key in {"gemini_coaching_prompt", "gemini_fail_prompt"} else "google_sheet"
            _content_source_status[key] = {
                "source": "google",
                "count": _content_count(value),
                "ok": True,
                "detail": detail,
                "background_status": "completed",
                "background_loading": False,
            }

        # Merge doc content
        for key, value in (doc_content or {}).items():
            EXTERNAL_CONTENT[key] = value
            _content_source_status[key] = {
                "source": "google",
                "count": _content_count(value),
                "ok": True,
                "detail": "google_doc",
                "background_status": "completed",
                "background_loading": False,
            }

        # Update in-memory defaults
        if isinstance(EXTERNAL_CONTENT.get("call_types"), list) and EXTERNAL_CONTENT["call_types"]:
            CALL_TYPES = EXTERNAL_CONTENT["call_types"]
            DEFAULT_SETTINGS["call_types"] = CALL_TYPES
        if isinstance(EXTERNAL_CONTENT.get("sup_reasons"), list) and EXTERNAL_CONTENT["sup_reasons"]:
            SUP_REASONS = EXTERNAL_CONTENT["sup_reasons"]
            DEFAULT_SETTINGS["sup_reasons"] = SUP_REASONS
        if isinstance(EXTERNAL_CONTENT.get("shows"), list) and EXTERNAL_CONTENT["shows"]:
            SHOWS = EXTERNAL_CONTENT["shows"]
            DEFAULT_SETTINGS["shows"] = SHOWS
        if isinstance(EXTERNAL_CONTENT.get("donors_new"), list) and EXTERNAL_CONTENT["donors_new"]:
            NEW_DONORS = EXTERNAL_CONTENT["donors_new"]
            DEFAULT_SETTINGS["donors_new"] = NEW_DONORS
        if isinstance(EXTERNAL_CONTENT.get("donors_existing"), list) and EXTERNAL_CONTENT["donors_existing"]:
            EXISTING_MEMBERS = EXTERNAL_CONTENT["donors_existing"]
            DEFAULT_SETTINGS["donors_existing"] = EXISTING_MEMBERS
        if isinstance(EXTERNAL_CONTENT.get("donors_increase"), list) and EXTERNAL_CONTENT["donors_increase"]:
            INCREASE_SUSTAINING = EXTERNAL_CONTENT["donors_increase"]
            DEFAULT_SETTINGS["donors_increase"] = INCREASE_SUSTAINING
        if isinstance(EXTERNAL_CONTENT.get("discord_templates"), list) and EXTERNAL_CONTENT["discord_templates"]:
            DISCORD_TEMPLATES = EXTERNAL_CONTENT["discord_templates"]
            DEFAULT_SETTINGS["discord_templates"] = DISCORD_TEMPLATES
        if isinstance(EXTERNAL_CONTENT.get("discord_screenshots"), list) and EXTERNAL_CONTENT["discord_screenshots"]:
            DISCORD_SCREENSHOTS = EXTERNAL_CONTENT["discord_screenshots"]
            DEFAULT_SETTINGS["discord_screenshots"] = DISCORD_SCREENSHOTS
        if isinstance(EXTERNAL_CONTENT.get("call_coaching"), list) and EXTERNAL_CONTENT["call_coaching"]:
            CALL_COACHING = EXTERNAL_CONTENT["call_coaching"]
            DEFAULT_SETTINGS["call_coaching"] = CALL_COACHING
        if isinstance(EXTERNAL_CONTENT.get("call_fails"), list) and EXTERNAL_CONTENT["call_fails"]:
            CALL_FAILS = _merge_required_fail_reasons(EXTERNAL_CONTENT["call_fails"], "call_fails")
            DEFAULT_SETTINGS["call_fails"] = CALL_FAILS
        if isinstance(EXTERNAL_CONTENT.get("sup_coaching"), list) and EXTERNAL_CONTENT["sup_coaching"]:
            SUP_COACHING = EXTERNAL_CONTENT["sup_coaching"]
            DEFAULT_SETTINGS["sup_coaching"] = SUP_COACHING
        if isinstance(EXTERNAL_CONTENT.get("sup_fails"), list) and EXTERNAL_CONTENT["sup_fails"]:
            SUP_FAILS = EXTERNAL_CONTENT["sup_fails"]
            DEFAULT_SETTINGS["sup_fails"] = SUP_FAILS


        if EXTERNAL_CONTENT.get("help_markdown"):
            global HELP_DOC_MARKDOWN
            HELP_DOC_MARKDOWN = EXTERNAL_CONTENT["help_markdown"].strip()
        if EXTERNAL_CONTENT.get("faq_markdown"):
            global FAQ_DOC_MARKDOWN
            FAQ_DOC_MARKDOWN = EXTERNAL_CONTENT["faq_markdown"].strip()
        if EXTERNAL_CONTENT.get("admin_setup_markdown"):
            global ADMIN_SETUP_MARKDOWN
            ADMIN_SETUP_MARKDOWN = EXTERNAL_CONTENT["admin_setup_markdown"].strip()

        # Update remaining keys to finished state
        for key in TRACKED_CONTENT_KEYS:
            if _content_source_status.get(key) and _content_source_status[key].get("background_loading"):
                _content_source_status[key]["background_status"] = "completed"
                _content_source_status[key]["background_loading"] = False

        logger.info("[CONTENT] background Google content refresh finished")

    except Exception as e:
        logger.exception("[CONTENT] Error during background Google content refresh: %s", e)
        # Update keys to failed state if something crashed
        for key in TRACKED_CONTENT_KEYS:
            if _content_source_status.get(key) and _content_source_status[key].get("background_loading"):
                _content_source_status[key]["background_status"] = "failed"
                _content_source_status[key]["background_loading"] = False

    # Perform shared sheet verification in thread pool executor
    try:
        logger.info("[STARTUP] shared sheet verification started")
        loop = asyncio.get_running_loop()
        shared_sheet_status = await loop.run_in_executor(None, _verify_master_shared_sheets)
        
        if shared_sheet_status.get("ok"):
            logger.info(
                "[STARTUP] Master shared sheet setup verified. spreadsheet=%s service_account_configured=%s",
                _mask_config_value(shared_sheet_status.get("spreadsheetId")),
                bool(shared_sheet_status.get("serviceAccountEmail")),
            )
        else:
            logger.error(
                "[STARTUP] Master shared sheet setup failed. error=%s",
                shared_sheet_status.get("error"),
            )
        logger.info("[STARTUP] shared sheet verification finished")
    except Exception as e:
        logger.exception("[STARTUP] Error during background shared sheet verification: %s", e)


@lru_cache(maxsize=1)
def _load_backend_runtime_config():
    for candidate in _runtime_config_candidates():
        try:
            if candidate.is_file():
                with candidate.open("r", encoding="utf-8") as f:
                    data = json.load(f)
                logger.info("[CONFIG] Loaded backend runtime config from %s", candidate)
                logger.info(
                    "[CONFIG] Notification sheet URL source: runtime_config notification_sheet_url=%s",
                    _mask_config_value(data.get("notification_sheet_url")),
                )
                _runtime_config_status.update({"path": str(candidate), "found": True, "error": ""})
                return data
        except Exception as exc:
            logger.warning("[CONFIG] Failed to load %s: %s", candidate, exc)
            _runtime_config_status.update({"path": str(candidate), "found": False, "error": str(exc)})
    logger.info("[CONFIG] No backend runtime config found")
    _runtime_config_status.update({"path": "", "found": False, "error": ""})
    return {}


def _slugify_label(value):
    text = re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower())
    return text.strip("-") or "item"


CALL_TYPES = [
    "New Donor - One Time Donation",
    "New Donor - New Sustaining Donation",
    "Existing Member - One Time Donation",
    "Existing Member - New Monthly Sustaining Donation",
    "Existing Member - Increase Current Sustaining Amount",
]

SUP_REASONS = [
    "Hung up on", "Charged for a cancelled sustaining", "Double Charged",
    "Damaged Gift", "Didn't Receive Gift", "Cancel Sustaining", "Use Own/Other",
]

# [Show Name, One-Time, Monthly, Gift]
SHOWS = [
    ["New Divas - Live in Vienna", "$216", "$18", "The New Divas - Best of Live in Vienna (CD) + Wine Glasses + PBS Retro Speaker"],
    ["Alan Jackson's Precious Memories", "$120", "$10", "2-CD Set"],
    ["Doo Wop Project", "$192", "$16", "Combo-DVD & 3 CDs"],
    ["Aging Backwards 3", "$240", "$20", "Aging Backwards 3: (DVD) + 4-DVD Workouts Set + Calendar + TV Subscription + HBK"],
    ["Great American Recipes", "$360", "$30", "Great American Recipes cookbook and Finding Your Roots companion book (HBK)"],
    ["Easy Yoga", "$144", "$12", "Easy Yoga for Everything 10 DVD combo"],
]

# [First, Last, Address, City, State, Zip, Phone, Email]
NEW_DONORS = [
    ["Sam", "Smith", "400 N Broad St", "Philadelphia", "PA", "19130", "215-515-1212", "ssmith@test.com"],
    ["Harold", "Smith", "3686 Village Dr Apt. D", "Franklin", "OH", "45005", "858-555-1212", "sally@test.com"],
    ["Harry", "Smith", "P.O. Box 6", "Atlasburg", "PA", "15004", "602-515-1212", "testentry@test.com"],
    ["Mark", "Jackson", "1020 Holland Ave", "Port Huron", "MI", "48060", "310-515-1212", "mjtest@test.com"],
]

EXISTING_MEMBERS = [
    ["Ron", "Jones", "3345 W. Auburn Rd, Apt 207", "Rochester Hills", "MI", "48309", "858-555-1212", "michele@test.com"],
    ["Diane/James", "Williams", "8150 Priestley Dr", "Reynoldsburg", "OH", "43068", "619-555-1212", "DandJ@test.com"],
    ["Harry", "Jones", "876 McDonald Ave", "Brooklyn", "NY", "11218", "619-555-1212", "test@test.com"],
]

INCREASE_SUSTAINING = [
    ["Alison", "DeRudder", "2200 N Hillman Rd", "Stanton", "MI", "48888", "801-555-1212", "TESTENTRY@TEST.COM"],
    ["Sherri", "Testing", "104 Newport Dr", "Boardman", "OH", "44512", "(801) 555-1217", "TESTENTRY@TEST.COM"],
]

DISCORD_TEMPLATES = [
    ["Discord unavailable", "Discord post templates are unavailable. Check Google Sheet access or packaged local defaults."],
]

DEFAULT_PAYMENT = {
    "cc_type": "American Express",
    "cc_number": "3782 822463 10005",
    "cc_exp": "07/2027",
    "cc_cvv": "1928",
    "eft_routing": "021000021",
    "eft_account": "1357902468",
}

TECH_ISSUES = [
    "Internet speed issues",
    "Calls would not route",
    "No script pop",
    "Discord issues",
    "Other",
]

AUTO_FAIL_REASONS = [
    "NC/NS",
    "Stopped responding in chat",
    "Not ready for session",
    "Unable to turn off VPN",
    "Wrong headset (not USB)",
    "Wrong headset (not noise cancelling)",
]

TICKER_MESSAGES = [
    f"Welcome to Mock Testing Suite v{APP_VERSION}.",
    "Complete The Basics before beginning call review.",
    "Review headset requirements before certification begins.",
    "Use Discord copy templates when posting session updates.",
    "Confirm VPN/proxy checks manually when automated coverage is limited.",
    "Remember to review final readiness before submitting results.",
    "If Google Sheets is unavailable, continue using local fallback guidance.",
    "Tip: Use the Discord Post button to quickly copy common messages.",
]

DEFAULT_FORM_URL = "https://forms.office.com/pages/responsepage.aspx?id=3KFHNUeYz0mR2noZwaJeQnNAxP4sz6FBkEyNHMuYWT1URDZKWk1RWDU2VjRLTEZKNUxCWU1RRFlUVS4u&route=shorturl"
TRUSTED_MICROSOFT_FORM_HOSTS = {
    "forms.office.com",
    "forms.microsoft.com",
}


def _validate_microsoft_form_url(form_url):
    parsed = urlparse(str(form_url or "").strip())
    host = (parsed.hostname or "").strip().lower()
    if parsed.scheme != "https" or host not in TRUSTED_MICROSOFT_FORM_HOSTS:
        return False, "Cert Form URL must use a trusted Microsoft Forms domain."
    return True, ""

DISCORD_SCREENSHOTS = [
    {"title": "Welcome New Agent", "image_url": "/welcome-new-agent.png"},
    {"title": "Welcome to Stars", "image_url": "/welcome-to-stars.png"},
    {"category": "Headset Connections", "title": "USB Connection", "image_url": "/usb.png"},
    {"category": "Headset Connections", "title": "3.5 mm connections", "image_url": "/3.5mm.png"},
]

CALL_COACHING = [
    {"id": "c-show-app", "label": "Show appreciation", "children": ["For Current/Existing Donors", "After donation amount is given"]},
    {"id": "c-dontask", "label": "Don't Ask, Just Verify Address and Phone Number", "helper": "Existing member already provided address and phone number"},
    {"id": "c-verify", "label": "Verification", "children": ["Name", "Address", "Phone", "Email", "Card/EFT"]},
    {"id": "c-verbatim", "label": "Read script verbatim", "helper": "No adlibbing or skipping sections"},
    {"id": "c-nav", "label": "Use effective script navigation", "children": ["Scroll down to avoid missing parts of the script", "Use the Back and Next buttons and not the Icons"]},
    {"id": "c-search-name", "label": "Search name for every call", "helper": "Search the caller's name on every call to avoid duplicate member records."},
    {"id": "c-no-volunteer", "label": "Do not volunteer information", "helper": "Do not verify details the member has not provided, such as an email address."},
    {"id": "active_listening_no_repeat", "label": "Use active listening and avoid repeating questions the caller has already answered."},
    {"id": "avoid_interrupting_caller", "label": "Avoid interrupting or speaking over the caller."},
    {"id": "warm_professional_tone_language", "label": "Maintain a warm, professional tone and use clear, professional language."},
    {"id": "c-other", "label": "Other"},
]

CALL_FAILS = [
    "Skipped parts of script",
    "Volunteered info",
    "Wrong donation",
    "Background noise on call",
    "Paraphrased script",
    "Wrong thank you gift",
    "Did not search for member",
    "Script navigation issues",
    "Other",
]

SUP_COACHING = [
    {"label": "Minimize dead air", "helper": "Maintain engagement throughout hold and transfer"},
    {"label": "Queue Not Changed", "helper": "Did not change queue to ACD Direct Supervisor"},
    {"label": "Caller Placed On Hold"},
    {"label": "Verification", "children": ["Name", "Address", "Phone", "Email", "Card/EFT"]},
    {"label": "Discord permission", "helper": "Ask explicit permission to transfer via Discord"},
    {"label": "Did not notify caller of transfer", "helper": "Notify caller before transferring"},
    {"label": "Screenshots/Discord Chat", "helper": "Coached with standard instructions and screenshots"},
    {"label": "Search name for every call", "helper": "Search the caller's name on every call to avoid duplicate member records."},
    {"label": "Do not volunteer information", "helper": "Do not verify details the member has not provided, such as an email address."},
    {"label": "Other"},
]

REQUIRED_COACHING_DEFAULT_LABELS = {
    "call_coaching": {
        "search name for every call",
        "do not volunteer information",
        "use active listening and avoid repeating questions the caller has already answered.",
        "avoid interrupting or speaking over the caller.",
        "maintain a warm, professional tone and use clear, professional language.",
    },
    "sup_coaching": {
        "search name for every call",
        "do not volunteer information",
    },
}


def _canonical_coaching_label(value):
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _copy_coaching_item(item):
    copied = {}
    for key, value in (item or {}).items():
        copied[key] = list(value) if isinstance(value, list) else value
    return copied


def _merge_required_coaching_defaults(section_key, items):
    required = REQUIRED_COACHING_DEFAULT_LABELS.get(section_key)
    if not required or not isinstance(items, list):
        return items

    defaults_by_label = {
        _canonical_coaching_label(item.get("label")): item
        for item in _coaching_fallback(section_key)
        if _canonical_coaching_label(item.get("label")) in required
    }
    merged = [_copy_coaching_item(item) if isinstance(item, dict) else item for item in items]
    existing_by_label = {}
    for item in merged:
        if not isinstance(item, dict):
            continue
        label = _canonical_coaching_label(item.get("label") or item.get("Label"))
        if label and label not in existing_by_label:
            existing_by_label[label] = item

    for label, default_item in defaults_by_label.items():
        existing = existing_by_label.get(label)
        if existing is None:
            merged.append(_copy_coaching_item(default_item))
            continue
        for field in ("id", "helper", "children"):
            if field in default_item and not existing.get(field):
                existing[field] = list(default_item[field]) if isinstance(default_item[field], list) else default_item[field]
    return merged

SUP_FAILS = [
    "Did not ask permission to transfer",
    "Did not minimize dead air",
    "Caller Placed On Hold",
    "Transferred to wrong queue",
    "Did not inform caller of transfer",
    "Other",
]

HELP_CONTENT = {
    "howto": [
        {
            "title": "Setup Wizard and Preferences",
            "paragraphs": [
                "The first launch setup captures tester identity, form links, ticker speed, welcome voice, and sound volume."
            ],
            "bullets": [
                "<b>Display Name</b> - Optional. If blank, the app uses the first name from Tester Name.",
                "<b>Ticker Speed</b> - Defaults to Normal and can be changed later in Settings.",
                "<b>Welcome Voice</b> - Choose Male or Female. Female welcome audio files use -f before .mp3.",
                "<b>Sound Volume</b> - Controls welcome audio and app sound effects.",
            ],
        },
        {
            "title": "Home Screen",
            "paragraphs": [
                "The Home screen is your dashboard. It shows your stats (Total Sessions, Pass Rate, NC/NS Rate) and recent sessions."
            ],
            "bullets": [
                "<b>Start New Session</b> - Begin a full mock call + supervisor transfer session",
                "<b>Supervisor Transfer Only</b> - Used when a candidate previously ran out of time and only needs supervisor transfers",
                "<b>Session History</b> - View all past sessions with search and detail views",
            ],
        },
        {
            "title": "The Basics Screen",
            "paragraphs": [
                "This is the first step in every session. You'll verify the candidate's setup.",
                "<b>Footer buttons:</b>",
            ],
            "bullets": [
                "<b>Tester Name</b> - Auto-filled from your settings",
                "<b>Candidate Name</b> - Type the candidate's full name (required)",
                "<b>Final Attempt</b> - Mark whether this is the candidate's last allowed mock session",
                "<b>Headset</b> - Must be USB with noise-cancelling microphone. If not, auto-fails",
                "<b>VPN</b> - If they have one, they must turn it off. If they can't, auto-fails",
                "<b>Browser</b> - Must be default, extensions off, pop-ups allowed",
                "<b style=\"color: var(--color-danger)\">NC/NS</b> - No Call / No Show. Instantly fails and goes to Review",
                "<b style=\"color: var(--color-danger)\">Not Ready</b> - Candidate wasn't prepared for the session",
                "<b style=\"color: var(--color-danger)\">Stopped Responding</b> - Candidate went silent in Discord",
                "<b>Tech Issue</b> - Opens the Technical Issues dialog for troubleshooting",
            ],
        },
        {
            "title": "Calls Screen (Up to 3)",
            "paragraphs": [
                "You'll grade up to 3 mock calls. The scenario card shows you exactly who to portray.",
                "<b>Routing logic:</b> 2 passes (1 New Donor + 1 Existing Member) → Sup Transfers. 2 fails → session ends. 1+1 → Call 3.",
            ],
            "bullets": [
                "<b>Call Setup</b> - Select Call Type, Show, Caller, and Donation from the dropdowns",
                "<b>Scenario Card</b> - Shows the caller's info, gift, and randomized variables (Phone Type, SMS, E-Newsletter, Shipping, CC Fee)",
                "<b>Regenerate</b> - Re-rolls the random scenario variables without changing the call data",
                "<b>Payment Simulation</b> - Shows the saved Credit Card and EFT options from Settings. Each new call starts on Default.",
                "<b>Pass/Fail</b> - Click PASS or FAIL after the call",
                "<b>Coaching</b> - Select coaching checkboxes (required - if none selected, you'll be asked to confirm). Search name for every call and Do not volunteer information are available when those topics were coached.",
                "<b>Fail Reasons</b> - If FAIL, you must select at least one fail reason. Use + Add detail for optional reason-specific context; Other still uses the regular notes box.",
            ],
        },
        {
            "title": "Supervisor Transfer Screen (Up to 2)",
            "paragraphs": [
                "Tests the candidate's ability to transfer to a supervisor. Same coaching/fail flow as calls, including optional + Add detail fields for checked fail reasons."
            ],
            "bullets": [
                "Post \"WXYZ: Supervisor Test Call Being Queued\" in Discord Stars channel",
                "Call the WXYZ number: <b>1-828-630-7006</b>",
                "Payment dropdowns use saved Settings options and start on Default for each Supervisor Transfer.",
                "Pass Transfer 1 → done (go to Review). Fail both → Newbie Shift.",
            ],
        },
        {
            "title": "Smart Resume for Supervisor Transfer Only",
            "paragraphs": [
                "The Smart Resume flow helps you continue a candidate into Supervisor Transfer when the mock calls were already completed in an earlier session."
            ],
            "bullets": [
                "<b>When it appears</b> - Click <b>Supervisor Transfer Only</b> from Home, then answer <b>Yes</b> when asked if you previously conducted the mock session for that candidate.",
                "<b>How it finds sessions</b> - The app looks through saved history for prior mock-call sessions tied to the current tester name in Settings. It only shows sessions that already have mock call results and have not already completed supervisor transfers.",
                "<b>What you’ll see</b> - If matching sessions exist, a resume picker opens so you can choose the right candidate. If none exist, the app tells you there are no resumable sessions for that tester.",
                "<b>How to continue</b> - Select the candidate, confirm the prompt, and the app restores the earlier Basics and mock-call data, then opens directly on <b>Supervisor Transfer #1</b>.",
            ],
        },
        {
            "title": "Newbie Shift Screen",
            "paragraphs": [
                "Only appears when the candidate needs a follow-up session. Pick a date, time, and timezone."
            ],
            "bullets": [
                "Enter the date using the date picker or type in MM/DD/YYYY format",
                "Enter time as H:MM (e.g. 10:30)",
                "<b>Add to Google Calendar</b> - Creates an event titled \"Supervisor Test Call - [Candidate Name]\"",
            ],
        },
        {
            "title": "Review Screen",
            "paragraphs": [
                "Final review of the session. The Pass/Fail/Incomplete banner is calculated automatically."
            ],
            "bullets": [
                "<b>Coaching Summary</b> - Generated from your coaching checkboxes (or Gemini AI if enabled)",
                "<b>Fail Summary</b> - Generated from fail reasons (N/A for passing sessions)",
                "<b>Final Readiness Judgment</b> - Keep the calculated result or override it with a final evaluator result and reason.",
                "<b>Copy</b> - Copies the summary text to your clipboard",
                "<b>Regenerate</b> - Rebuilds the summary from checkbox data",
                "<b>Fill Form</b> - Opens the Cert Form and maps session data to form fields",
                "<b>Save & Finish</b> - Saves to history and clears the session",
            ],
        },
        {
            "title": "Discord Post Panel",
            "paragraphs": [
                "Click \"Discord Post\" in the sidebar to open the panel with two tabs:"
            ],
            "bullets": [
                "<b>Templates</b> - Pre-written messages for Pass, Fail, Sup Intro, etc. Click \"Copy\" to copy to clipboard",
                "<b>Screenshots</b> - Welcome images that can be copied to clipboard for Discord. Click \"Copy Image\" to copy",
                "<b>Category</b> - When configured, use the category filter to group templates and screenshots.",
                "Both tabs remain searchable within the selected category",
            ],
        },
        {
            "title": "Settings Payment Options",
            "paragraphs": [
                "Settings starts with 3 Credit Card defaults and 3 EFT defaults for payment simulation."
            ],
            "bullets": [
                "Admins or evaluators can add or remove payment options without removing the Default starting point.",
                "Saved options appear in Calls and Supervisor Transfer payment dropdowns.",
                "Each new Call and Supervisor Transfer starts the dropdowns on Default.",
            ],
        },
        {
            "title": "Tech Issue Button",
            "paragraphs": [
                "Available on every session screen. Opens a troubleshooting wizard:"
            ],
            "bullets": [
                "<b>Internet Speed</b> - Asks for speed test results. Below 25 Mbps down / 10 Mbps up = fail",
                "<b>Calls Won't Route</b> - Checks DTE status, then browser troubleshooting",
                "<b>No Script Pop</b> - Browser troubleshooting steps",
                "<b>Discord/Other</b> - Manual notes with resolution tracking",
            ],
        },
    ],
    "flows": [
        {
            "title": "Standard Full Session",
            "paragraphs": [
                "The Basics → Call 1 → Call 2 → (Call 3 if needed) → Sup Transfer 1 → (Sup Transfer 2 if needed) → Review → Save",
                "<b>Pass conditions:</b> 2 passed calls (1 New Donor + 1 Existing) AND 1 passed Sup Transfer.",
            ],
        },
        {
            "title": "Supervisor Transfer Only",
            "paragraphs": [
                "Used when the candidate previously completed mock calls but still needs supervisor transfers."
            ],
            "bullets": [
                "If you answer <b>No</b> to the resume prompt, the app starts a fresh Supervisor Transfer Only flow through Basics and then routes straight to Supervisor Transfer.",
                "If you answer <b>Yes</b>, Smart Resume searches your saved history for prior mock-call sessions completed by the current tester and lets you continue the correct candidate into Supervisor Transfer.",
            ],
        },
        {
            "title": "Newbie Shift (Incomplete)",
            "paragraphs": [
                "If the candidate fails both Sup Transfers or can't complete due to tech issues, a Newbie Shift is scheduled. The session is marked \"Incomplete\" rather than \"Fail\"."
            ],
        },
        {
            "title": "Auto-Fail Scenarios",
            "bullets": [
                "<b>NC/NS</b> - No Call / No Show",
                "<b>Stopped Responding</b> - Candidate went silent in Discord",
                "<b>Not Ready</b> - Incorrect setup, can't log in",
                "<b>Wrong Headset</b> - Not USB or not noise-cancelling",
                "<b>VPN</b> - Using VPN and can't turn it off",
            ],
        },
    ],
    "integrations": [
        {
            "title": "Gemini AI - Smart Summaries",
            "paragraphs": [
                "When enabled, Gemini creates clean coaching and fail summaries from the coaching and fail reason checkboxes you selected during the session."
            ],
            "footer": "Gemini uses the session's coaching and fail selections to write a cleaner summary automatically when Review loads.",
        },
        {
            "title": "Google Calendar",
            "paragraphs": [
                "The \"Add to Google Calendar\" button on the Newbie Shift screen creates a calendar event. No setup needed - it uses a Google Calendar URL template."
            ],
        },
    ],
    "faq": [
        {"q": "What if the candidate stops responding?", "a": "Click the red \"Stopped Responding\" button. This instantly ends the session as a fail."},
        {"q": "What if the candidate has technical issues?", "a": "Click \"Tech Issue\". The app walks you through troubleshooting: check DTE status, clear browsing data, re-login."},
        {"q": "Can I go back and change something?", "a": "Yes - click \"Back\" on any screen. Your data is saved as you go."},
        {"q": "What if I forget to select coaching?", "a": "The app will ask you to confirm if you want to continue without coaching."},
        {"q": "How do I do a Supervisor Transfer ONLY session?", "a": "On the Home screen, click \"Supervisor Transfer Only\". This skips Mock Calls."},
        {"q": "What does \"Final Attempt\" mean?", "a": "Use this on The Basics screen when the candidate is on their last allowed attempt. The app uses it in the session flow and messaging."},
        {"q": "How does Smart Resume find a candidate for Supervisor Transfer Only?", "a": "It searches saved history for prior mock-call sessions that belong to the current tester, already have mock call results, and do not already have completed supervisor transfers."},
        {"q": "What if 2 calls fail?", "a": "The session ends immediately and goes to Review. They should reschedule within 24 hours."},
        {"q": "Where is my data stored?", "a": "In the app's local database."},
        {"q": "How do I customize the Discord templates?", "a": "Go to Settings → Discord tab. You can add, edit, and remove both message templates and screenshot images."},
        {"q": "Can I edit the caller data and shows?", "a": "Yes - go to Settings. The Call Types, Shows, Callers, and Sup Reasons tabs let you fully customize all scenario data."},
    ],
    "support": {
        "intro": "Need help with the app? Reach out using one of these options:",
        "email": "blyshawnp@gmail.com",
        "discord_name": "shawnbly",
        "discord_url": "https://discord.com/users/shawnbly",
        "footer": "Include a description of the issue, what screen you were on, and any error messages you saw.",
    },
}


def _strip_help_markup(text):
    return re.sub(r"<[^>]+>", "", str(text or "")).strip()


def _build_help_markdown_fallback():
    sections = ["# Mock Testing Suite Help", ""]
    for group_label, key in (("How To", "howto"), ("Session Flows", "flows"), ("Integrations", "integrations")):
        entries = HELP_CONTENT.get(key) or []
        if not entries:
            continue
        sections.append(f"## {group_label}")
        sections.append("")
        for entry in entries:
            title = _strip_help_markup(entry.get("title"))
            if title:
                sections.append(f"### {title}")
            for paragraph in entry.get("paragraphs") or []:
                cleaned = _strip_help_markup(paragraph)
                if cleaned:
                    sections.append(cleaned)
            for bullet in entry.get("bullets") or []:
                cleaned = _strip_help_markup(bullet)
                if cleaned:
                    sections.append(f"- {cleaned}")
            footer = _strip_help_markup(entry.get("footer"))
            if footer:
                sections.append(footer)
            sections.append("")
    support = HELP_CONTENT.get("support") or {}
    sections.extend([
        "## Support",
        "",
        _strip_help_markup(support.get("intro")),
        f"- Email: {_strip_help_markup(support.get('email'))}",
        f"- Discord: {_strip_help_markup(support.get('discord_name'))}",
        _strip_help_markup(support.get("footer")),
        "",
    ])
    return "\n".join(line for line in sections if line is not None).strip() + "\n"


def _build_faq_markdown_fallback():
    lines = ["# Mock Testing Suite FAQ", ""]
    for item in HELP_CONTENT.get("faq") or []:
        question = _strip_help_markup(item.get("q"))
        answer = _strip_help_markup(item.get("a"))
        if not question or not answer:
            continue
        lines.append(f"## {question}")
        lines.append(answer)
        lines.append("")
    return "\n".join(lines).strip() + "\n"


def _default_admin_setup_markdown():
    return """# Mock Testing Suite Admin Setup

Packaged defaults live in `backend/defaults/`. These files are the offline fallback source for runtime defaults.

Priority order:
1. User-saved SQLite settings
2. Google Sheets or Google Docs remote admin overrides
3. Packaged local master files in `backend/defaults/`
4. Built-in code fallback

The Google Sheet tab names must match the local file base names exactly:
- `callers`
- `shows`
- `call-types`
- `sup-reasons`
- `call-coaching`
- `sup-coaching`
- `call-fail-reasons`
- `sup-fail-reasons`
- `discord-posts`
- `screenshots`
- `headsets`

`help.md` and `faq.md` are local markdown defaults. If Google Doc overrides are configured and available, they replace those local files for runtime help content.

`gemini-coaching-prompt.md` and `gemini-fail-prompt.md` are the primary Gemini summary prompts. Google Sheet tabs named `gemini-coaching-prompt` and `gemini-fail-prompt` are optional overrides only when A1 is `prompt`, A2 contains the full prompt, and the normalized content differs from the bundled markdown file.
"""


EXTERNAL_CONTENT = _load_external_content()

if isinstance(EXTERNAL_CONTENT.get("call_types"), list) and EXTERNAL_CONTENT["call_types"]:
    CALL_TYPES = EXTERNAL_CONTENT["call_types"]

if isinstance(EXTERNAL_CONTENT.get("sup_reasons"), list) and EXTERNAL_CONTENT["sup_reasons"]:
    SUP_REASONS = EXTERNAL_CONTENT["sup_reasons"]

if isinstance(EXTERNAL_CONTENT.get("shows"), list) and EXTERNAL_CONTENT["shows"]:
    SHOWS = EXTERNAL_CONTENT["shows"]

if isinstance(EXTERNAL_CONTENT.get("donors_new"), list) and EXTERNAL_CONTENT["donors_new"]:
    NEW_DONORS = EXTERNAL_CONTENT["donors_new"]

if isinstance(EXTERNAL_CONTENT.get("donors_existing"), list) and EXTERNAL_CONTENT["donors_existing"]:
    EXISTING_MEMBERS = EXTERNAL_CONTENT["donors_existing"]

if isinstance(EXTERNAL_CONTENT.get("donors_increase"), list) and EXTERNAL_CONTENT["donors_increase"]:
    INCREASE_SUSTAINING = EXTERNAL_CONTENT["donors_increase"]

if isinstance(EXTERNAL_CONTENT.get("discord_templates"), list) and EXTERNAL_CONTENT["discord_templates"]:
    DISCORD_TEMPLATES = EXTERNAL_CONTENT["discord_templates"]

if isinstance(EXTERNAL_CONTENT.get("discord_screenshots"), list) and EXTERNAL_CONTENT["discord_screenshots"]:
    DISCORD_SCREENSHOTS = EXTERNAL_CONTENT["discord_screenshots"]

if isinstance(EXTERNAL_CONTENT.get("call_coaching"), list) and EXTERNAL_CONTENT["call_coaching"]:
    CALL_COACHING = EXTERNAL_CONTENT["call_coaching"]

if isinstance(EXTERNAL_CONTENT.get("call_fails"), list) and EXTERNAL_CONTENT["call_fails"]:
    CALL_FAILS = _merge_required_fail_reasons(EXTERNAL_CONTENT["call_fails"], "call_fails")

if isinstance(EXTERNAL_CONTENT.get("sup_coaching"), list) and EXTERNAL_CONTENT["sup_coaching"]:
    SUP_COACHING = EXTERNAL_CONTENT["sup_coaching"]

if isinstance(EXTERNAL_CONTENT.get("sup_fails"), list) and EXTERNAL_CONTENT["sup_fails"]:
    SUP_FAILS = EXTERNAL_CONTENT["sup_fails"]

HELP_DOC_MARKDOWN = (EXTERNAL_CONTENT.get("help_markdown") or "").strip() or _build_help_markdown_fallback()
FAQ_DOC_MARKDOWN = (EXTERNAL_CONTENT.get("faq_markdown") or "").strip() or _build_faq_markdown_fallback()
ADMIN_SETUP_MARKDOWN = (EXTERNAL_CONTENT.get("admin_setup_markdown") or "").strip() or _default_admin_setup_markdown()


def _record_builtin_sources():
    """Mark any tracked content key that didn't get supplied by remote/local
    as ``builtin``, so /api/config-status reports an honest source for every
    section and the startup log lists exactly what each section is using."""
    builtin_values = {
        "donors_new": NEW_DONORS,
        "donors_existing": EXISTING_MEMBERS,
        "donors_increase": INCREASE_SUSTAINING,
        "call_types": CALL_TYPES,
        "sup_reasons": SUP_REASONS,
        "shows": SHOWS,
        "call_coaching": CALL_COACHING,
        "sup_coaching": SUP_COACHING,
        "call_fails": CALL_FAILS,
        "sup_fails": SUP_FAILS,
        "discord_templates": DISCORD_TEMPLATES,
        "discord_screenshots": DISCORD_SCREENSHOTS,
        "approved_headsets": EXTERNAL_CONTENT.get("approved_headsets") or [],
        "help_markdown": HELP_DOC_MARKDOWN,
        "faq_markdown": FAQ_DOC_MARKDOWN,
        "admin_setup_markdown": ADMIN_SETUP_MARKDOWN,
    }
    for key in TRACKED_CONTENT_KEYS:
        if key == "discord_templates":
            current = _content_source_status.get(key) or {}
            if not current or ((current.get("source") or "builtin") == "builtin" and not int(current.get("count") or 0)):
                logger.warning("[DISCORD DEFAULTS] Using emergency hardcoded fallback because Google and local defaults were empty.")
                _set_content_source(key, "emergency_hardcoded", builtin_values.get(key, []), ok=True, detail="Google and local defaults were empty")
        elif key not in _content_source_status:
            _set_content_source(key, "builtin", builtin_values.get(key, []), ok=True)


_record_builtin_sources()


def _log_content_source_summary():
    if not _content_source_status:
        return
    parts = [
        f"{key}={info.get('source', 'builtin')}({info.get('count', 0)})"
        for key, info in sorted(_content_source_status.items())
    ]
    logger.info("[CONTENT] Source summary - %s", ", ".join(parts))


_log_content_source_summary()


def _content_source_summary_payload():
    return {
        key: {
            "source": info.get("source") or "builtin",
            "count": int(info.get("count") or 0),
            "ok": bool(info.get("ok", True)),
            "detail": info.get("detail") or "",
        }
        for key, info in sorted(_content_source_status.items())
    }


def _runtime_diagnostics_payload():
    runtime_config = _load_backend_runtime_config()
    creds_path = _early_service_account_file()
    credential_info = _read_service_account_public_info(creds_path)
    notification_config = {}
    try:
        notification_config = _get_admin_notification_sheet_config()
    except Exception as exc:
        notification_config = {"source": "error", "error": str(exc)}
    master_spreadsheet_id = _resolve_content_sheet_id(runtime_config or {})
    resources_root = (os.getenv("APP_RESOURCES_PATH") or "").strip()
    payload = {
        "mode": _packaged_runtime_mode(),
        "isPackaged": _is_packaged_runtime(),
        "appResourcesPathConfigured": bool(resources_root),
        "packagedLogConfigured": bool(PACKAGED_BACKEND_LOG_PATH),
        "runtimeConfig": {
            "candidateCount": len(_runtime_config_candidates()),
            "file": _safe_file_label(_runtime_config_status.get("path") or ""),
            "exists": bool(_runtime_config_status.get("found")),
            "error": _runtime_config_status.get("error") or "",
        },
        "googleServiceAccount": {
            "candidateCount": len([
                path
                for path in [
                    Path((os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE") or "").strip()).expanduser()
                    if (os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE") or "").strip() else None,
                    Path(resources_root) / "backend" / "config" / "google-service-account.json" if resources_root else None,
                    Path(sys.executable).resolve().parent / "config" / "google-service-account.json" if getattr(sys, "frozen", False) else None,
                    ROOT_DIR / "config" / "google-service-account.json",
                ]
                if path
            ]),
            "file": credential_info.get("file") or "",
            "exists": bool(credential_info.get("exists")),
            "clientEmailConfigured": bool(credential_info.get("client_email_configured")),
            "privateKeyIdConfigured": bool(credential_info.get("private_key_id_configured")),
            "error": credential_info.get("error") or "",
        },
        "spreadsheetIdPresent": bool(master_spreadsheet_id),
        "spreadsheetIdMasked": _mask_config_value(master_spreadsheet_id),
        "notificationConfig": {
            "source": notification_config.get("source") or "",
            "configured": bool(notification_config.get("configured")),
            "sheetIdPresent": bool(notification_config.get("sheet_id")),
            "sheetIdMasked": _mask_config_value(notification_config.get("sheet_id")),
            "gid": notification_config.get("gid") or "",
            "error": notification_config.get("error") or "",
        },
        "contentSourceSummary": _content_source_summary_payload(),
        "shadowComparison": (
            _shadow_runtime.diagnostics()
            if _shadow_runtime is not None
            else {
                "enabled": False,
                "pending": 0,
                "telemetryCount": 0,
                "statusCounts": {},
            }
        ),
        "lastGoogleSheetAuthStatus": dict(_google_sheet_auth_status),
        "lastGoogleSheetContentLoadErrors": list(_google_sheet_content_errors),
    }
    return payload


def _log_startup_runtime_diagnostics():
    global _startup_runtime_diagnostics
    diagnostics = _runtime_diagnostics_payload()
    _startup_runtime_diagnostics = diagnostics
    credential = diagnostics.get("googleServiceAccount") or {}
    runtime_config = diagnostics.get("runtimeConfig") or {}
    notification = diagnostics.get("notificationConfig") or {}
    content_summary = diagnostics.get("contentSourceSummary") or {}
    compact_sources = ", ".join(
        f"{key}={value.get('source')}({value.get('count')})"
        for key, value in sorted(content_summary.items())
    )
    logger.info(
        "[RUNTIME] mode=%s packaged=%s resources_configured=%s packaged_log_configured=%s",
        diagnostics.get("mode"),
        diagnostics.get("isPackaged"),
        diagnostics.get("appResourcesPathConfigured"),
        diagnostics.get("packagedLogConfigured"),
    )
    logger.info(
        "[RUNTIME] runtime_config exists=%s file=%s spreadsheet=%s notification_source=%s notification_sheet=%s",
        runtime_config.get("exists"),
        runtime_config.get("file"),
        diagnostics.get("spreadsheetIdMasked"),
        notification.get("source"),
        notification.get("sheetIdMasked"),
    )
    logger.info(
        "[RUNTIME] google_service_account exists=%s file=%s client_email_configured=%s private_key_id_configured=%s",
        credential.get("exists"),
        credential.get("file"),
        bool(credential.get("clientEmailConfigured")),
        bool(credential.get("privateKeyIdConfigured")),
    )
    logger.info("[RUNTIME] content_source_summary=%s", compact_sources)
    return diagnostics


DEFAULT_SUPPORT_FORM_URL = "https://forms.gle/h3L8BZcFqpZ8RZf39"
DEFAULT_SETTINGS = {
    "setup_complete": False,
    "sam_setup_complete": False,
    "sam_user_name": "",
    "sam_user_role": "",
    "tutorial_completed": False,
    "tester_name": "",
    "display_name": "",
    "form_fill_browser": "auto",
    "form_url": DEFAULT_FORM_URL,
    "cert_sheet_url": DEFAULT_CERT_SHEET_URL,
    "support_form_url": DEFAULT_SUPPORT_FORM_URL,
    "vpnProxyCheckMode": "checker",
    "ticker_speed": "normal",
    "enable_sounds": True,
    "sound_volume": "medium",
    "welcome_voice": "male",
    "theme": "dark",
    "enable_gemini": True,
    "gemini_api_key": "",
    "enable_calendar": False,
    "discord_templates": DISCORD_TEMPLATES,
    "discord_screenshots": DISCORD_SCREENSHOTS,
    "payment": DEFAULT_PAYMENT,
    "shows": SHOWS,
    "call_types": CALL_TYPES,
    "sup_reasons": SUP_REASONS,
    "donors_new": NEW_DONORS,
    "donors_existing": EXISTING_MEMBERS,
    "donors_increase": INCREASE_SUSTAINING,
    "call_coaching": CALL_COACHING,
    "call_fails": CALL_FAILS,
    "sup_coaching": SUP_COACHING,
    "require_newbie_shift_approval": True,
    "headset_notification_mode": "all",
}

GEMINI_API_KEY_SETTING = "gemini_api_key"
LEGACY_GEMINI_API_KEY_SETTINGS = ("gemini_key",)
SENSITIVE_SETTINGS_KEYS = {GEMINI_API_KEY_SETTING}
ADMIN_ONLY_SETTINGS_KEYS = set()
ADMIN_CONTROLLED_SETTINGS_KEYS = {
    "require_newbie_shift_approval",
    "headset_notification_mode",
}
ALLOWED_SETTINGS_KEYS = set(DEFAULT_SETTINGS.keys()) - ADMIN_ONLY_SETTINGS_KEYS
PRESERVED_SETTINGS_KEYS_ON_RESTORE = {
    "setup_complete",
    "sam_setup_complete",
    "sam_user_name",
    "sam_user_role",
    "tutorial_completed",
    "tester_name",
    "display_name",
    "form_url",
    "cert_sheet_url",
    "support_form_url",
    "require_newbie_shift_approval",
    "headset_notification_mode",
    GEMINI_API_KEY_SETTING,
    "enable_gemini",
}


def _get_stored_gemini_api_key(settings: Optional[dict]) -> str:
    settings = settings or {}
    for key in (GEMINI_API_KEY_SETTING, *LEGACY_GEMINI_API_KEY_SETTINGS):
        value = str(settings.get(key) or "").strip()
        if value and not _is_masked_sensitive_placeholder(value):
            return value
    return ""


def _is_masked_sensitive_placeholder(value) -> bool:
    text = str(value or "").strip()
    return bool(text) and set(text) <= {"*"}


def _is_newbie_shift_approval_required() -> bool:
    try:
        doc = db.settings._read_document("app_settings")
        if doc and "require_newbie_shift_approval" in doc:
            return bool(doc.get("require_newbie_shift_approval"))
    except Exception:
        pass
    return True


def _get_headset_notification_mode() -> str:
    try:
        doc = db.settings._read_document("app_settings")
        if doc and "headset_notification_mode" in doc:
            return _normalize_headset_notification_mode(doc.get("headset_notification_mode"))
    except Exception:
        pass
    return "all"


def _sanitize_fail_reason_setting(key, value, source_label):
    if key not in {"call_fails", "sup_fails"}:
        return value
    if not isinstance(value, list):
        return value
    values = [str(item or "").strip() for item in value if str(item or "").strip()]
    if _values_look_like_headsets(values):
        logger.warning(
            "[CONTENT] %s %s setting contains headset-like values and was ignored. Using defaults.",
            source_label,
            key,
        )
        return DEFAULT_SETTINGS[key]
    if any(
        isinstance(item, (dict, list, tuple))
        or "discord" in str(item or "").lower()
        or "screenshot" in str(item or "").lower()
        for item in value
    ):
        logger.warning(
            "[CONTENT] %s %s setting contains wrong-shaped values and was ignored. Using defaults.",
            source_label,
            key,
        )
        return DEFAULT_SETTINGS[key]
    if _values_match_other_section(values, key):
        logger.warning(
            "[CONTENT] %s %s setting looked like the wrong fail-reason section. Using defaults.",
            source_label,
            key,
        )
        return DEFAULT_SETTINGS[key]
    return value


def _sanitize_coaching_setting(key, value, source_label):
    if key not in {"call_coaching", "sup_coaching"}:
        return value
    if not isinstance(value, list):
        logger.warning("[CONTENT] %s %s setting was not a list and was ignored. Using defaults.", source_label, key)
        return DEFAULT_SETTINGS[key]
    labels = []
    for item in value:
        if not isinstance(item, dict):
            logger.warning("[CONTENT] %s %s setting had non-object coaching rows. Using defaults.", source_label, key)
            return DEFAULT_SETTINGS[key]
        label = str(item.get("label") or item.get("Label") or "").strip()
        if label:
            labels.append(label)
    if _values_look_like_headsets(labels) or any("discord post" in label.lower() or "imagepath" in label.lower() for label in labels):
        logger.warning("[CONTENT] %s %s setting looked like non-coaching data. Using defaults.", source_label, key)
        return DEFAULT_SETTINGS[key]
    if _values_match_other_section(labels, key):
        logger.warning("[CONTENT] %s %s setting looked like the wrong coaching section. Using defaults.", source_label, key)
        return DEFAULT_SETTINGS[key]
    return _merge_required_coaching_defaults(key, value)


def _sanitize_discord_template_setting(value, source_label):
    if not isinstance(value, list):
        logger.warning("[CONTENT] %s discord_templates setting was not a list and was ignored. Using defaults.", source_label)
        return DEFAULT_SETTINGS["discord_templates"]
    rows = []
    for item in value:
        suggested_source = None
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            category = str(item[2] or "").strip() if len(item) >= 3 else ""
            title = str(item[0] or "").strip()
            message = str(item[1] or "")
        elif isinstance(item, dict):
            category = str(item.get("category") or item.get("Category") or "").strip()
            title = str(
                item.get("title")
                or item.get("Title")
                or item.get("trigger")
                or item.get("Trigger")
                or item.get("name")
                or item.get("Name")
                or item.get("label")
                or item.get("Label")
                or ""
            ).strip()
            message = str(
                item.get("message")
                or item.get("Message")
                or item.get("text")
                or item.get("Text")
                or item.get("content")
                or item.get("Content")
                or item.get("body")
                or item.get("Body")
                or ""
            )
            if "suggestedScreenshots" in item:
                suggested_source = item.get("suggestedScreenshots")
            elif "suggested_screenshots" in item:
                suggested_source = item.get("suggested_screenshots")
            elif "SuggestedScreenshots" in item:
                suggested_source = item.get("SuggestedScreenshots")
            else:
                numbered = [
                    item.get("suggestedScreenshot1") if "suggestedScreenshot1" in item else item.get("SuggestedScreenshot1"),
                    item.get("suggestedScreenshot2") if "suggestedScreenshot2" in item else item.get("SuggestedScreenshot2"),
                    item.get("suggestedScreenshot3") if "suggestedScreenshot3" in item else item.get("SuggestedScreenshot3"),
                ]
                if any(value is not None for value in numbered):
                    suggested_source = numbered
        else:
            continue
        category = category or DEFAULT_CONTENT_CATEGORY
        if title:
            row = {"category": category, "title": title, "message": message}
            if suggested_source is not None:
                if isinstance(suggested_source, str):
                    suggested_values = suggested_source.split("|")
                elif isinstance(suggested_source, (list, tuple)):
                    suggested_values = suggested_source
                else:
                    suggested_values = []
                row["suggested_screenshots"] = [str(path or "").strip() for path in suggested_values if str(path or "").strip()][:3]
            rows.append(row)
    return rows


def _sanitize_screenshot_setting(value, source_label):
    if not isinstance(value, list):
        logger.warning("[CONTENT] %s discord_screenshots setting was not a list and was ignored. Using defaults.", source_label)
        return DEFAULT_SETTINGS["discord_screenshots"]
    items = []
    for item in value:
        if not isinstance(item, dict):
            continue
        category = str(item.get("category") or item.get("Category") or "").strip()
        category = category or DEFAULT_CONTENT_CATEGORY
        title = str(item.get("title") or item.get("Title") or "").strip()
        image_url = str(item.get("image_url") or item.get("ImagePath") or item.get("imagePath") or item.get("url") or "").strip()
        if title:
            items.append({"category": category, "title": title, "image_url": image_url})
    return items


def _sanitize_content_setting(key, value, source_label):
    value = _sanitize_coaching_setting(key, value, source_label)
    value = _sanitize_fail_reason_setting(key, value, source_label)
    if key == "discord_templates":
        return _sanitize_discord_template_setting(value, source_label)
    if key == "discord_screenshots":
        return _sanitize_screenshot_setting(value, source_label)
    return value


def _normalize_sound_volume(value, enable_sounds=True):
    level = str(value or "").strip().lower()
    if enable_sounds is False:
        return "off"
    if level in {"off", "low", "medium", "high"}:
        return level
    return "medium"


def _normalize_welcome_voice(value):
    return "female" if str(value or "").strip().lower() == "female" else "male"


def _normalize_vpn_proxy_check_mode(value):
    mode = str(value or "").strip().lower()
    return mode if mode in {"checker", "links", "disabled"} else "checker"


def _normalize_headset_notification_mode(value):
    mode = str(value or "").strip().lower()
    return mode if mode in {"all", "action_required_only", "muted"} else "all"


def sanitize_settings(doc: Optional[dict]) -> dict:
    base = {key: value for key, value in DEFAULT_SETTINGS.items() if key not in ADMIN_ONLY_SETTINGS_KEYS}
    if doc:
        for key, value in doc.items():
            if key in ALLOWED_SETTINGS_KEYS or key in SENSITIVE_SETTINGS_KEYS:
                if key in DEFAULT_MANAGED_SETTINGS_KEYS and not doc.get(_managed_custom_flag(key)):
                    continue
                if (
                    key == "vpnProxyCheckMode"
                    and _normalize_vpn_proxy_check_mode(value) == "checker"
                    and not doc.get("vpnProxyCheckMode_admin_confirmed")
                ):
                    continue
                base[key] = _sanitize_content_setting(key, value, "saved")
    base["sound_volume"] = _normalize_sound_volume(base.get("sound_volume"), base.get("enable_sounds"))
    base["enable_sounds"] = base["sound_volume"] != "off"
    base["welcome_voice"] = _normalize_welcome_voice(base.get("welcome_voice"))
    base["vpnProxyCheckMode"] = _normalize_vpn_proxy_check_mode(base.get("vpnProxyCheckMode"))
    base["require_newbie_shift_approval"] = bool(doc.get("require_newbie_shift_approval", True)) if doc and "require_newbie_shift_approval" in doc else True
    base["headset_notification_mode"] = _normalize_headset_notification_mode(doc.get("headset_notification_mode") if doc else "all")
    base["call_fails"] = _merge_required_fail_reasons(base.get("call_fails"), "call_fails")
    for key in DEFAULT_MANAGED_SETTINGS_KEYS:
        base[_managed_custom_flag(key)] = bool(doc and doc.get(_managed_custom_flag(key)))
    for key in SENSITIVE_SETTINGS_KEYS:
        base[key] = ""
        if key == GEMINI_API_KEY_SETTING:
            base[f"{key}_configured"] = bool(_get_stored_gemini_api_key(doc))
        else:
            base[f"{key}_configured"] = bool(doc and doc.get(key))
    return base


def normalize_settings_payload(payload: dict) -> dict:
    sanitized = {}
    unset_defaults = {}

    legacy_key_map = {
        legacy_key: GEMINI_API_KEY_SETTING
        for legacy_key in LEGACY_GEMINI_API_KEY_SETTINGS
    }

    for key, value in payload.items():
        key = legacy_key_map.get(key, key)
        if key not in ALLOWED_SETTINGS_KEYS:
            continue

        if key in SENSITIVE_SETTINGS_KEYS:
            if isinstance(value, str) and (not value.strip() or _is_masked_sensitive_placeholder(value)):
                continue
            sanitized[key] = value
            continue

        value = _sanitize_content_setting(key, value, "incoming")
        if key == "sound_volume":
            value = _normalize_sound_volume(value)
            sanitized["enable_sounds"] = value != "off"
        elif key == "welcome_voice":
            value = _normalize_welcome_voice(value)
        elif key == "vpnProxyCheckMode":
            value = _normalize_vpn_proxy_check_mode(value)
            if value == "checker":
                sanitized["vpnProxyCheckMode_admin_confirmed"] = True
            else:
                sanitized["vpnProxyCheckMode_admin_confirmed"] = False
        elif key == "require_newbie_shift_approval":
            sanitized["require_newbie_shift_approval"] = bool(value)
        elif key == "headset_notification_mode":
            sanitized["headset_notification_mode"] = _normalize_headset_notification_mode(value)
        sanitized[key] = value
        if key in DEFAULT_MANAGED_SETTINGS_KEYS:
            sanitized[_managed_custom_flag(key)] = True

    return {"$set": sanitized, "$unset": unset_defaults}


def _content_values_equal(left, right):
    try:
        return json.dumps(left, sort_keys=True, ensure_ascii=False) == json.dumps(right, sort_keys=True, ensure_ascii=False)
    except TypeError:
        return left == right


def empty_session():
    return {
        "candidate_name": "",
        "tester_name": "",
        "pronoun": "",
        "final_attempt": False,
        "supervisor_only": False,
        "status": "In Progress",
        "auto_fail_reason": None,
        "tech_issue": "N/A",
        "tech_issue_ended_session": False,
        "tech_issue_summary_required": False,
        "headset_usb": None,
        "headset_brand": "",
        "headset_review_requested": False,
        "headset_review_id": "",
        "headset_review_sync_status": "",
        "headset_review_status": "",
        "headset_review_last_synced_at": "",
        "noise_cancel": None,
        "vpn_on": None,
        "vpn_off": None,
        "chrome_default": None,
        "extensions_disabled": None,
        "popups_allowed": None,
        "call_1": None,
        "call_2": None,
        "call_3": None,
        "sup_transfer_1": None,
        "sup_transfer_2": None,
        "time_for_sup": None,
        "newbie_shift_data": None,
        "form_fill_status": "not_attempted",
        "form_filled_at": "",
        "form_fill_error_summary": "",
        "newbie_shift_scheduled_at": "",
        "newbie_shift_number": "",
        "newbie_shift_timezone": "",
        "newbie_shift_calendar_created": False,
        "newbie_shift_request_id": "",
        "newbie_shift_request_type": "initial",
        "newbie_shift_request_status": "pending",
        "newbie_shift_requested_by": "",
        "newbie_shift_request_reason": "",
        "newbie_shift_request_details": "",
        "newbie_shift_request_created_at": "",
        "newbie_shift_original_scheduled_at": "",
        "newbie_shift_rescheduled_at": "",
        "newbie_shift_within_24_hours": False,
        "newbie_shift_counts_as_attempt": False,
        "newbie_shift_lead_time_seconds": None,
        "newbie_shift_lead_time_category": "",
        "newbie_shift_current_attempt": 1,
        "newbie_shift_resulting_attempt": 1,
        "newbie_shift_becomes_final_attempt": False,
        "newbie_shift_attempt_rule": "",
        "newbie_shift_terminal_outcome": "",
        "newbie_shift_request_confirmed_at": "",
        "newbie_shift_request_submission_fingerprint": "",
        "newbie_shift_admin_decision_at": "",
        "newbie_shift_admin_decision_by": "",
        "newbie_shift_denial_reason": "",
        "deletion_request_id": "",
        "deletion_request_status": "",
        "deletion_request_created_at": "",
        "final_status": None,
        "last_saved": None,
        "tech_issues_log": [],
        "current_call_num": None,
        "current_call_draft": None,
        "current_sup_transfer_num": None,
        "current_sup_transfer_draft": None,
    }


FORM_FILL_STATUSES = {"not_attempted", "filled", "skipped", "failed", "not_recorded"}
FORM_FILL_NOT_ATTEMPTED = "not_attempted"
FORM_FILL_FILLED = "filled"
FORM_FILL_SKIPPED = "skipped"
FORM_FILL_FAILED = "failed"
NEWBIE_REQUEST_INITIAL = "initial"
NEWBIE_REQUEST_RESCHEDULE = "reschedule"
NEWBIE_REQUEST_STATUSES = {"pending", "approved", "denied"}
NEWBIE_REQUEST_PENDING = "pending"
NEWBIE_REQUEST_POLICY_APPROVED_ACTOR = "Policy (Auto-Approved)"
NEWBIE_REQUESTED_BY_TESTER = "tester"
NEWBIE_REQUESTED_BY_CANDIDATE = "candidate"
NEWBIE_REQUESTED_BY_OTHER = "other"
NEWBIE_RESCHEDULE_MAX_ATTEMPTS = 2
CERTIFICATION_BASE_MAX_ATTEMPTS = 3
NEWBIE_RESCHEDULE_ATTEMPT_FIELDS = (
    "newbie_shift_requested_by",
    "newbie_shift_request_created_at",
    "newbie_shift_original_scheduled_at",
    "newbie_shift_lead_time_seconds",
    "newbie_shift_lead_time_category",
    "newbie_shift_within_24_hours",
    "newbie_shift_counts_as_attempt",
    "newbie_shift_current_attempt",
    "newbie_shift_resulting_attempt",
    "newbie_shift_becomes_final_attempt",
    "newbie_shift_attempt_rule",
    "newbie_shift_terminal_outcome",
    "final_attempt",
    "final_status",
    "auto_fail_reason",
)
DELETION_REQUEST_PENDING = "pending"


def _normalize_form_fill_status(value):
    status = str(value or "").strip().lower()
    return status if status in FORM_FILL_STATUSES else FORM_FILL_NOT_ATTEMPTED


def _normalize_newbie_request_status(value):
    status = str(value or "").strip().lower()
    return status if status in NEWBIE_REQUEST_STATUSES else NEWBIE_REQUEST_PENDING


def _normalize_newbie_requested_by(value):
    requested_by = str(value or "").strip().lower()
    aliases = {
        "candidate": NEWBIE_REQUESTED_BY_CANDIDATE,
        "tester": NEWBIE_REQUESTED_BY_TESTER,
        "trainer": NEWBIE_REQUESTED_BY_TESTER,
        "tester/trainer": NEWBIE_REQUESTED_BY_TESTER,
        "admin": NEWBIE_REQUESTED_BY_TESTER,
        "other": NEWBIE_REQUESTED_BY_OTHER,
    }
    return aliases.get(requested_by, "")


def _positive_attempt_number(value, default=1):
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return default
    return max(1, parsed)


def _aware_iso_datetime(value):
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo is not None else None


def calculate_newbie_reschedule_attempt(session, now_iso=None):
    """Calculate immutable attempt impact for one Newbie Shift reschedule request."""
    source = dict(session or {})
    requested_by = _normalize_newbie_requested_by(source.get("newbie_shift_requested_by"))
    created_at = str(source.get("newbie_shift_request_created_at") or now_iso or datetime.now(timezone.utc).isoformat()).strip()
    original_scheduled_at = str(source.get("newbie_shift_original_scheduled_at") or "").strip()
    created_dt = _aware_iso_datetime(created_at)
    original_dt = _aware_iso_datetime(original_scheduled_at)

    current_attempt = _positive_attempt_number(
        source.get("newbie_shift_current_attempt")
        or source.get("attempt_number")
        or source.get("attempt_count"),
        1,
    )
    if _shared_truthy(source.get("final_attempt")) and not str(source.get("newbie_shift_attempt_rule") or "").strip():
        current_attempt = max(current_attempt, NEWBIE_RESCHEDULE_MAX_ATTEMPTS)

    validation_error = ""
    if not requested_by:
        validation_error = "invalid_requester"
    elif not original_dt or not created_dt:
        validation_error = "invalid_schedule"

    lead_time_seconds = None
    within_24_hours = False
    lead_time_category = ""
    if original_dt and created_dt:
        lead_time_seconds = int((original_dt.astimezone(timezone.utc) - created_dt.astimezone(timezone.utc)).total_seconds())
        within_24_hours = lead_time_seconds < 24 * 60 * 60
        lead_time_category = "less_than_24_hours" if within_24_hours else "24_hours_or_more"

    counts_as_attempt = bool(
        not validation_error
        and requested_by == NEWBIE_REQUESTED_BY_CANDIDATE
        and within_24_hours
    )
    resulting_attempt = min(
        NEWBIE_RESCHEDULE_MAX_ATTEMPTS,
        current_attempt + (1 if counts_as_attempt else 0),
    )
    terminal_outcome = (
        "FAIL-Final Attempt"
        if counts_as_attempt and current_attempt >= NEWBIE_RESCHEDULE_MAX_ATTEMPTS
        else ""
    )
    final_attempt = bool(
        _shared_truthy(source.get("final_attempt"))
        or resulting_attempt >= NEWBIE_RESCHEDULE_MAX_ATTEMPTS
    )
    becomes_final_attempt = bool(
        counts_as_attempt
        and current_attempt < NEWBIE_RESCHEDULE_MAX_ATTEMPTS
        and resulting_attempt == NEWBIE_RESCHEDULE_MAX_ATTEMPTS
    )

    if validation_error:
        rule_code = validation_error
    elif requested_by == NEWBIE_REQUESTED_BY_CANDIDATE and within_24_hours:
        rule_code = "candidate_late_terminal" if terminal_outcome else "candidate_late_counts"
    elif requested_by == NEWBIE_REQUESTED_BY_CANDIDATE:
        rule_code = "candidate_timely_no_count"
    elif requested_by == NEWBIE_REQUESTED_BY_TESTER:
        rule_code = "tester_no_count"
    else:
        rule_code = "other_no_count_owner_confirmation"

    return {
        "requested_by": requested_by,
        "request_created_at": created_at,
        "original_scheduled_at": original_scheduled_at,
        "lead_time_seconds": lead_time_seconds,
        "lead_time_category": lead_time_category,
        "within_24_hours": within_24_hours,
        "counts_as_attempt": counts_as_attempt,
        "current_attempt": current_attempt,
        "resulting_attempt": resulting_attempt,
        "final_attempt": final_attempt,
        "becomes_final_attempt": becomes_final_attempt,
        "terminal_outcome": terminal_outcome,
        "rule_code": rule_code,
        "validation_error": validation_error,
    }


def _apply_newbie_reschedule_attempt(session, now_iso=None):
    normalized = dict(session or {})
    if str(normalized.get("newbie_shift_request_type") or "").strip().lower() != NEWBIE_REQUEST_RESCHEDULE:
        return normalized
    outcome = calculate_newbie_reschedule_attempt(normalized, now_iso=now_iso)
    normalized.update({
        "newbie_shift_requested_by": outcome["requested_by"],
        "newbie_shift_request_created_at": outcome["request_created_at"],
        "newbie_shift_original_scheduled_at": outcome["original_scheduled_at"],
        "newbie_shift_lead_time_seconds": outcome["lead_time_seconds"],
        "newbie_shift_lead_time_category": outcome["lead_time_category"],
        "newbie_shift_within_24_hours": outcome["within_24_hours"],
        "newbie_shift_counts_as_attempt": outcome["counts_as_attempt"],
        "newbie_shift_current_attempt": outcome["current_attempt"],
        "newbie_shift_resulting_attempt": outcome["resulting_attempt"],
        "newbie_shift_becomes_final_attempt": outcome["becomes_final_attempt"],
        "newbie_shift_attempt_rule": outcome["rule_code"],
        "newbie_shift_terminal_outcome": outcome["terminal_outcome"],
        "final_attempt": outcome["final_attempt"],
    })
    if outcome["terminal_outcome"]:
        normalized["final_status"] = outcome["terminal_outcome"]
        normalized["auto_fail_reason"] = "NC/NS"
    elif outcome["counts_as_attempt"]:
        normalized["final_status"] = "NC/NS"
        normalized["auto_fail_reason"] = "NC/NS"
    else:
        if "newbie_shift_prior_final_status" in normalized:
            normalized["final_status"] = normalized.get("newbie_shift_prior_final_status")
        if "newbie_shift_prior_auto_fail_reason" in normalized:
            normalized["auto_fail_reason"] = normalized.get("newbie_shift_prior_auto_fail_reason")
    return normalized


def _session_with_workflow_defaults(session):
    doc = dict(session or {})
    doc["form_fill_status"] = _normalize_form_fill_status(doc.get("form_fill_status"))
    doc.setdefault("form_filled_at", "")
    doc.setdefault("form_fill_error_summary", "")
    doc.setdefault("newbie_shift_scheduled_at", "")
    doc.setdefault("newbie_shift_number", "")
    doc.setdefault("newbie_shift_timezone", "")
    doc.setdefault("newbie_shift_calendar_created", False)
    doc.setdefault("newbie_shift_request_id", "")
    doc.setdefault("newbie_shift_request_type", NEWBIE_REQUEST_INITIAL)
    doc["newbie_shift_request_status"] = _normalize_newbie_request_status(doc.get("newbie_shift_request_status"))
    doc.setdefault("newbie_shift_requested_by", "")
    doc.setdefault("newbie_shift_request_reason", "")
    doc.setdefault("newbie_shift_request_details", "")
    doc.setdefault("newbie_shift_request_created_at", "")
    doc.setdefault("newbie_shift_original_scheduled_at", "")
    doc.setdefault("newbie_shift_rescheduled_at", "")
    doc.setdefault("newbie_shift_within_24_hours", False)
    doc.setdefault("newbie_shift_counts_as_attempt", False)
    doc.setdefault("newbie_shift_lead_time_seconds", None)
    doc.setdefault("newbie_shift_lead_time_category", "")
    doc.setdefault("newbie_shift_current_attempt", 1)
    doc.setdefault("newbie_shift_resulting_attempt", doc.get("newbie_shift_current_attempt") or 1)
    doc.setdefault("newbie_shift_becomes_final_attempt", False)
    doc.setdefault("newbie_shift_attempt_rule", "")
    doc.setdefault("newbie_shift_terminal_outcome", "")
    doc.setdefault("newbie_shift_request_confirmed_at", "")
    doc.setdefault("newbie_shift_request_submission_fingerprint", "")
    doc.setdefault("newbie_shift_admin_decision_at", "")
    doc.setdefault("newbie_shift_admin_decision_by", "")
    doc.setdefault("newbie_shift_denial_reason", "")
    doc.setdefault("deletion_request_id", "")
    doc.setdefault("deletion_request_status", "")
    doc.setdefault("deletion_request_created_at", "")
    doc.setdefault("candidate_correction_request_id", "")
    doc.setdefault("candidate_correction_status", "")
    doc.setdefault("candidate_correction_pending", False)
    doc.setdefault("candidate_correction_changes", [])
    doc.setdefault("candidate_correction_reason", "")
    doc.setdefault("candidate_correction_denial_reason", "")
    doc.setdefault("headset_review_requested", False)
    doc.setdefault("headset_review_id", "")
    doc.setdefault("headset_review_sync_status", "")
    doc.setdefault("headset_review_status", "")
    doc.setdefault("headset_review_last_synced_at", "")
    return doc


SHARED_CANDIDATE_SESSIONS_TAB = "Candidate Sessions"
SHARED_PENDING_SUP_TRANSFERS_TAB = "Pending Sup Transfers"
SHARED_NEWBIE_SHIFT_REQUESTS_TAB = "newbie-shift-requests"
SHARED_CANDIDATE_DELETION_REQUESTS_TAB = "candidate-deletion-requests"
SHARED_CANDIDATE_CORRECTION_REQUESTS_TAB = "candidate-information-correction-requests"
SAM_AUTHORIZED_USERS_TAB = "sam-authorized-users"
SAM_NOTIFICATIONS_TAB = "sam-notifications"
HEADSET_REVIEW_LOG_TAB = "headset-review-log"
HEADSETS_TAB = "headsets"
MTS_TUTORIAL_VIDEOS_TAB = "mts-tutorial-videos"
SAM_TUTORIAL_VIDEOS_TAB = "sam-tutorial-videos"

SAM_AUTHORIZED_USER_HEADERS = [
    "name",
    "pin",
    "role",
    "enabled",
    "installed",
    "install_date",
    "device_name",
    "notes",
]

HEADSET_REVIEW_LOG_HEADERS = [
    "review_id",
    "source_session_id",
    "candidate_name",
    "tester_name",
    "Brand",
    "Model",
    "Status",
    "Note",
    "created_at",
    "updated_at",
    "decision_at",
    "decision_by",
    "denial_reason",
]

BASIC_HEADSET_REVIEW_LOG_HEADERS = ["Brand", "Model", "Status", "Note"]
LEGACY_HEADSET_REVIEW_LOG_HEADERS = [
    "headset_model", "candidate_name", "tester_name", "entered_at", "review_status", "notes",
]
HEADSETS_HEADERS = ["Brand", "Model", "Status", "Note"]

SHARED_CANDIDATE_SESSION_HEADERS = [
    "session_id",
    "candidate_name",
    "candidate_first_name",
    "candidate_last_initial",
    "tester_name",
    "session_type",
    "attempt_number",
    "final_attempt",
    "status",
    "created_at",
    "completed_at",
    "mock_calls_completed",
    "sup_transfers_completed",
    "call_1_result",
    "call_2_result",
    "call_3_result",
    "sup_transfer_1_result",
    "sup_transfer_2_result",
    "coaching_summary",
    "fail_summary",
    "review_notes",
    "needs_sup_transfer",
    "pending_sup_transfer_id",
    "withdrawn",
    "withdrawn_at",
    "extra_attempt_granted",
    "extra_attempt_reason",
    "retention_until",
    "archived",
    "headset_usb",
    "noise_cancel",
    "headset_brand",
    "vpn_on",
    "vpn_off",
    "chrome_default",
    "extensions_disabled",
    "popups_allowed",
    "skills",
    "final_notes_strengths",
    "final_notes_needs_coaching",
    "final_notes_other",
    "final_notes_history_only",
    "evaluator_notes_summary",
    "final_notes_created_at",
    "calculated_result",
    "final_result",
    "readiness_override_applied",
    "readiness_override_result",
    "readiness_override_reason",
    "readiness_override_explanation",
    "form_fill_status",
    "form_filled_at",
    "newbie_shift_scheduled_at",
    "newbie_shift_timezone",
    "newbie_shift_request_id",
    "newbie_shift_request_type",
    "newbie_shift_request_status",
    "newbie_shift_requested_by",
    "newbie_shift_request_reason",
    "newbie_shift_request_details",
    "newbie_shift_request_created_at",
    "newbie_shift_original_scheduled_at",
    "newbie_shift_rescheduled_at",
    "newbie_shift_within_24_hours",
    "newbie_shift_counts_as_attempt",
    "newbie_shift_admin_decision_at",
    "newbie_shift_admin_decision_by",
    "newbie_shift_denial_reason",
    "deletion_request_id",
    "deletion_request_status",
    "deletion_request_created_at",
    "extra_attempts_granted",
    "allowed_attempt_count",
    "current_attempt_number",
    "extra_attempt_last_action_id",
    "extra_attempt_granted_by",
    "extra_attempt_granted_at",
    "readiness_override_by",
    "readiness_override_at",
    "newbie_shift_number",
]

SHARED_PENDING_SUP_TRANSFER_HEADERS = [
    "pending_id",
    "candidate_name",
    "candidate_first_name",
    "candidate_last_initial",
    "original_tester_name",
    "original_session_id",
    "created_at",
    "status",
    "final_attempt",
    "mock_call_summary",
    "call_1_result",
    "call_2_result",
    "call_3_result",
    "needed_reason",
    "completed_by",
    "completed_at",
    "completed_status",
    "notes",
    "headset_usb",
    "noise_cancel",
    "headset_brand",
    "vpn_on",
    "vpn_off",
    "chrome_default",
    "extensions_disabled",
    "popups_allowed",
    "skills",
    "final_notes_strengths",
    "final_notes_needs_coaching",
    "final_notes_other",
    "evaluator_notes_summary",
    "calculated_result",
    "final_result",
    "readiness_override_applied",
    "readiness_override_result",
    "readiness_override_reason",
    "readiness_override_explanation",
    "form_fill_status",
    "form_filled_at",
    "newbie_shift_scheduled_at",
    "newbie_shift_timezone",
    "newbie_shift_request_id",
    "newbie_shift_request_type",
    "newbie_shift_request_status",
    "newbie_shift_requested_by",
    "newbie_shift_request_reason",
    "newbie_shift_request_details",
    "newbie_shift_request_created_at",
    "newbie_shift_original_scheduled_at",
    "newbie_shift_rescheduled_at",
    "newbie_shift_within_24_hours",
    "newbie_shift_counts_as_attempt",
    "newbie_shift_number",
]

SHARED_NEWBIE_SHIFT_REQUEST_HEADERS = [
    "request_id",
    "session_id",
    "candidate_name",
    "candidate_first_name",
    "candidate_last_initial",
    "tester_name",
    "request_type",
    "request_status",
    "requested_by",
    "request_reason",
    "request_details",
    "request_created_at",
    "original_scheduled_at",
    "rescheduled_at",
    "scheduled_at",
    "timezone",
    "within_24_hours",
    "counts_as_attempt",
    "final_attempt",
    "admin_decision_at",
    "admin_decision_by",
    "denial_reason",
    "updated_at",
    "lead_time_seconds",
    "lead_time_category",
    "current_attempt",
    "resulting_attempt",
    "becomes_final_attempt",
    "attempt_rule",
    "terminal_outcome",
    "newbie_shift_number",
]

SHARED_CANDIDATE_DELETION_REQUEST_HEADERS = [
    "request_id",
    "session_id",
    "candidate_name",
    "candidate_first_name",
    "candidate_last_initial",
    "tester_name",
    "created_at",
    "status",
    "local_history_deleted",
    "reason",
    "session_status",
    "completed_at",
    "audit_summary",
    "admin_decision_at",
    "admin_decision_by",
    "denial_reason",
    "updated_at",
]

SHARED_CANDIDATE_CORRECTION_REQUEST_HEADERS = [
    "request_id",
    "request_type",
    "source_session_id",
    "candidate_id",
    "candidate_name",
    "tester_name",
    "reason",
    "changes_json",
    "created_at",
    "status",
    "admin_decision_at",
    "admin_decision_by",
    "denial_reason",
    "updated_at",
]

UPDATE_MTS_TAB = "update-MTS"
UPDATE_SAM_TAB = "update-SAM"
UPDATE_TAB_HEADERS = [
    "Version",
    "RequiredVersion",
    "Release Date",
    "Release Title",
    "URL",
    "Notes",
]

GEMINI_PROMPT_TABS = {
    "gemini_coaching_prompt": ("gemini-coaching-prompt", "gemini-coaching-prompt.md"),
    "gemini_fail_prompt": ("gemini-fail-prompt", "gemini-fail-prompt.md"),
}


def _shared_tracking_required_setup():
    return {
        SHARED_CANDIDATE_SESSIONS_TAB: SHARED_CANDIDATE_SESSION_HEADERS,
        SHARED_PENDING_SUP_TRANSFERS_TAB: SHARED_PENDING_SUP_TRANSFER_HEADERS,
        SHARED_NEWBIE_SHIFT_REQUESTS_TAB: SHARED_NEWBIE_SHIFT_REQUEST_HEADERS,
        SHARED_CANDIDATE_DELETION_REQUESTS_TAB: SHARED_CANDIDATE_DELETION_REQUEST_HEADERS,
        SHARED_CANDIDATE_CORRECTION_REQUESTS_TAB: SHARED_CANDIDATE_CORRECTION_REQUEST_HEADERS,
        HEADSET_REVIEW_LOG_TAB: HEADSET_REVIEW_LOG_HEADERS,
        HEADSETS_TAB: HEADSETS_HEADERS,
    }


def _sam_admin_required_setup():
    return {
        SAM_AUTHORIZED_USERS_TAB: SAM_AUTHORIZED_USER_HEADERS,
        SAM_NOTIFICATIONS_TAB: NOTIFICATION_SHEET_COLUMNS,
    }


def _shared_tracking_manual_setup(sheet_id="", service_account_email=""):
    return {
        "spreadsheetId": sheet_id or _shared_tracking_sheet_id(),
        "serviceAccountEmail": service_account_email or _get_service_account_email(),
        "message": (
            "Create the required tabs below in the master Google Sheet or grant Editor access "
            "to the listed service account so the app can create them automatically."
        ),
        "tabs": _shared_tracking_required_setup(),
    }


def _update_sheet_required_setup():
    return {
        UPDATE_MTS_TAB: UPDATE_TAB_HEADERS,
        UPDATE_SAM_TAB: UPDATE_TAB_HEADERS,
    }


def _gemini_prompt_required_setup():
    return {
        tab_name: ["prompt"]
        for tab_name, _filename in GEMINI_PROMPT_TABS.values()
    }


def _tutorial_video_required_setup():
    return {
        MTS_TUTORIAL_VIDEOS_TAB: TUTORIAL_VIDEO_HEADERS,
        SAM_TUTORIAL_VIDEOS_TAB: TUTORIAL_VIDEO_HEADERS,
    }


def _shared_tracking_sheet_id():
    runtime_config = _load_backend_runtime_config()
    return _resolve_content_sheet_id(runtime_config or {})


def _read_local_default_file(filename):
    defaults_dir = _resolve_defaults_dir()
    if not defaults_dir:
        return ""
    path = defaults_dir / filename
    if not path.is_file():
        return ""
    return path.read_text(encoding="utf-8-sig").strip()


def _tab_status_base(title, feature, created=False):
    return {
        "tab": title,
        "feature": feature,
        "exists": True,
        "created": bool(created),
        "headerStatus": "",
        "ok": True,
    }


def _tab_error_status(title, feature, exc, exists=False):
    reason = _shared_permission_hint(exc)
    logger.error("[SHEETS] Failed to verify master sheet tab '%s'. reason=%s error=%s", title, reason, exc)
    return {
        "tab": title,
        "feature": feature,
        "exists": bool(exists),
        "created": False,
        "ok": False,
        "headerStatus": "permission_error" if reason == "missing_permission" else "error",
        "reason": reason,
        "error": str(exc),
    }


def _ensure_sheet_tab(sheets_api, sheet_id, title, tabs):
    if title in tabs:
        logger.info("[SHEETS] Master sheet tab exists: %s", title)
        return False, tabs[title]

    logger.info("[SHEETS] Creating missing master sheet tab: %s", title)
    sheets_api.batchUpdate(
        spreadsheetId=sheet_id,
        body={"requests": [{"addSheet": {"properties": {"title": title}}}]},
    ).execute()
    metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
    refreshed = {
        ((sheet.get("properties") or {}).get("title") or ""): sheet
        for sheet in metadata.get("sheets", [])
    }
    logger.info("[SHEETS] Created master sheet tab: %s", title)
    return True, refreshed.get(title)


def _read_header_row(sheets_api, sheet_id, title, header_count):
    quoted = _quote_sheet_title_for_a1(title)
    last_col = _column_letter(header_count)
    return sheets_api.values().get(
        spreadsheetId=sheet_id,
        range=f"{quoted}!A1:{last_col}1",
    ).execute().get("values", [[]])[0]


def _verify_header_tab(sheets_api, sheet_id, title, expected_headers, feature, tabs):
    created, _sheet = _ensure_sheet_tab(sheets_api, sheet_id, title, tabs)
    status = _tab_status_base(title, feature, created)
    quoted = _quote_sheet_title_for_a1(title)
    last_col = _column_letter(len(expected_headers))
    current = _read_header_row(sheets_api, sheet_id, title, len(expected_headers))
    normalized_current = [str(value or "").strip() for value in current]
    expected = [str(value or "").strip() for value in expected_headers]

    if normalized_current[: len(expected)] == expected:
        status["headerStatus"] = "verified"
        logger.info("[SHEETS] Headers verified for master sheet tab '%s'.", title)
        return status

    if not any(normalized_current):
        sheets_api.values().update(
            spreadsheetId=sheet_id,
            range=f"{quoted}!A1:{last_col}1",
            valueInputOption="USER_ENTERED",
            body={"values": [expected_headers]},
        ).execute()
        status["headerStatus"] = "written"
        logger.info("[SHEETS] Wrote headers for master sheet tab '%s'.", title)
        return status

    if normalized_current and normalized_current == expected[: len(normalized_current)]:
        sheets_api.values().update(
            spreadsheetId=sheet_id,
            range=f"{quoted}!A1:{last_col}1",
            valueInputOption="USER_ENTERED",
            body={"values": [expected_headers]},
        ).execute()
        status["headerStatus"] = "extended"
        logger.info("[SHEETS] Extended headers for master sheet tab '%s'.", title)
        return status

    status.update({
        "ok": False,
        "headerStatus": "mismatch",
        "expectedHeaders": expected_headers,
        "actualHeaders": current,
        "error": f"Header mismatch on tab '{title}'. Existing row was not overwritten.",
    })
    logger.error("[SHEETS] Header mismatch on master sheet tab '%s'. expected=%s actual=%s", title, expected_headers, current)
    return status


def _verify_sam_authorized_users_tab(sheets_api, sheet_id, tabs):
    if SAM_AUTHORIZED_USERS_TAB not in tabs:
        logger.info("[SAM-SETUP] Required tab missing and will be created: %s", SAM_AUTHORIZED_USERS_TAB)
    status = _verify_header_tab(
        sheets_api,
        sheet_id,
        SAM_AUTHORIZED_USERS_TAB,
        SAM_AUTHORIZED_USER_HEADERS,
        "sam_authorized_users",
        tabs,
    )
    if not status.get("ok"):
        logger.warning(
            "[SAM-SETUP] Header verification failed for %s expected=%s actual=%s",
            SAM_AUTHORIZED_USERS_TAB,
            SAM_AUTHORIZED_USER_HEADERS,
            status.get("actualHeaders") or [],
        )
        return status
    logger.info("[SAM-SETUP] Header verification ok for %s status=%s", SAM_AUTHORIZED_USERS_TAB, status.get("headerStatus") or "")

    quoted = _quote_sheet_title_for_a1(SAM_AUTHORIZED_USERS_TAB)
    last_col = _column_letter(len(SAM_AUTHORIZED_USER_HEADERS))
    rows = sheets_api.values().get(
        spreadsheetId=sheet_id,
        range=f"{quoted}!A2:{last_col}",
    ).execute().get("values", [])
    has_user_rows = any(any(str(cell or "").strip() for cell in row) for row in rows)
    status["defaultOwnerCreated"] = False
    if has_user_rows:
        logger.info("[SHEETS] SAM authorized users already configured; no default user row was written.")
        return status

    pin = f"{secrets.randbelow(900000) + 100000:06d}"
    default_row = [
        "Shawn Bly",
        pin,
        "owner",
        "TRUE",
        "FALSE",
        "",
        "",
        "Default owner/admin generated during SAM setup initialization",
    ]
    sheets_api.values().append(
        spreadsheetId=sheet_id,
        range=f"{quoted}!A2",
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body={"values": [default_row]},
    ).execute()
    status["defaultOwnerCreated"] = True
    logger.info("[SHEETS] Created default SAM owner/admin row in %s. PIN was generated but not logged.", SAM_AUTHORIZED_USERS_TAB)
    return status


def _verify_sam_notifications_tab(sheets_api, sheet_id, tabs):
    return _verify_header_tab(
        sheets_api,
        sheet_id,
        SAM_NOTIFICATIONS_TAB,
        NOTIFICATION_SHEET_COLUMNS,
        "sam_notifications",
        tabs,
    )


def _verify_gemini_prompt_tab(sheets_api, sheet_id, title, default_filename, tabs):
    created, _sheet = _ensure_sheet_tab(sheets_api, sheet_id, title, tabs)
    status = _tab_status_base(title, "gemini_prompt", created)
    quoted = _quote_sheet_title_for_a1(title)
    values = sheets_api.values().get(
        spreadsheetId=sheet_id,
        range=f"{quoted}!A1:A2",
    ).execute().get("values", [])
    header = str((values[0][0] if len(values) > 0 and values[0] else "") or "").strip()
    prompt = str((values[1][0] if len(values) > 1 and values[1] else "") or "").strip()
    local_default = _read_local_default_file(default_filename)
    status["localDefaultPresent"] = bool(local_default)

    if header == "prompt":
        status["headerStatus"] = "verified"
        logger.info("[SHEETS] Gemini prompt header verified for tab '%s'.", title)
    elif not header:
        sheets_api.values().update(
            spreadsheetId=sheet_id,
            range=f"{quoted}!A1",
            valueInputOption="USER_ENTERED",
            body={"values": [["prompt"]]},
        ).execute()
        status["headerStatus"] = "written"
        logger.info("[SHEETS] Wrote Gemini prompt header for tab '%s'.", title)
    else:
        status.update({
            "ok": False,
            "headerStatus": "mismatch",
            "expectedHeaders": ["prompt"],
            "actualHeaders": [header],
            "error": f"Gemini prompt tab '{title}' A1 is not 'prompt'. Existing value was not overwritten.",
        })
        logger.error("[SHEETS] Gemini prompt tab '%s' has unexpected A1 value: %s", title, header)

    if not prompt and local_default:
        sheets_api.values().update(
            spreadsheetId=sheet_id,
            range=f"{quoted}!A2",
            valueInputOption="USER_ENTERED",
            body={"values": [[local_default]]},
        ).execute()
        status["promptStatus"] = "default_populated"
        status["matchesLocalDefault"] = True
        logger.info("[SHEETS] Populated blank Gemini prompt tab '%s' from %s.", title, default_filename)
    elif prompt:
        matches = _normalize_gemini_prompt_for_compare(prompt) == _normalize_gemini_prompt_for_compare(local_default)
        status["promptStatus"] = "matches_local_default" if matches else "override"
        status["matchesLocalDefault"] = matches
        status["hasPromptText"] = True
        logger.info("[SHEETS] Gemini prompt tab '%s' status: %s.", title, status["promptStatus"])
    else:
        status["promptStatus"] = "blank_no_local_default"
        status["matchesLocalDefault"] = False
        status["hasPromptText"] = False
        status["ok"] = False
        status["error"] = f"Gemini prompt tab '{title}' is blank and local default file was not found."
        logger.error("[SHEETS] Gemini prompt tab '%s' is blank and no local default was available.", title)

    return status


def _verify_master_shared_sheets():
    notification_config = _get_admin_notification_sheet_config()
    service_result = _get_shared_tracking_sheet_service()
    sheet_id = service_result.get("sheet_id") or _shared_tracking_sheet_id()
    service_account_email = service_result.get("serviceAccountEmail") or _get_service_account_email()
    result = {
        "ok": False,
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "spreadsheetId": sheet_id,
        "serviceAccountEmail": service_account_email,
        "masterSheet": {
            "spreadsheetId": sheet_id,
            "purpose": "Candidate Sessions, Pending Sup Transfers, Gemini prompt overrides, update-MTS, update-SAM, SAM authorized users, and SAM notifications.",
        },
        "notificationSheet": {
            "spreadsheetId": notification_config.get("sheet_id"),
            "gid": notification_config.get("gid"),
            "configured": bool(notification_config.get("configured")),
            "purpose": "Legacy migration/fallback source only. SAM reads/writes master sam-notifications when available.",
        },
        "tabs": [],
        "setup": {
            **_shared_tracking_required_setup(),
            **_gemini_prompt_required_setup(),
            **_tutorial_video_required_setup(),
            **_update_sheet_required_setup(),
            **_sam_admin_required_setup(),
        },
    }

    logger.info(
        "[SHEETS] Verifying master shared sheet=%s with service_account_configured=%s. Legacy notification sheet fallback=%s gid=%s.",
        _mask_config_value(sheet_id),
        bool(service_account_email),
        _mask_config_value(notification_config.get("sheet_id")),
        notification_config.get("gid") or "0",
    )

    if not service_result.get("ok"):
        result.update({"error": service_result.get("error"), "setup": service_result.get("setup") or result["setup"]})
        logger.error("[SHEETS] Master shared sheet verification failed before access: %s", service_result.get("error"))
        return result

    if service_result.get("appsScriptClient"):
        try:
            service_result["appsScriptClient"].ping()
            for title in _shared_tracking_required_setup().keys():
                result["tabs"].append({"tab": title, "ok": True})
            for title, _ in GEMINI_PROMPT_TABS.values():
                result["tabs"].append({"tab": title, "ok": True})
            for title in _tutorial_video_required_setup().keys():
                result["tabs"].append({"tab": title, "ok": True, "manualVerificationRequired": True})
            result["ok"] = True
            return result
        except Exception as exc:
            logger.error("[SHEETS] Apps Script ping failed during verification: %s", exc)
            result.update({"error": f"Apps Script ping failed: {exc}"})
            return result

    try:
        sheets_api = service_result["service"].spreadsheets()
        metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
        tabs = {
            ((sheet.get("properties") or {}).get("title") or ""): sheet
            for sheet in metadata.get("sheets", [])
        }

        for title, headers in _shared_tracking_required_setup().items():
            try:
                if title == HEADSET_REVIEW_LOG_TAB:
                    status = _ensure_headset_review_log_tab(sheets_api, sheet_id)
                elif title == HEADSETS_TAB:
                    status = _ensure_headsets_tab(sheets_api, sheet_id)
                else:
                    status = _verify_header_tab(sheets_api, sheet_id, title, headers, "shared_candidate_tracking", tabs)
            except Exception as exc:
                status = _tab_error_status(title, "shared_candidate_tracking", exc, exists=title in tabs)
            result["tabs"].append(status)
            if status.get("created"):
                metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
                tabs = {((sheet.get("properties") or {}).get("title") or ""): sheet for sheet in metadata.get("sheets", [])}

        for _key, (title, filename) in GEMINI_PROMPT_TABS.items():
            try:
                status = _verify_gemini_prompt_tab(sheets_api, sheet_id, title, filename, tabs)
            except Exception as exc:
                status = _tab_error_status(title, "gemini_prompt", exc, exists=title in tabs)
            result["tabs"].append(status)
            if status.get("created"):
                metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
                tabs = {((sheet.get("properties") or {}).get("title") or ""): sheet for sheet in metadata.get("sheets", [])}

        for title, headers in _tutorial_video_required_setup().items():
            try:
                status = _verify_header_tab(sheets_api, sheet_id, title, headers, "tutorial_videos", tabs)
            except Exception as exc:
                status = _tab_error_status(title, "tutorial_videos", exc, exists=title in tabs)
            result["tabs"].append(status)
            if status.get("created"):
                metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
                tabs = {((sheet.get("properties") or {}).get("title") or ""): sheet for sheet in metadata.get("sheets", [])}

        for title, headers in _update_sheet_required_setup().items():
            try:
                status = _verify_header_tab(sheets_api, sheet_id, title, headers, "update_metadata", tabs)
            except Exception as exc:
                status = _tab_error_status(title, "update_metadata", exc, exists=title in tabs)
            result["tabs"].append(status)
            if status.get("created"):
                metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
                tabs = {((sheet.get("properties") or {}).get("title") or ""): sheet for sheet in metadata.get("sheets", [])}

        for verifier in (_verify_sam_authorized_users_tab, _verify_sam_notifications_tab):
            try:
                status = verifier(sheets_api, sheet_id, tabs)
            except Exception as exc:
                title = SAM_AUTHORIZED_USERS_TAB if verifier == _verify_sam_authorized_users_tab else SAM_NOTIFICATIONS_TAB
                status = _tab_error_status(title, "sam_admin", exc, exists=title in tabs)
            result["tabs"].append(status)
            if status.get("created"):
                metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
                tabs = {((sheet.get("properties") or {}).get("title") or ""): sheet for sheet in metadata.get("sheets", [])}

        result["ok"] = all(tab.get("ok") for tab in result["tabs"])
        result["tabSummary"] = {
            "required": len(result["tabs"]),
            "ok": sum(1 for tab in result["tabs"] if tab.get("ok")),
            "created": sum(1 for tab in result["tabs"] if tab.get("created")),
            "headersWritten": sum(1 for tab in result["tabs"] if tab.get("headerStatus") == "written"),
            "headersVerified": sum(1 for tab in result["tabs"] if tab.get("headerStatus") == "verified"),
            "promptDefaultsPopulated": sum(1 for tab in result["tabs"] if tab.get("promptStatus") == "default_populated"),
            "promptOverrides": sum(1 for tab in result["tabs"] if tab.get("promptStatus") == "override"),
        }
        logger.info(
            "[SHEETS] Master shared sheet verification complete. ok=%s tab_count=%d created=%d headers_written=%d prompt_defaults_populated=%d prompt_overrides=%d",
            result["ok"],
            result["tabSummary"]["required"],
            result["tabSummary"]["created"],
            result["tabSummary"]["headersWritten"],
            result["tabSummary"]["promptDefaultsPopulated"],
            result["tabSummary"]["promptOverrides"],
        )
        return result
    except Exception as exc:
        reason = _shared_permission_hint(exc)
        logger.exception("[SHEETS] Master shared sheet verification failed. reason=%s error=%s", reason, exc)
        result.update({
            "ok": False,
            "error": f"Master shared sheet verification failed. Reason: {reason}. Google Sheets error: {exc}",
            "reason": reason,
        })
        return result


def _get_service_account_email():
    creds_path = _resolve_notification_service_account_file()
    return _read_service_account_client_email(creds_path)


def _get_shared_tracking_sheet_service():
    sheet_id = _shared_tracking_sheet_id()
    if not sheet_id:
        return {
            "ok": False,
            "error": "No admin content Google Sheet is configured for shared candidate tracking.",
            "setup": _shared_tracking_manual_setup(),
        }

    # 1. Primary path: Use direct Google Sheets API via service account credentials
    creds_path = _resolve_notification_service_account_file()
    service_account_email = _get_service_account_email()
    _record_google_sheet_auth_status("shared_service_resolved", ok=bool(creds_path), path=creds_path, error="" if creds_path else "No service account credentials found.")
    logger.info(
        "[SHARED] Master MTS content/candidate sheet config spreadsheet_id=%s service_account_configured=%s credentials_path=%s",
        _mask_config_value(sheet_id),
        bool(service_account_email),
        creds_path or "",
    )

    if creds_path:
        try:
            from google.oauth2 import service_account
            from googleapiclient.discovery import build
            scopes = ["https://www.googleapis.com/auth/spreadsheets"]
            creds = service_account.Credentials.from_service_account_file(str(creds_path), scopes=scopes)
            service = build("sheets", "v4", credentials=creds, cache_discovery=False)
            _record_google_sheet_auth_status("shared_service_ok", ok=True, path=creds_path)
            logger.info("[SHARED] Using direct Google Sheets API via service account credentials.")
            return {"ok": True, "service": service, "sheet_id": sheet_id, "serviceAccountEmail": service_account_email}
        except Exception as exc:
            _record_google_sheet_auth_status("shared_service_failed", ok=False, path=creds_path, error=exc)
            logger.warning("[SHARED] Direct service account initialization failed: %s. Trying Apps Script fallback.", exc)

    # 2. Fallback path: Check if Apps Script client is configured and enabled
    try:
        from services.apps_script_api import create_apps_script_sheet_service
        apps_script_res = create_apps_script_sheet_service(ROOT_DIR)
        if apps_script_res.get("ok"):
            logger.info("[SHARED] Using Apps Script API client fallback for shared tracking operations.")
            client = apps_script_res["client"]
            return {
                "ok": True,
                "appsScriptClient": client,
                "sheet_id": sheet_id,
                "serviceAccountEmail": "apps-script-api-endpoint",
            }
    except Exception as exc:
        logger.warning("[SHARED] Failed to initialize Apps Script client fallback: %s", exc)

    # 3. Both failed/unavailable
    return {
        "ok": False,
        "error": "Google service account credentials are not configured or failed, and Apps Script fallback is unavailable.",
        "sheet_id": sheet_id,
        "serviceAccountEmail": service_account_email,
        "setup": _shared_tracking_manual_setup(sheet_id, service_account_email),
    }


def _shared_permission_hint(exc):
    text = str(exc or "")
    if "403" in text or "PERMISSION_DENIED" in text or "permission" in text.lower():
        return "missing_permission"
    if "404" in text or "not found" in text.lower():
        return "wrong_spreadsheet_or_missing_access"
    return "google_sheets_error"


def _ensure_shared_tracking_tabs(service, sheet_id, service_account_email=""):
    statuses = []
    try:
        sheets_api = service.spreadsheets()
        metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
        tabs = {
            ((sheet.get("properties") or {}).get("title") or ""): sheet
            for sheet in metadata.get("sheets", [])
        }

        requests = []
        for title in _shared_tracking_required_setup().keys():
            if title not in tabs:
                statuses.append({"tab": title, "exists": False, "action": "create_pending"})
                requests.append({"addSheet": {"properties": {"title": title}}})
            else:
                logger.info("[SHARED] Required tracking tab already exists: %s", title)
                statuses.append({"tab": title, "exists": True, "action": "already_exists"})

        if requests:
            try:
                logger.info("[SHARED] Creating missing shared tracking tabs in spreadsheet %s: %s", _mask_config_value(sheet_id), [r["addSheet"]["properties"]["title"] for r in requests])
                sheets_api.batchUpdate(spreadsheetId=sheet_id, body={"requests": requests}).execute()
                for status in statuses:
                    if status.get("action") == "create_pending":
                        status["action"] = "created"
                        logger.info("[SHARED] Created tracking tab: %s", status["tab"])
            except Exception as exc:
                reason = _shared_permission_hint(exc)
                missing_tabs = [
                    status["tab"]
                    for status in statuses
                    if status.get("action") == "create_pending"
                ]
                logger.error(
                    "[SHARED] Failed to create shared tracking tabs. reason=%s service_account_configured=%s spreadsheet=%s missing_tabs=%s error=%s",
                    reason,
                    bool(service_account_email),
                    _mask_config_value(sheet_id),
                    missing_tabs,
                    exc,
                )
                return {
                    "ok": False,
                    "error": (
                        "Missing shared tracking tabs could not be created. "
                        f"Reason: {reason}. The configured service account requires Editor access."
                    ),
                    "reason": reason,
                    "sheetId": sheet_id,
                    "serviceAccountEmail": service_account_email,
                    "statuses": statuses,
                    "setup": _shared_tracking_manual_setup(sheet_id, service_account_email),
                }
            metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
            tabs = {
                ((sheet.get("properties") or {}).get("title") or ""): sheet
                for sheet in metadata.get("sheets", [])
            }

        for title, headers in _shared_tracking_required_setup().items():
            if title == HEADSET_REVIEW_LOG_TAB:
                status = _ensure_headset_review_log_tab(sheets_api, sheet_id)
                if not status.get("ok"):
                    return {"ok": False, "error": status.get("error"), "sheetId": sheet_id, "serviceAccountEmail": service_account_email, "statuses": statuses, "setup": _shared_tracking_manual_setup(sheet_id, service_account_email)}
                statuses.append({"tab": title, "headers": status.get("headerStatus") or "verified", "schema": status.get("schema") or "review"})
                continue
            if title == HEADSETS_TAB:
                status = _ensure_headsets_tab(sheets_api, sheet_id)
                if not status.get("ok"):
                    return {"ok": False, "error": status.get("error"), "sheetId": sheet_id, "serviceAccountEmail": service_account_email, "statuses": statuses, "setup": _shared_tracking_manual_setup(sheet_id, service_account_email)}
                statuses.append({"tab": title, "headers": status.get("headerStatus") or "verified"})
                continue
            if title not in tabs:
                logger.error("[SHARED] Required shared tracking tab is still missing after setup attempt: %s", title)
                return {
                    "ok": False,
                    "error": f"Required shared tracking tab is missing and could not be created: {title}",
                    "sheetId": sheet_id,
                    "serviceAccountEmail": service_account_email,
                    "statuses": statuses,
                    "setup": _shared_tracking_manual_setup(sheet_id, service_account_email),
                }
            quoted = _quote_sheet_title_for_a1(title)
            last_col = _column_letter(len(headers))
            current = sheets_api.values().get(
                spreadsheetId=sheet_id,
                range=f"{quoted}!A1:{last_col}1",
            ).execute().get("values", [[]])[0]
            if current[: len(headers)] != headers:
                has_append_only_header = current and current == headers[: len(current)]
                if has_append_only_header:
                    logger.info("[SHARED] Appending new shared tracking headers for tab: %s", title)
                    sheets_api.values().update(
                        spreadsheetId=sheet_id,
                        range=f"{quoted}!A1:{last_col}1",
                        valueInputOption="USER_ENTERED",
                        body={"values": [headers]},
                    ).execute()
                    statuses.append({"tab": title, "headers": "extended"})
                    continue
                has_conflicting_header = any(_normalize_notification_text(value) for value in current)
                if has_conflicting_header:
                    logger.error("[SHARED] Shared tracking tab '%s' has unexpected non-empty headers: %s", title, current)
                    return {
                        "ok": False,
                        "error": f"Shared tracking tab '{title}' has unexpected headers.",
                        "sheetId": sheet_id,
                        "serviceAccountEmail": service_account_email,
                        "statuses": statuses,
                        "setup": _shared_tracking_manual_setup(sheet_id, service_account_email),
                    }
                logger.info("[SHARED] Writing headers for shared tracking tab: %s", title)
                sheets_api.values().update(
                    spreadsheetId=sheet_id,
                    range=f"{quoted}!A1:{last_col}1",
                    valueInputOption="USER_ENTERED",
                    body={"values": [headers]},
                ).execute()
                statuses.append({"tab": title, "headers": "written"})
            else:
                logger.info("[SHARED] Headers verified for shared tracking tab: %s", title)
                statuses.append({"tab": title, "headers": "verified"})
        return {
            "ok": True,
            "sheetId": sheet_id,
            "serviceAccountEmail": service_account_email,
            "statuses": statuses,
            "setup": _shared_tracking_manual_setup(sheet_id, service_account_email),
        }
    except Exception as exc:
        reason = _shared_permission_hint(exc)
        logger.error(
            "[SHARED] Unable to verify shared tracking tabs. reason=%s service_account_configured=%s spreadsheet=%s error=%s",
            reason,
            bool(service_account_email),
            _mask_config_value(sheet_id),
            exc,
        )
        return {
            "ok": False,
            "error": f"Unable to create or verify shared tracking tabs. Reason: {reason}. Google Sheets error: {exc}",
            "reason": reason,
            "sheetId": sheet_id,
            "serviceAccountEmail": service_account_email,
            "statuses": statuses,
            "setup": _shared_tracking_manual_setup(sheet_id, service_account_email),
        }


def _shared_sheet_context():
    service_result = _get_shared_tracking_sheet_service()
    if not service_result.get("ok"):
        return service_result
    if service_result.get("appsScriptClient"):
        return {
            **service_result,
            "setupStatus": {
                "ok": True,
                "statuses": [{"tab": HEADSET_REVIEW_LOG_TAB, "schema": "review", "ok": True}],
            },
        }
    ensure_result = _ensure_shared_tracking_tabs(
        service_result["service"],
        service_result["sheet_id"],
        service_result.get("serviceAccountEmail") or "",
    )
    if not ensure_result.get("ok"):
        return ensure_result
    return {**service_result, "setupStatus": ensure_result}


def _verify_shared_session_sheets():
    service_result = _get_shared_tracking_sheet_service()
    if not service_result.get("ok"):
        logger.error("[SHARED] Shared session sheet verification failed before Sheets access: %s", service_result.get("error"))
        return {
            **service_result,
            "checkedAt": datetime.now(timezone.utc).isoformat(),
        }
    ensure_result = _ensure_shared_tracking_tabs(
        service_result["service"],
        service_result["sheet_id"],
        service_result.get("serviceAccountEmail") or "",
    )
    return {
        **ensure_result,
        "checkedAt": datetime.now(timezone.utc).isoformat(),
    }


def _split_candidate_name(candidate_name):
    parts = [part for part in str(candidate_name or "").strip().split() if part]
    first = parts[0] if parts else ""
    last_initial = (parts[-1][0].upper() if len(parts) > 1 and parts[-1] else "")
    return first, last_initial


def _shared_bool(value):
    return "TRUE" if bool(value) else "FALSE"


def _shared_optional_bool(value):
    if value is None or value == "":
        return ""
    return _shared_bool(_shared_truthy(value))


def _shared_truthy(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"true", "yes", "1", "y", "on", "checked"}


def _shared_falsey(value):
    if isinstance(value, bool):
        return not value
    if value is None:
        return True
    return str(value).strip().lower() in {"", "false", "no", "0", "n", "off", "unchecked"}


def _masked_pin_for_log(value):
    text = str(value or "")
    if not text:
        return "<blank>"
    return f"len={len(text)} ending={text[-2:].rjust(2, '*')}"


def _shared_status(status):
    status = str(status or "").strip()
    mapping = {
        "Pass": "PASS",
        "Fail": "FAIL",
        "Incomplete": "INCOMPLETE",
        "NC/NS": "FAIL",
        "Needs Retest / Additional Coaching": "INCOMPLETE",
    }
    return mapping.get(status, status or "INCOMPLETE")


FINAL_READINESS_NEEDS_RETEST = "Needs Retest / Additional Coaching"
FINAL_READINESS_ALLOWED_RESULTS = {"Pass", "RESUMED-PASS", "Fail", "FAIL-Final Attempt", "Incomplete", "NC/NS", FINAL_READINESS_NEEDS_RETEST}


def _readiness_judgment(session):
    judgment = (session or {}).get("finalReadinessJudgment") or {}
    return judgment if isinstance(judgment, dict) else {}


def _readiness_override_applied(session):
    judgment = _readiness_judgment(session)
    return bool(judgment.get("overrideApplied")) and str(judgment.get("overrideResult") or "").strip() in FINAL_READINESS_ALLOWED_RESULTS


def _normalize_readiness_override_reason(value):
    reason = str(value or "").strip()
    prefix = "Evaluator Override Applied:"
    if reason.lower().startswith(prefix.lower()):
        reason = reason[len(prefix):].strip()
    return reason


def _readiness_override_note(session):
    if not _readiness_override_applied(session):
        return ""
    judgment = _readiness_judgment(session)
    calculated = str(judgment.get("calculatedResult") or compute_calculated_status(session) or "").strip()
    final_result = str(judgment.get("overrideResult") or "").strip()
    reason = _normalize_readiness_override_reason(judgment.get("primaryReason"))
    explanation = str(judgment.get("explanation") or "").strip()
    parts = [
        f"Evaluator Override Applied: calculated result was {calculated or 'N/A'} and final result is {final_result}.",
    ]
    if reason:
        parts.append(f"Primary reason: {reason}.")
    if explanation:
        parts.append(f"Explanation: {explanation}")
    return " ".join(parts).strip()


def _append_readiness_override_note(text, session):
    note = _readiness_override_note(session)
    if not note:
        return text
    base = str(text or "").strip()
    base_norm = " ".join(base.lower().replace("\n", " ").split())
    note_norm = " ".join(note.lower().replace("\n", " ").split())
    if note_norm and (note_norm in base_norm or base_norm.endswith(note_norm)):
        return base
    return f"{base}\n\n{note}" if base else note


def _readiness_context_text(session):
    judgment = _readiness_judgment(session)
    calculated = str(judgment.get("calculatedResult") or compute_calculated_status(session) or "").strip()
    final_result = compute_final_status(session)
    reason = _normalize_readiness_override_reason(judgment.get("primaryReason"))
    explanation = str(judgment.get("explanation") or "").strip()
    parts = [
        f"Final Readiness Judgment: calculated result is {calculated or 'N/A'}; final result is {final_result or 'N/A'}.",
        f"Override applied: {'Yes' if _readiness_override_applied(session) else 'No'}.",
    ]
    if reason:
        parts.append(f"Override reason: {reason}.")
    if explanation:
        parts.append(f"Override explanation: {explanation}")
    return " ".join(parts).strip()


def _count_completed(session, prefix, total):
    return sum(1 for i in range(1, total + 1) if (session.get(f"{prefix}_{i}") or {}).get("result"))


def _candidate_needs_sup_transfer(session, status):
    if session.get("supervisor_only"):
        return False
    if status not in {"Incomplete", "INCOMPLETE"}:
        return False
    calls_passed = _count_results(session, "call", 3, "Pass")
    sups_passed = _count_results(session, "sup_transfer", 2, "Pass")
    sups_failed = _count_results(session, "sup_transfer", 2, "Fail")
    return calls_passed >= 2 and sups_passed == 0 and sups_failed < 2


def _add_business_days(start_dt, business_days):
    current = start_dt
    added = 0
    while added < business_days:
        current = current + timedelta(days=1)
        if current.weekday() < 5:
            added += 1
    return current


def _shared_retention_until(status, session):
    if status in {"FAIL-Final Attempt", "WITHDREW FROM CERTIFICATION"} or session.get("withdrawn"):
        return _add_business_days(datetime.now(timezone.utc), 10).date().isoformat()
    return ""


def _session_attempt_number(existing_rows, candidate_name):
    normalized_name = " ".join(str(candidate_name or "").lower().split())
    attempts = [
        row for row in existing_rows
        if " ".join(str(row.get("candidate_name") or "").lower().split()) == normalized_name
    ]
    return len(attempts) + 1


def _shared_read_rows(sheets_api, sheet_id, tab_name, headers):
    quoted = _quote_sheet_title_for_a1(tab_name)
    last_col = _column_letter(len(headers))
    values = sheets_api.values().get(
        spreadsheetId=sheet_id,
        range=f"{quoted}!A2:{last_col}",
    ).execute().get("values", [])
    rows = []
    for index, row in enumerate(values, start=2):
        rows.append({
            "_row_number": index,
            **{
                headers[col_index]: (row[col_index] if col_index < len(row) else "")
                for col_index in range(len(headers))
            },
        })
    return rows


def _shared_update_or_append_row(sheets_api, sheet_id, tab_name, headers, key_name, key_value, row_values):
    existing = _shared_read_rows(sheets_api, sheet_id, tab_name, headers)
    quoted = _quote_sheet_title_for_a1(tab_name)
    last_col = _column_letter(len(headers))
    target = next((row for row in existing if str(row.get(key_name) or "").strip() == str(key_value or "").strip()), None)
    if target:
        logger.info(
            "[SHARED] Operation=update spreadsheet_id=%s tab=%s row=%s key=%s",
            _mask_config_value(sheet_id),
            tab_name,
            target["_row_number"],
            key_name,
        )
        sheets_api.values().update(
            spreadsheetId=sheet_id,
            range=f"{quoted}!A{target['_row_number']}:{last_col}{target['_row_number']}",
            valueInputOption="USER_ENTERED",
            body={"values": [row_values]},
        ).execute()
        return "updated"
    logger.info(
        "[SHARED] Operation=append spreadsheet_id=%s tab=%s key=%s",
        _mask_config_value(sheet_id),
        tab_name,
        key_name,
    )
    sheets_api.values().append(
        spreadsheetId=sheet_id,
        range=f"{quoted}!A2",
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body={"values": [row_values]},
    ).execute()
    return "appended"


def _shared_update_existing_row(sheets_api, sheet_id, tab_name, headers, row_number, row_values):
    quoted = _quote_sheet_title_for_a1(tab_name)
    last_col = _column_letter(len(headers))
    logger.info(
        "[SHARED] Operation=update spreadsheet_id=%s tab=%s row=%s",
        _mask_config_value(sheet_id),
        tab_name,
        row_number,
    )
    sheets_api.values().update(
        spreadsheetId=sheet_id,
        range=f"{quoted}!A{row_number}:{last_col}{row_number}",
        valueInputOption="USER_ENTERED",
        body={"values": [row_values]},
    ).execute()


def _shared_delete_existing_row(sheets_api, sheet_id, tab_name, row_number):
    if not row_number or int(row_number) <= 1:
        raise ValueError("A data row number is required for deletion.")
    metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
    sheet = next((
        item for item in metadata.get("sheets", [])
        if ((item.get("properties") or {}).get("title") or "") == tab_name
    ), None)
    sheet_gid = (sheet.get("properties") or {}).get("sheetId") if sheet else None
    if sheet_gid is None:
        raise ValueError(f"Sheet not found: {tab_name}")
    logger.info(
        "[SHARED] Operation=delete_row spreadsheet_id=%s tab=%s row=%s",
        _mask_config_value(sheet_id),
        tab_name,
        row_number,
    )
    sheets_api.batchUpdate(
        spreadsheetId=sheet_id,
        body={
            "requests": [{
                "deleteDimension": {
                    "range": {
                        "sheetId": sheet_gid,
                        "dimension": "ROWS",
                        "startIndex": int(row_number) - 1,
                        "endIndex": int(row_number),
                    },
                },
            }],
        },
    ).execute()


def _normalize_headset_review_key(value):
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _headset_identity_key(brand="", model=""):
    """Exact, display-safe headset comparison key; deliberately not fuzzy."""
    return (_normalize_headset_review_key(brand), _normalize_headset_review_key(model))


def _approved_headset_review_keys():
    keys = set()
    for group in EXTERNAL_CONTENT.get("approved_headsets") or []:
        brand = str((group or {}).get("brand") or "").strip()
        for model in (group or {}).get("models") or []:
            model_text = str(model or "").strip()
            label = f"{brand} {model_text}".strip()
            if label:
                keys.add(_normalize_headset_review_key(label))
    return keys


def _approved_headset_identity_keys():
    return {
        _headset_identity_key((group or {}).get("brand"), model)
        for group in EXTERNAL_CONTENT.get("approved_headsets") or []
        for model in (group or {}).get("models") or []
        if str((group or {}).get("brand") or "").strip() and str(model or "").strip()
    }


def _denied_headset_review_keys():
    return {
        _normalize_headset_review_key(f"{item.get('brand', '')} {item.get('model', '')}")
        for item in EXTERNAL_CONTENT.get("denied_headsets") or []
        if str(item.get("brand") or "").strip() and str(item.get("model") or "").strip()
    }


def _denied_headset_identity_keys():
    return {
        _headset_identity_key(item.get("brand"), item.get("model"))
        for item in EXTERNAL_CONTENT.get("denied_headsets") or []
        if str(item.get("brand") or "").strip() and str(item.get("model") or "").strip()
    }


def _ensure_headset_review_log_tab(sheets_api, sheet_id):
    metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
    tabs = {
        ((sheet.get("properties") or {}).get("title") or ""): sheet
        for sheet in metadata.get("sheets", [])
    }
    _ensure_sheet_tab(sheets_api, sheet_id, HEADSET_REVIEW_LOG_TAB, tabs)
    current = _read_header_row(sheets_api, sheet_id, HEADSET_REVIEW_LOG_TAB, len(HEADSET_REVIEW_LOG_HEADERS))
    normalized = [str(value or "").strip() for value in current]
    if normalized[:len(HEADSET_REVIEW_LOG_HEADERS)] == HEADSET_REVIEW_LOG_HEADERS:
        return {"ok": True, "schema": "review", "headerStatus": "verified"}
    if normalized[:len(BASIC_HEADSET_REVIEW_LOG_HEADERS)] == BASIC_HEADSET_REVIEW_LOG_HEADERS:
        return {"ok": True, "schema": "basic", "headerStatus": "basic-compatible"}
    if normalized[:len(LEGACY_HEADSET_REVIEW_LOG_HEADERS)] == LEGACY_HEADSET_REVIEW_LOG_HEADERS:
        return {"ok": True, "schema": "legacy", "headerStatus": "legacy-compatible"}
    if not any(normalized):
        quoted = _quote_sheet_title_for_a1(HEADSET_REVIEW_LOG_TAB)
        sheets_api.values().update(
            spreadsheetId=sheet_id,
            range=f"{quoted}!A1:{_column_letter(len(HEADSET_REVIEW_LOG_HEADERS))}1",
            valueInputOption="USER_ENTERED",
            body={"values": [HEADSET_REVIEW_LOG_HEADERS]},
        ).execute()
        return {"ok": True, "schema": "review", "headerStatus": "written"}
    return {"ok": False, "schema": "unknown", "error": "Headset review log headers do not match the supported review schema."}


def _ensure_headsets_tab(sheets_api, sheet_id):
    metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
    tabs = {
        ((sheet.get("properties") or {}).get("title") or ""): sheet
        for sheet in metadata.get("sheets", [])
    }
    _created, sheet = _ensure_sheet_tab(sheets_api, sheet_id, HEADSETS_TAB, tabs)
    current = _read_header_row(sheets_api, sheet_id, HEADSETS_TAB, len(HEADSETS_HEADERS))
    normalized = [str(value or "").strip() for value in current]
    if normalized[:len(HEADSETS_HEADERS)] == HEADSETS_HEADERS:
        return {"ok": True, "headerStatus": "verified"}
    quoted = _quote_sheet_title_for_a1(HEADSETS_TAB)
    if not any(normalized):
        sheets_api.values().update(
            spreadsheetId=sheet_id,
            range=f"{quoted}!A1:D1",
            valueInputOption="USER_ENTERED",
            body={"values": [HEADSETS_HEADERS]},
        ).execute()
        return {"ok": True, "headerStatus": "written"}
    if normalized[:3] == ["Brand", "Model", "Note"]:
        sheet_gid = ((sheet or {}).get("properties") or {}).get("sheetId")
        if sheet_gid is None:
            return {"ok": False, "error": "Unable to identify the headsets tab for schema migration."}
        sheets_api.batchUpdate(
            spreadsheetId=sheet_id,
            body={"requests": [{"insertDimension": {"range": {
                "sheetId": sheet_gid,
                "dimension": "COLUMNS",
                "startIndex": 2,
                "endIndex": 3,
            }, "inheritFromBefore": True}}]},
        ).execute()
        sheets_api.values().update(
            spreadsheetId=sheet_id,
            range=f"{quoted}!A1:D1",
            valueInputOption="USER_ENTERED",
            body={"values": [HEADSETS_HEADERS]},
        ).execute()
        rows = sheets_api.values().get(
            spreadsheetId=sheet_id,
            range=f"{quoted}!A2:B",
        ).execute().get("values", [])
        statuses = [["approved"] for row in rows if any(str(cell or "").strip() for cell in row)]
        if statuses:
            sheets_api.values().update(
                spreadsheetId=sheet_id,
                range=f"{quoted}!C2:C{len(statuses) + 1}",
                valueInputOption="USER_ENTERED",
                body={"values": statuses},
            ).execute()
        return {"ok": True, "headerStatus": "migrated-status-column"}
    return {"ok": False, "error": "Headsets headers do not match Brand, Model, Status, Note."}


def _split_headset_brand_model(value, brand="", model=""):
    brand = re.sub(r"\s+", " ", str(brand or "").strip())
    model = re.sub(r"\s+", " ", str(model or "").strip())
    combined = re.sub(r"\s+", " ", str(value or "").strip())
    if brand and model:
        return brand, model
    known_brands = sorted(
        [str((group or {}).get("brand") or "").strip() for group in EXTERNAL_CONTENT.get("approved_headsets") or []],
        key=len,
        reverse=True,
    )
    lowered = combined.lower()
    for known_brand in known_brands:
        if lowered == known_brand.lower() or lowered.startswith(f"{known_brand.lower()} "):
            return known_brand, combined[len(known_brand):].strip() or combined
    parts = combined.split(" ", 1)
    return (parts[0] if parts else ""), (parts[1] if len(parts) > 1 else combined)


def _headset_display_label(brand="", model="", combined=""):
    brand = re.sub(r"\s+", " ", str(brand or "").strip())
    model = re.sub(r"\s+", " ", str(model or "").strip())
    combined = re.sub(r"\s+", " ", str(combined or "").strip())
    if not brand and not model:
        return combined
    if not brand:
        return model
    if not model:
        return brand
    if model.casefold() == brand.casefold() or model.casefold().startswith(f"{brand.casefold()} "):
        return model
    return f"{brand} {model}"


def _candidate_headset_values(record):
    record = record or {}
    explicit_model = next((
        re.sub(r"\s+", " ", str(record.get(key) or "").strip())
        for key in ("headset_model", "HeadsetModel", "Model", "model")
        if str(record.get(key) or "").strip()
    ), "")
    brand = next((
        re.sub(r"\s+", " ", str(record.get(key) or "").strip())
        for key in ("headset_brand", "HeadsetBrand", "Brand", "brand")
        if str(record.get(key) or "").strip()
    ), "")
    if explicit_model:
        return {
            "brand": brand,
            "model": explicit_model,
            "label": _headset_display_label(brand, explicit_model),
            "separate": True,
        }
    return {"brand": "", "model": "", "label": brand, "separate": False}


def _apply_headset_correction_values(record, changes):
    current = _candidate_headset_values(record)
    combined = current["label"]
    brand = current["brand"]
    model = current["model"]
    separate = current["separate"]
    headset_changes = [item for item in changes or [] if item.get("field") in {"headset_brand", "headset_model"}]
    if not headset_changes:
        return current
    if not separate:
        brand_change = next((item for item in headset_changes if item.get("field") == "headset_brand"), None)
        model_change = next((item for item in headset_changes if item.get("field") == "headset_model"), None)
        brand_previous = str((brand_change or {}).get("previous_value") or "").strip()
        model_previous = str((model_change or {}).get("previous_value") or "").strip()
        brand_requested = str((brand_change or {}).get("requested_value") or "").strip()
        model_requested = str((model_change or {}).get("requested_value") or "").strip()
        if brand_change and not model_change and (combined == brand_requested or combined.startswith(f"{brand_requested} ")):
            return {"brand": "", "model": "", "label": combined, "separate": False}
        if model_change and not brand_change and (combined == model_requested or combined.endswith(f" {model_requested}")):
            return {"brand": "", "model": "", "label": combined, "separate": False}
        if model_change and not brand_change and model_previous == combined:
            return {"brand": "", "model": "", "label": model_change["requested_value"], "separate": False}
        if brand_previous and (combined.casefold() == brand_previous.casefold() or combined.casefold().startswith(f"{brand_previous.casefold()} ")):
            brand = combined[:len(brand_previous)]
            model = combined[len(brand_previous):].strip()
            separate = True
        elif model_previous and (combined.casefold() == model_previous.casefold() or combined.casefold().endswith(f" {model_previous.casefold()}")):
            model = combined[-len(model_previous):]
            brand = combined[:-len(model_previous)].strip()
            separate = True
    for change in headset_changes:
        field = change["field"]
        previous = str(change.get("previous_value") or "").strip()
        requested = str(change.get("requested_value") or "").strip()
        current_value = brand if field == "headset_brand" else model
        if separate and previous and current_value != previous:
            raise ValueError("correction_identity_mismatch")
        if field == "headset_brand":
            brand = requested
        else:
            model = requested
    return {
        "brand": brand,
        "model": model,
        "label": _headset_display_label(brand, model, combined),
        "separate": separate,
    }


def _headset_review_schema_from_context(context):
    statuses = ((context or {}).get("setupStatus") or {}).get("statuses") or []
    match = next((status for status in statuses if status.get("tab") == HEADSET_REVIEW_LOG_TAB and "schema" in status), {})
    return match.get("schema") or "review"


def _headset_review_headers(schema):
    if schema == "legacy":
        return LEGACY_HEADSET_REVIEW_LOG_HEADERS
    if schema == "basic":
        return BASIC_HEADSET_REVIEW_LOG_HEADERS
    return HEADSET_REVIEW_LOG_HEADERS


def _append_headset_review_log(payload):
    headset_model = str((payload or {}).get("headset_model") or "").strip()
    brand, model = _split_headset_brand_model(
        headset_model,
        (payload or {}).get("brand"),
        (payload or {}).get("model"),
    )
    headset_model = f"{brand} {model}".strip()
    normalized_model = _normalize_headset_review_key(headset_model)
    normalized_identity = _headset_identity_key(brand, model)
    if not normalized_model:
        return {"ok": True, "skipped": True, "reason": "blank_headset"}
    if normalized_identity in _approved_headset_identity_keys():
        return {"ok": True, "skipped": True, "reason": "approved_headset"}
    if normalized_identity in _denied_headset_identity_keys():
        return {"ok": True, "skipped": True, "reason": "resolved_headset", "status": "denied"}

    source_session_id = str((payload or {}).get("source_session_id") or (payload or {}).get("session_id") or "").strip()
    candidate_name = str((payload or {}).get("candidate_name") or "").strip()
    tester_name = str((payload or {}).get("tester_name") or "").strip()
    if not source_session_id or not candidate_name or not tester_name or not brand or not model:
        return {"ok": False, "reason": "invalid_request", "error": "Headset review request data is incomplete."}
    review_id = str((payload or {}).get("review_id") or "").strip() or str(uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"mts-headset-review:{source_session_id}",
    ))
    note = str((payload or {}).get("note") or (payload or {}).get("trainer_note") or "").strip()
    now_iso = datetime.now(timezone.utc).isoformat()

    try:
        context = _shared_sheet_context()
        if not context.get("ok"):
            logger.warning("[HEADSET-REVIEW] Unable to log headset review row through the configured transport.")
            return {"ok": False, "reason": "sheet_unavailable", "error": "Headset review request could not be submitted."}

        apps_script_client = context.get("appsScriptClient")
        if apps_script_client:
            result = apps_script_client.post("submitHeadsetReview", {
                "review_id": review_id,
                "source_session_id": source_session_id,
                "brand": brand,
                "model": model,
                "headset_model": headset_model,
                "candidate_name": candidate_name,
                "tester_name": tester_name,
                "note": note,
            })
            return {"ok": True, "logged": True, "review_id": review_id, "source_session_id": source_session_id, "status": "pending", **(result if isinstance(result, dict) else {})}
        sheets_api = context["service"].spreadsheets()
        sheet_id = context["sheet_id"]
        candidate_rows = _shared_read_rows(
            sheets_api,
            sheet_id,
            SHARED_CANDIDATE_SESSIONS_TAB,
            SHARED_CANDIDATE_SESSION_HEADERS,
        )
        parent_matches = [
            row for row in candidate_rows
            if str(row.get("session_id") or "").strip() == source_session_id
        ]
        if len(parent_matches) != 1:
            return {
                "ok": False,
                "reason": "parent_session_unavailable",
                "error": "Headset review parent session could not be verified.",
            }
        schema = _headset_review_schema_from_context(context)
        headers = _headset_review_headers(schema)
        rows = _shared_read_rows(sheets_api, sheet_id, HEADSET_REVIEW_LOG_TAB, headers)
        for row in rows:
            existing_label = row.get("headset_model") if schema == "legacy" else f"{row.get('Brand', '')} {row.get('Model', '')}".strip()
            existing_model = _normalize_headset_review_key(existing_label)
            existing_status = str(row.get("review_status") if schema == "legacy" else row.get("Status") or "").strip().lower()
            identity_matches = (
                schema == "review"
                and (
                    str(row.get("review_id") or "").strip() == review_id
                    or str(row.get("source_session_id") or "").strip() == source_session_id
                )
            ) or (schema != "review" and existing_model == normalized_model)
            if not identity_matches:
                continue
            if existing_status not in {"", "pending"}:
                return {"ok": True, "skipped": True, "reason": "already_resolved", "review_id": review_id, "status": existing_status}
            return {
                "ok": True,
                "skipped": True,
                "reason": "duplicate_pending",
                "review_id": str(row.get("review_id") or review_id).strip(),
                "source_session_id": str(row.get("source_session_id") or source_session_id).strip(),
                "status": "pending",
                "brand": str(row.get("Brand") or brand).strip(),
                "model": str(row.get("Model") or model).strip(),
            }

        quoted = _quote_sheet_title_for_a1(HEADSET_REVIEW_LOG_TAB)
        row_values = ([
            headset_model,
            candidate_name,
            tester_name,
            now_iso,
            "pending",
            note,
        ] if schema == "legacy" else ([brand, model, "pending", note] if schema == "basic" else [
            review_id, source_session_id, candidate_name, tester_name, brand, model,
            "pending", note, now_iso, now_iso, "", "", "",
        ]))
        sheets_api.values().append(
            spreadsheetId=sheet_id,
            range=f"{quoted}!A2",
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": [row_values]},
        ).execute()
        logger.info("[HEADSET-REVIEW] Logged one unknown headset review request.")
        return {"ok": True, "logged": True, "review_id": review_id, "source_session_id": source_session_id, "status": "pending"}
    except Exception as exc:
        logger.warning("[HEADSET-REVIEW] Failed to log unknown headset review request; continuing workflow.")
        return {"ok": False, "reason": "write_failed", "error": "Headset review request could not be submitted."}


def _normalize_headset_review_row(row, schema):
    if schema == "legacy":
        brand, model = _split_headset_brand_model(row.get("headset_model"))
        status = str(row.get("review_status") or "pending").strip().lower() or "pending"
        note = str(row.get("notes") or "").strip()
        candidate = str(row.get("candidate_name") or "").strip()
        tester = str(row.get("tester_name") or "").strip()
        submitted_date = str(row.get("entered_at") or "").strip()
        review_id = f"legacy-{row.get('_row_number') or ''}"
        source_session_id = ""
    else:
        brand = str(row.get("Brand") or "").strip()
        model = str(row.get("Model") or "").strip()
        status = str(row.get("Status") or "pending").strip().lower() or "pending"
        note = str(row.get("Note") or "").strip()
        candidate = str(row.get("candidate_name") or "").strip() if schema == "review" else ""
        tester = str(row.get("tester_name") or "").strip() if schema == "review" else ""
        submitted_date = str(row.get("created_at") or "").strip() if schema == "review" else ""
        review_id = str(row.get("review_id") or "").strip() if schema == "review" else f"basic-{row.get('_row_number') or ''}"
        source_session_id = str(row.get("source_session_id") or "").strip() if schema == "review" else ""
    return {
        "review_id": review_id,
        "source_session_id": source_session_id,
        "brand": brand,
        "model": model,
        "status": status,
        "note": note,
        "candidate": candidate,
        "tester": tester,
        "submitted_date": submitted_date,
        "updated_at": str(row.get("updated_at") or "").strip() if schema == "review" else "",
        "_row_number": row.get("_row_number"),
        "_schema": schema,
        "_raw": row,
    }


def _read_headsets_rows(sheets_api, sheet_id):
    return [
        _with_headset_catalog_identity({
            "brand": str(row.get("Brand") or "").strip(),
            "model": str(row.get("Model") or "").strip(),
            "status": _normalize_headset_catalog_status(row.get("Status"), legacy_blank_approved=True),
            "note": str(row.get("Note") or "").strip(),
            "_row_number": row.get("_row_number"),
        })
        for row in _shared_read_rows(sheets_api, sheet_id, HEADSETS_TAB, HEADSETS_HEADERS)
        if str(row.get("Brand") or "").strip() and str(row.get("Model") or "").strip()
    ]


def _headset_catalog_identity(row_number, brand, model, status, note):
    """Return an exact, stale-safe identity for one physical catalog row."""
    canonical = json.dumps({
        "row": int(row_number or 0),
        "brand": str(brand or "").strip(),
        "model": str(model or "").strip(),
        "status": str(status or "approved").strip().lower() or "approved",
        "note": str(note or "").strip(),
    }, sort_keys=True, separators=(",", ":"))
    return f"headset-catalog-{hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:24]}"


def _with_headset_catalog_identity(row):
    next_row = dict(row or {})
    row_number = int(next_row.get("_row_number") or 0)
    next_row["catalog_row_number"] = row_number
    next_row["catalog_identity"] = _headset_catalog_identity(
        row_number,
        next_row.get("brand"),
        next_row.get("model"),
        next_row.get("status"),
        next_row.get("note"),
    )
    return next_row


class _HeadsetCatalogMutationError(ValueError):
    pass


def _apps_script_headset_catalog_rows(apps_script_client):
    response = apps_script_client.get("getSheetRange", {"range": "'headsets'!A:D"})
    values = response.get("values") if isinstance(response, dict) else None
    values = values if isinstance(values, list) else []
    if not values:
        return []
    headers = [str(value or "").strip() for value in values[0]]
    if headers[:len(HEADSETS_HEADERS)] != HEADSETS_HEADERS:
        raise ValueError("Approved headset catalog headers do not match the supported schema.")
    rows = []
    for offset, values_row in enumerate(values[1:]):
        padded = list(values_row or []) + [""] * len(HEADSETS_HEADERS)
        brand = str(padded[0] or "").strip()
        model = str(padded[1] or "").strip()
        if not brand or not model:
            continue
        rows.append(_with_headset_catalog_identity({
            "brand": brand,
            "model": model,
            "status": _normalize_headset_catalog_status(padded[2], legacy_blank_approved=True),
            "note": str(padded[3] or "").strip(),
            "_row_number": offset + 2,
        }))
    return rows


def _headset_catalog_target(rows, payload):
    identity = str((payload or {}).get("catalog_identity") or "").strip()
    try:
        row_number = int((payload or {}).get("catalog_row_number") or 0)
    except (TypeError, ValueError):
        row_number = 0
    if not identity or row_number < 2:
        raise _HeadsetCatalogMutationError("Refresh Headset Review before changing this approved headset.")
    target = next((row for row in rows if int(row.get("catalog_row_number") or 0) == row_number), None)
    if not target or not hmac.compare_digest(str(target.get("catalog_identity") or ""), identity):
        raise _HeadsetCatalogMutationError("This approved headset changed after it was loaded. Refresh Headset Review and try again.")
    return target


def _apply_headset_catalog_action(context, payload, action, decision_note=""):
    apps_script_client = (context or {}).get("appsScriptClient")
    sheet_id = (context or {}).get("sheet_id")
    sheets_api = None
    if apps_script_client:
        rows = _apps_script_headset_catalog_rows(apps_script_client)
    else:
        sheets_api = context["service"].spreadsheets()
        rows = _read_headsets_rows(sheets_api, sheet_id)
    target = _headset_catalog_target(rows, payload)
    previous_status = str(target.get("status") or "approved").strip().lower() or "approved"
    new_status = {
        "approve": "approved",
        "deny": "denied",
        "archive": "archived",
    }.get(action, "")
    row_number = int(target["catalog_row_number"])
    changed_rows = 0
    deleted = action == "delete"

    if apps_script_client:
        if deleted:
            metadata = apps_script_client.get("getSheetMetadata")
            sheets = metadata.get("sheets") if isinstance(metadata, dict) else []
            sheet = next((item for item in (sheets or []) if ((item.get("properties") or {}).get("title") == HEADSETS_TAB)), None)
            sheet_numeric_id = (sheet or {}).get("properties", {}).get("sheetId")
            if sheet_numeric_id is None:
                raise _HeadsetCatalogMutationError("Approved headset catalog identity could not be resolved. Refresh Headset Review and try again.")
            result = apps_script_client.post("batchUpdateSpreadsheet", {
                "requests": [{
                    "deleteDimension": {
                        "range": {
                            "sheetId": sheet_numeric_id,
                            "dimension": "ROWS",
                            "startIndex": row_number - 1,
                            "endIndex": row_number,
                        },
                    },
                }],
            })
            replies = result.get("replies") if isinstance(result, dict) else []
            changed_rows = 1 if replies and (replies[0].get("deleteDimension") or {}).get("deletedRows") == 1 else 0
        else:
            note = decision_note if action == "deny" and decision_note else target.get("note") or ""
            result = apps_script_client.post("updateSheetRange", {
                "range": f"'headsets'!A{row_number}:D{row_number}",
                "values": [[target["brand"], target["model"], new_status, note]],
            })
            changed_rows = int((result or {}).get("updatedRows") or 0)
    elif deleted:
        _shared_delete_existing_row(sheets_api, sheet_id, HEADSETS_TAB, row_number)
        changed_rows = 1
    else:
        note = decision_note if action == "deny" and decision_note else target.get("note") or ""
        _shared_update_existing_row(
            sheets_api,
            sheet_id,
            HEADSETS_TAB,
            HEADSETS_HEADERS,
            row_number,
            [target["brand"], target["model"], new_status, note],
        )
        changed_rows = 1

    if changed_rows != 1:
        raise _HeadsetCatalogMutationError("The approved headset catalog did not confirm exactly one changed row.")
    updated_rows = _apps_script_headset_catalog_rows(apps_script_client) if apps_script_client else _read_headsets_rows(sheets_api, sheet_id)
    _sync_headset_content_cache(updated_rows)
    return {
        "ok": True,
        "operation": action,
        "catalog_identity": target["catalog_identity"],
        "catalog_row_number": row_number,
        "brand": target["brand"],
        "model": target["model"],
        "previous_status": previous_status,
        "new_status": "deleted" if deleted else new_status,
        "deleted": deleted,
        "changed_rows": changed_rows,
        "skipped": False,
    }


def _sync_headset_content_cache(rows):
    csv_rows = [
        {"Brand": row.get("brand"), "Model": row.get("model"), "Status": row.get("status"), "Note": row.get("note")}
        for row in rows or []
    ]
    approved = _normalize_approved_headsets(csv_rows)
    denied = _normalize_denied_headsets(csv_rows)
    EXTERNAL_CONTENT["approved_headsets"] = approved
    EXTERNAL_CONTENT["denied_headsets"] = denied
    _headset_cache["groups"] = approved
    _headset_cache["denied"] = denied
    _headset_cache["last_fetch"] = time.time()


def _headset_review_snapshot(context=None):
    if configured_provider_mode() == "supabase":
        try:
            provider = _get_active_data_provider()
            raw_reviews = provider.list_resource("headset_reviews", limit=5000)
            review_rows = []
            for row in raw_reviews or []:
                payload = dict(row.get("source_payload") or {})
                for k, v in row.items():
                    if k != "source_payload" and k not in payload:
                        payload[k] = v
                brand, model = _split_headset_brand_model(
                    payload.get("headset_model") or payload.get("model"),
                    payload.get("Brand") or payload.get("brand"),
                    payload.get("Model") or payload.get("model"),
                )
                review_rows.append({
                    "review_id": str(payload.get("review_id") or payload.get("ReviewId") or "").strip(),
                    "source_session_id": str(payload.get("source_session_id") or payload.get("SourceSessionId") or "").strip(),
                    "brand": brand,
                    "model": model,
                    "status": str(payload.get("Status") or payload.get("review_status") or payload.get("status") or "pending").strip().lower() or "pending",
                    "note": str(payload.get("Note") or payload.get("ReviewNotes") or payload.get("Notes") or payload.get("notes") or "").strip(),
                    "submitted_date": str(payload.get("created_at") or payload.get("Timestamp") or payload.get("entered_at") or "").strip(),
                    "updated_at": str(payload.get("updated_at") or "").strip(),
                    "candidate": str(payload.get("candidate_name") or payload.get("CandidateName") or "").strip(),
                    "tester": str(payload.get("tester_name") or payload.get("SubmittedBy") or "").strip(),
                })
            headset_rows = provider.list_resource("headset_catalog", limit=5000)
            catalog_rows = []
            for row in headset_rows or []:
                payload = dict(row.get("source_payload") or {})
                for k, v in row.items():
                    if k != "source_payload" and k not in payload:
                        payload[k] = v
                catalog_rows.append({
                    "brand": str(payload.get("brand") or payload.get("Brand") or "").strip(),
                    "model": str(payload.get("model") or payload.get("Model") or "").strip(),
                    "status": str(payload.get("status") or payload.get("Status") or "").strip().lower(),
                    "note": str(payload.get("note") or payload.get("Note") or "").strip(),
                    "catalog_identity": str(payload.get("catalog_identity") or "").strip(),
                    "catalog_row_number": payload.get("catalog_row_number") or 0,
                })
            _sync_headset_content_cache(catalog_rows)
            public_row = lambda r: {
                "review_id": r.get("review_id") or "",
                "source_session_id": r.get("source_session_id") or "",
                "brand": r.get("brand") or "",
                "model": r.get("model") or "",
                "status": r.get("status") or "",
                "note": r.get("note") or "",
                "submitted_date": r.get("submitted_date") or "",
                "updated_at": r.get("updated_at") or "",
                "candidate": r.get("candidate") or "",
                "tester": r.get("tester") or "",
                "catalog_identity": r.get("catalog_identity") or "",
                "catalog_row_number": r.get("catalog_row_number") or 0,
            }
            return {
                "ok": True,
                "pending": [public_row(r) for r in review_rows if r.get("brand") and r.get("model") and r.get("status") in {"", "pending"}],
                "approved": [public_row(r) for r in catalog_rows if r.get("status") == "approved"],
                "denied": [public_row(r) for r in catalog_rows if r.get("status") == "denied"],
                "error": "",
            }
        except Exception as exc:
            logger.exception("[HEADSET-REVIEW] Failed to load headset review data from Supabase: %s", exc)
            return {"ok": False, "pending": [], "approved": [], "denied": [], "error": _headset_review_temporary_unavailable_message()}

    context = context or _shared_sheet_context()
    if not context.get("ok"):
        return {"ok": False, "pending": [], "approved": [], "denied": [], "error": _headset_review_temporary_unavailable_message()}
    try:
        apps_script_client = context.get("appsScriptClient")
        if apps_script_client:
            raw_reviews = _apps_script_rows(apps_script_client, "getHeadsetReviewLog")
            review_rows = []
            for row in raw_reviews:
                brand, model = _split_headset_brand_model(
                    row.get("headset_model"),
                    row.get("Brand") or row.get("brand"),
                    row.get("Model") or row.get("model"),
                )
                review_rows.append({
                    "review_id": str(row.get("review_id") or row.get("ReviewId") or "").strip(),
                    "source_session_id": str(row.get("source_session_id") or row.get("SourceSessionId") or "").strip(),
                    "brand": brand,
                    "model": model,
                    "status": str(row.get("Status") or row.get("review_status") or "pending").strip().lower() or "pending",
                    "note": str(row.get("Note") or row.get("ReviewNotes") or row.get("Notes") or row.get("notes") or "").strip(),
                    "submitted_date": str(row.get("created_at") or row.get("Timestamp") or row.get("entered_at") or "").strip(),
                    "updated_at": str(row.get("updated_at") or "").strip(),
                    "candidate": str(row.get("candidate_name") or row.get("CandidateName") or "").strip(),
                    "tester": str(row.get("tester_name") or row.get("SubmittedBy") or "").strip(),
                })
            headset_rows = _apps_script_headset_catalog_rows(apps_script_client)
            _sync_headset_content_cache(headset_rows)
            public_row = lambda row: {
                "review_id": row.get("review_id") or "",
                "source_session_id": row.get("source_session_id") or "",
                "brand": row.get("brand") or "",
                "model": row.get("model") or "",
                "status": row.get("status") or "",
                "note": row.get("note") or "",
                "submitted_date": row.get("submitted_date") or "",
                "updated_at": row.get("updated_at") or "",
                "candidate": row.get("candidate") or "",
                "tester": row.get("tester") or "",
                "catalog_identity": row.get("catalog_identity") or "",
                "catalog_row_number": row.get("catalog_row_number") or 0,
            }
            return {
                "ok": True,
                "pending": [public_row(row) for row in review_rows if row.get("brand") and row.get("model") and row.get("status") in {"", "pending"}],
                "approved": [public_row(row) for row in headset_rows if row.get("status") == "approved"],
                "denied": [public_row(row) for row in headset_rows if row.get("status") == "denied"],
                "error": "",
            }
        sheets_api = context["service"].spreadsheets()
        sheet_id = context["sheet_id"]
        schema = _headset_review_schema_from_context(context)
        headers = _headset_review_headers(schema)
        review_rows = [
            _normalize_headset_review_row(row, schema)
            for row in _shared_read_rows(sheets_api, sheet_id, HEADSET_REVIEW_LOG_TAB, headers)
        ]
        headset_rows = _read_headsets_rows(sheets_api, sheet_id)
        _sync_headset_content_cache(headset_rows)
        public_row = lambda row: {
            "review_id": row.get("review_id") or "",
            "source_session_id": row.get("source_session_id") or "",
            "brand": row.get("brand") or "",
            "model": row.get("model") or "",
            "status": row.get("status") or "",
            "note": row.get("note") or "",
            "submitted_date": row.get("submitted_date") or "",
            "updated_at": row.get("updated_at") or "",
            "candidate": row.get("candidate") or "",
            "tester": row.get("tester") or "",
            "catalog_identity": row.get("catalog_identity") or "",
            "catalog_row_number": row.get("catalog_row_number") or 0,
        }
        return {
            "ok": True,
            "pending": [public_row(row) for row in review_rows if row.get("brand") and row.get("model") and row.get("status") in {"", "pending"}],
            "approved": [public_row(row) for row in headset_rows if row.get("status") == "approved"],
            "denied": [public_row(row) for row in headset_rows if row.get("status") == "denied"],
            "error": "",
        }
    except Exception as exc:
        logger.exception("[HEADSET-REVIEW] Failed to load headset review data: %s", exc)
        return {"ok": False, "pending": [], "approved": [], "denied": [], "error": _headset_review_temporary_unavailable_message()}


def _edit_headset_review(payload):
    review_id = str((payload or {}).get("review_id") or "").strip()
    actor = str((payload or {}).get("actor") or "SAM").strip() or "SAM"
    if not review_id:
        return {"ok": False, "error": "Refresh Headset Review before editing this item."}
    try:
        context = _shared_sheet_context()
        if not context.get("ok"):
            return {"ok": False, "error": _headset_review_temporary_unavailable_message()}
        apps_script_client = context.get("appsScriptClient")
        if apps_script_client:
            result = apps_script_client.post("editHeadsetReview", {
                "review_id": review_id,
                "brand": str((payload or {}).get("brand") or "").strip(),
                "model": str((payload or {}).get("model") or "").strip(),
                "note": str((payload or {}).get("note") or "").strip(),
                "actor": actor,
            })
            return {"ok": True, "action": "edit", **(result if isinstance(result, dict) else {})}

        sheets_api = context["service"].spreadsheets()
        sheet_id = context["sheet_id"]
        schema = _headset_review_schema_from_context(context)
        headers = _headset_review_headers(schema)
        rows = _shared_read_rows(sheets_api, sheet_id, HEADSET_REVIEW_LOG_TAB, headers)
        target = next((row for row in rows if _normalize_headset_review_row(row, schema).get("review_id") == review_id), None)
        if not target:
            return {"ok": False, "error": "The selected headset review could not be found. Refresh Headset Review and try again."}
        normalized = _normalize_headset_review_row(target, schema)
        if str(normalized.get("status") or "pending").lower() not in {"", "pending"}:
            return {"ok": False, "error": "Only pending headset reviews can be edited."}
        brand_value = (payload or {}).get("brand") if "brand" in (payload or {}) else normalized.get("brand")
        model_value = (payload or {}).get("model") if "model" in (payload or {}) else normalized.get("model")
        brand = re.sub(r"\s+", " ", str(brand_value or "").strip())
        model = re.sub(r"\s+", " ", str(model_value or "").strip())
        if not brand and not model:
            return {"ok": False, "error": "Enter a headset brand or model."}
        note = str((payload or {}).get("note") or "").strip()
        approved_match = any(
            _headset_identity_key(row.get("brand"), row.get("model")) == _headset_identity_key(brand, model)
            and str(row.get("status") or "approved").lower() == "approved"
            for row in _read_headsets_rows(sheets_api, sheet_id)
        )
        before = {"brand": normalized.get("brand") or "", "model": normalized.get("model") or "", "note": normalized.get("note") or ""}
        now_iso = datetime.now(timezone.utc).isoformat()
        next_row = dict(target)
        if schema == "legacy":
            next_row.update({"headset_model": _headset_display_label(brand, model), "notes": note})
        else:
            next_row.update({"Brand": brand, "Model": model, "Note": note})
            if schema == "review":
                next_row.update({"updated_at": now_iso, "decision_by": actor})
        _shared_update_existing_row(
            sheets_api, sheet_id, HEADSET_REVIEW_LOG_TAB, headers,
            target.get("_row_number"), _shared_row_values(next_row, headers),
        )
        source_session_id = str(normalized.get("source_session_id") or "").strip()
        if source_session_id:
            candidate_rows = _shared_read_rows(sheets_api, sheet_id, SHARED_CANDIDATE_SESSIONS_TAB, SHARED_CANDIDATE_SESSION_HEADERS)
            candidate = next((row for row in candidate_rows if str(row.get("session_id") or "").strip() == source_session_id), None)
            if candidate:
                candidate["headset_brand"] = _headset_display_label(brand, model)
                _shared_update_existing_row(
                    sheets_api, sheet_id, SHARED_CANDIDATE_SESSIONS_TAB, SHARED_CANDIDATE_SESSION_HEADERS,
                    candidate.get("_row_number"), _shared_row_values(candidate, SHARED_CANDIDATE_SESSION_HEADERS),
                )
        return {
            "ok": True, "action": "edit", "review_id": review_id,
            "source_session_id": source_session_id, "brand": brand, "model": model,
            "note": note, "status": "pending", "updated_at": now_iso,
            "approved_match": approved_match,
            "audit": {"actor": actor, "before": before, "after": {"brand": brand, "model": model, "note": note}},
        }
    except Exception as exc:
        logger.exception("[HEADSET-REVIEW] Failed to edit pending headset review: %s", exc)
        return {"ok": False, "error": "Unable to update the pending headset review."}


def _headset_review_action(payload):
    action = str((payload or {}).get("action") or "").strip().lower()
    if action == "edit":
        return _edit_headset_review(payload)
    if action == "review_later":
        return {"ok": True, "action": action}
    if action not in {"approve", "deny", "archive", "delete"}:
        return {"ok": False, "error": "Select Edit, Approve, Deny, Archive, Delete, or Review Later."}

    brand = str((payload or {}).get("brand") or "").strip()
    model = str((payload or {}).get("model") or "").strip()
    review_id = str((payload or {}).get("review_id") or "").strip()
    if not brand or not model:
        return {"ok": False, "error": "Brand and Model are required."}

    reason = str((payload or {}).get("reason") or "").strip()
    other_note = str((payload or {}).get("note") or "").strip()
    allowed_denials = {
        "Headset does not connect via USB",
        "Headset does not have a noise cancelling microphone",
        "Other",
    }
    if action == "deny" and reason not in allowed_denials:
        return {"ok": False, "error": "Select a denial reason."}
    if action == "deny" and reason == "Other" and not other_note:
        return {"ok": False, "error": "A note is required when the denial reason is Other."}
    decision_note = other_note if action == "deny" and reason == "Other" else (reason if action == "deny" else other_note)
    decision_status = "approved" if action == "approve" else "denied" if action == "deny" else "archived"

    try:
        context = _shared_sheet_context()
        if not context.get("ok"):
            return {"ok": False, "error": _headset_review_temporary_unavailable_message()}
        if str((payload or {}).get("catalog_identity") or "").strip():
            return _apply_headset_catalog_action(context, payload, action, decision_note)
        apps_script_client = context.get("appsScriptClient")
        if apps_script_client:
            post_action = {
                "approve": "approveHeadset",
                "deny": "denyHeadset",
                "archive": "archiveHeadsetReview",
                "delete": "deleteHeadsetReview",
            }[action]
            result = apps_script_client.post(post_action, {
                "brand": brand,
                "model": model,
                "reason": reason,
                "note": decision_note,
                "review_id": str((payload or {}).get("review_id") or "").strip(),
                "submitted_date": str((payload or {}).get("submitted_date") or "").strip(),
                "tester": str((payload or {}).get("tester") or "").strip(),
                "actor": str((payload or {}).get("actor") or "SAM").strip() or "SAM",
            })
            refreshed = _apps_script_rows(apps_script_client, "getHeadsets")
            _sync_headset_content_cache([
                {
                    "brand": str(row.get("Brand") or row.get("brand") or "").strip(),
                    "model": str(row.get("Model") or row.get("model") or "").strip(),
                    "status": str(row.get("Status") or row.get("status") or "approved").strip().lower() or "approved",
                    "note": str(row.get("Note") or row.get("note") or "").strip(),
                }
                for row in refreshed
            ])
            return {
                "ok": True,
                "action": action,
                "status": decision_status,
                "brand": brand,
                "model": model,
                **(result if isinstance(result, dict) else {}),
            }
        sheets_api = context["service"].spreadsheets()
        sheet_id = context["sheet_id"]
        schema = _headset_review_schema_from_context(context)
        review_headers = _headset_review_headers(schema)
        review_rows = _shared_read_rows(sheets_api, sheet_id, HEADSET_REVIEW_LOG_TAB, review_headers)
        target_key = _headset_identity_key(brand, model)
        matched_review = False
        for row in review_rows:
            normalized = _normalize_headset_review_row(row, schema)
            row_key = _headset_identity_key(normalized["brand"], normalized["model"])
            if schema == "review" and review_id:
                if normalized.get("review_id") != review_id:
                    continue
            elif row_key != target_key:
                continue
            matched_review = True
            # A stable review ID is authoritative. The card may have been
            # edited after it loaded, so approval must use the current row.
            brand = normalized.get("brand") or brand
            model = normalized.get("model") or model
            target_key = _headset_identity_key(brand, model)
            current_status = str(normalized.get("status") or "pending").lower()
            if current_status not in {"", "pending", decision_status}:
                return {"ok": False, "error": "This headset review was already resolved with a different decision."}
            if action == "delete":
                _shared_delete_existing_row(sheets_api, sheet_id, HEADSET_REVIEW_LOG_TAB, row.get("_row_number"))
                return {"ok": True, "action": action, "brand": brand, "model": model}
            if schema == "legacy":
                next_row = dict(row)
                next_row["review_status"] = decision_status
                next_row["notes"] = decision_note
                row_values = _shared_row_values(next_row, LEGACY_HEADSET_REVIEW_LOG_HEADERS)
            elif schema == "basic":
                row_values = [brand, model, decision_status, decision_note]
            else:
                next_row = dict(row)
                next_row.update({
                    "Status": decision_status,
                    "Note": decision_note,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                    "decision_at": datetime.now(timezone.utc).isoformat(),
                    "decision_by": str((payload or {}).get("actor") or "SAM").strip() or "SAM",
                    "denial_reason": reason if action == "deny" else "",
                })
                row_values = _shared_row_values(next_row, HEADSET_REVIEW_LOG_HEADERS)
            _shared_update_existing_row(
                sheets_api, sheet_id, HEADSET_REVIEW_LOG_TAB, review_headers,
                row.get("_row_number"), row_values,
            )
            break

        if not matched_review:
            return {"ok": False, "error": "The selected headset review could not be found. Refresh Headset Review and try again."}

        if action == "archive":
            return {"ok": True, "action": action, "status": decision_status, "brand": brand, "model": model}

        headset_rows = _read_headsets_rows(sheets_api, sheet_id)
        existing = next((row for row in headset_rows if _headset_identity_key(row["brand"], row["model"]) == target_key), None)
        row_values = [brand, model, decision_status, decision_note]
        quoted = _quote_sheet_title_for_a1(HEADSETS_TAB)
        if existing:
            _shared_update_existing_row(
                sheets_api, sheet_id, HEADSETS_TAB, HEADSETS_HEADERS,
                existing.get("_row_number"), row_values,
            )
        else:
            sheets_api.values().append(
                spreadsheetId=sheet_id,
                range=f"{quoted}!A2",
                valueInputOption="USER_ENTERED",
                insertDataOption="INSERT_ROWS",
                body={"values": [row_values]},
            ).execute()

        updated_rows = _read_headsets_rows(sheets_api, sheet_id)
        # Keep the in-memory display deterministic without rewriting the whole tab.
        # Existing rows are updated in place and new rows are appended so unrelated
        # sheet content is never shifted, deleted, or overwritten for sorting alone.
        sorted_rows = sorted(updated_rows, key=lambda row: (row.get("brand", "").lower(), row.get("model", "").lower()))
        _sync_headset_content_cache(sorted_rows)
        return {"ok": True, "action": action, "status": decision_status, "brand": brand, "model": model}
    except _HeadsetCatalogMutationError as exc:
        logger.warning("[HEADSET-REVIEW] Catalog mutation stopped safely: %s", exc)
        return {"ok": False, "error": str(exc)}
    except Exception as exc:
        logger.exception("[HEADSET-REVIEW] Failed to apply headset decision: %s", exc)
        return {"ok": False, "error": "Unable to save the headset review decision."}


def _shared_row_values(row, headers):
    return [row.get(header, "") for header in headers]


def _candidate_name_key(value):
    return " ".join(str(value or "").strip().lower().split())


def _candidate_row_active(row):
    if _shared_truthy(row.get("archived")):
        return False
    return True


def _parse_shared_candidate_datetime(value):
    raw = str(value or "").strip()
    if not raw:
        return None
    candidates = [raw]
    if raw.endswith("Z"):
        candidates.append(f"{raw[:-1]}+00:00")
    for candidate in candidates:
        try:
            parsed = datetime.fromisoformat(candidate)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except Exception:
            continue
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
        except Exception:
            continue
    return None


def _candidate_auto_archive_eligible(row, now=None, days=60):
    if not row or _shared_truthy(row.get("archived")):
        return False
    status = str(row.get("status") or row.get("latest_status") or "").strip().upper()
    if status not in {"PASS", "RESUMED-PASS", "WITHDREW FROM CERTIFICATION", "FAIL-FINAL ATTEMPT"}:
        return False
    closed_at = _parse_shared_candidate_datetime(
        row.get("withdrawn_at") if status == "WITHDREW FROM CERTIFICATION" else None
    ) or _parse_shared_candidate_datetime(row.get("completed_at")) or _parse_shared_candidate_datetime(row.get("last_session_date"))
    if not closed_at:
        return False
    reference = now or datetime.now(timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    return closed_at <= reference.astimezone(timezone.utc) - timedelta(days=days)


def _auto_archive_candidate_rows(sheets_api, sheet_id, candidate_rows, now=None):
    updated = 0
    for row in candidate_rows:
        if not _candidate_auto_archive_eligible(row, now=now):
            continue
        row["archived"] = "TRUE"
        row["review_notes"] = "\n\n".join(part for part in [
            row.get("review_notes") or "",
            f"Auto-archived by SAM after 60 days closed at {datetime.now(timezone.utc).isoformat()}.",
        ] if str(part or "").strip())
        try:
            _shared_update_existing_row(
                sheets_api,
                sheet_id,
                SHARED_CANDIDATE_SESSIONS_TAB,
                SHARED_CANDIDATE_SESSION_HEADERS,
                row["_row_number"],
                _shared_row_values(row, SHARED_CANDIDATE_SESSION_HEADERS),
            )
            updated += 1
        except Exception as exc:
            logger.warning("[SHARED] Auto-archive skipped for candidate row %s: %s", row.get("_row_number") or "unknown", exc)
    return updated


def _candidate_row_withdrawn(row):
    return _shared_truthy((row or {}).get("withdrawn")) or str((row or {}).get("status") or (row or {}).get("latest_status") or "").upper() == "WITHDREW FROM CERTIFICATION"


def _candidate_row_extra_attempt(row):
    source = row or {}
    try:
        if int(source.get("extra_attempts_granted") or 0) > 0:
            return True
    except (TypeError, ValueError):
        pass
    return _shared_truthy(source.get("extra_attempt_granted"))


def _candidate_extra_attempt_count(row):
    source = row or {}
    try:
        explicit = max(0, int(source.get("extra_attempts_granted") or 0))
    except (TypeError, ValueError):
        explicit = 0
    return max(explicit, 1 if _shared_truthy(source.get("extra_attempt_granted")) else 0)


def _candidate_stored_attempt_number(row):
    source = row or {}
    for key in ("current_attempt_number", "attempt_number", "newbie_shift_current_attempt"):
        try:
            value = int(source.get(key) or 0)
        except (TypeError, ValueError):
            value = 0
        if value > 0:
            return value
    return 0


def _candidate_attempt_identity(row, fallback_index=0):
    source = row or {}
    for key in ("session_id", "history_id", "resume_source_history_id", "newbie_shift_request_id"):
        value = str(source.get(key) or "").strip()
        if value:
            return f"{key}:{value}"
    completed_at = str(source.get("completed_at") or source.get("timestamp_iso") or source.get("timestamp") or "").strip()
    candidate = " ".join(str(source.get("candidate_name") or source.get("candidate") or "").lower().split())
    return f"fallback:{candidate}:{completed_at}:{fallback_index}"


def _candidate_attempt_disposition(row):
    """Return whether one persisted workflow record consumes an attempt."""
    source = row or {}
    if _shared_truthy(source.get("archived")):
        return False, "archived"
    if source.get("attempt_counts") is not None and not _shared_truthy(source.get("attempt_counts")):
        return False, "explicit_non_counting"

    request_type = str(source.get("newbie_shift_request_type") or source.get("request_type") or "").strip().lower()
    if request_type in {NEWBIE_REQUEST_RESCHEDULE, "newbie_shift_reschedule"}:
        if _shared_truthy(source.get("newbie_shift_counts_as_attempt") or source.get("counts_as_attempt")):
            return True, "candidate_late_newbie_reschedule"
        return False, "non_counting_newbie_reschedule"

    status = _shared_status_upper(source)
    if status in {"FAIL", "FAIL-FINAL ATTEMPT", "NC/NS"}:
        return True, "terminal_failure"
    if source.get("auto_fail_reason"):
        return True, "auto_fail"

    sup_results = [
        str((source.get(f"sup_transfer_{i}") or {}).get("result") or source.get(f"sup_transfer_{i}_result") or "").strip().lower()
        for i in range(1, 3)
    ]
    call_results = [
        str((source.get(f"call_{i}") or {}).get("result") or source.get(f"call_{i}_result") or "").strip().lower()
        for i in range(1, 4)
    ]
    if call_results.count("fail") >= 2:
        return True, "failed_mock_calls"
    if sup_results.count("fail") >= 2 and (source.get("supervisor_only") or call_results.count("pass") >= 2):
        return True, "failed_supervisor_transfer"
    return False, "non_counting_incomplete"


def _candidate_qualifying_failure(row):
    return _candidate_attempt_disposition(row)[0]


def calculate_candidate_attempt_state(rows, active_session=None):
    """Authoritative attempt state for candidate lookup, retry routing, and history."""
    records = [dict(row or {}) for row in (rows or []) if isinstance(row, dict)]
    active = dict(active_session or {}) if isinstance(active_session, dict) else None
    seen = set()
    counted_events = []
    non_counting_events = []

    for index, row in enumerate(records):
        identity = _candidate_attempt_identity(row, index)
        if identity in seen:
            continue
        seen.add(identity)
        counts, reason = _candidate_attempt_disposition(row)
        event = {"id": identity, "reason": reason}
        (counted_events if counts else non_counting_events).append(event)

    counted_attempts = len(counted_events)
    highest_completed_attempt = max(
        (
            _candidate_stored_attempt_number(row)
            for row in records
            if _candidate_attempt_disposition(row)[0]
        ),
        default=0,
    )
    counted_attempts = max(counted_attempts, highest_completed_attempt)
    active_counts = False
    if active:
        try:
            stored_prior = max(0, int(active.get("prior_counted_attempts") or 0))
        except (TypeError, ValueError):
            stored_prior = 0
        counted_attempts = max(counted_attempts, stored_prior)
        active_identity = _candidate_attempt_identity(active, len(records))
        active_counts, active_reason = _candidate_attempt_disposition(active)
        if active_counts and active_identity not in seen:
            counted_events.append({"id": active_identity, "reason": active_reason})
            counted_attempts += 1
            seen.add(active_identity)

    all_records = records + ([active] if active else [])
    extra_attempts_granted = max((_candidate_extra_attempt_count(row) for row in all_records), default=0)
    extra_attempt_granted = extra_attempts_granted > 0
    stored_max = 0
    for row in all_records:
        candidates = [row.get("allowed_attempt_count")]
        if isinstance(row.get("attempt_state"), dict):
            candidates.append(row["attempt_state"].get("max_attempts"))
        for candidate in candidates:
            try:
                stored_max = max(stored_max, int(candidate or 0))
            except (TypeError, ValueError):
                continue
    max_attempts = max(CERTIFICATION_BASE_MAX_ATTEMPTS + extra_attempts_granted, stored_max)

    withdrawn = any(_candidate_row_withdrawn(row) for row in all_records)
    passed = any(_shared_status_upper(row) in {"PASS", "PASSED", "RESUMED-PASS"} for row in all_records)
    final_attempt_failed = any(
        _shared_status_upper(row) == "FAIL-FINAL ATTEMPT"
        or (
            _shared_truthy(row.get("final_attempt"))
            and _candidate_qualifying_failure(row)
            and not _shared_truthy(row.get("supervisor_retry_required"))
            and not row.get("newbie_shift_data")
        )
        for row in all_records
    )
    exhausted = counted_attempts >= max_attempts
    explicit_active_attempt = _candidate_stored_attempt_number(active) if active else 0
    final_attempt_failed = bool(final_attempt_failed and max(counted_attempts, explicit_active_attempt) >= max_attempts)
    terminal = bool(withdrawn or passed or final_attempt_failed or exhausted)
    if withdrawn:
        reason = "candidate_withdrawn"
    elif passed:
        reason = "candidate_already_passed"
    elif final_attempt_failed or exhausted:
        reason = "final_attempt_exhausted"
    elif counted_attempts == max_attempts - 1:
        reason = "next_attempt_is_final"
    elif counted_attempts:
        reason = "prior_counted_failure"
    else:
        reason = "first_attempt"

    current_attempt = max(
        1,
        explicit_active_attempt if active and not active_counts else (counted_attempts if terminal else counted_attempts + 1),
    )
    current_attempt = min(max_attempts, current_attempt)
    remaining_attempts = max(0, max_attempts - current_attempt)
    final_attempt = bool(current_attempt == max_attempts)
    return {
        "current_attempt": current_attempt,
        "max_attempts": max_attempts,
        "remaining_attempts": remaining_attempts,
        "final_attempt": final_attempt,
        "reason": reason,
        "terminal": terminal,
        "retry_allowed": not terminal and counted_attempts < max_attempts,
        "counted_attempts": counted_attempts,
        "counted_events": counted_events,
        "non_counting_events": non_counting_events,
        "extra_attempt_granted": extra_attempt_granted,
        "extra_attempts_granted": extra_attempts_granted,
        "withdrawn": withdrawn,
        "passed": passed,
    }


def _candidate_attempt_summary(rows):
    state = calculate_candidate_attempt_state(rows)
    return {
        "attempt_count": state["counted_attempts"],
        "current_attempt_number": state["current_attempt"],
        "allowed_attempt_count": state["max_attempts"],
        "extra_attempts_granted": state["extra_attempts_granted"],
        "final_attempt_risk": state["final_attempt"] and not state["terminal"],
        "extra_attempt_granted": state["extra_attempt_granted"],
        "withdrawn": state["withdrawn"],
        "attempt_state": state,
    }


def _shared_sheet_gid(sheets_api, sheet_id, tab_name):
    metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
    for sheet in metadata.get("sheets", []):
        props = sheet.get("properties") or {}
        if props.get("title") == tab_name:
            return props.get("sheetId")
    return None


def _candidate_authoritative_status(row):
    """Resolve one candidate-level result for tracking, history, and exports."""
    source = row or {}

    def normalized(value):
        text = re.sub(r"[\u2013\u2014_-]+", " ", str(value or "").strip().upper())
        return re.sub(r"\s+", " ", text).strip()

    def public(value, final=False):
        value = normalized(value)
        if value in {"PASS", "PASSED", "RESUMED PASS"}:
            return "Pass"
        if value in {"FAIL FINAL ATTEMPT", "FAILED FINAL ATTEMPT"} or final:
            return "FAIL-Final Attempt"
        if value in {"FAIL", "FAILED"}:
            return "Fail"
        if value in {"WITHDREW FROM CERTIFICATION", "WITHDRAWN"}:
            return "WITHDREW FROM CERTIFICATION"
        if value in {"ARCHIVED", "REMOVED", "DELETED"}:
            return value
        if value in {"INCOMPLETE", "PENDING", "IN PROGRESS"}:
            return "INCOMPLETE"
        return str(value or "").strip()

    override = source.get("readiness_override_result") if _shared_truthy(source.get("readiness_override_applied")) else ""
    if normalized(override) in {"PASS", "PASSED", "FAIL", "FAILED", "FAIL FINAL ATTEMPT", "FAILED FINAL ATTEMPT"}:
        return public(override, normalized(override) in {"FAIL FINAL ATTEMPT", "FAILED FINAL ATTEMPT"})

    final_result = normalized(source.get("final_result"))
    if final_result in {"FAIL", "FAILED", "FAIL FINAL ATTEMPT", "FAILED FINAL ATTEMPT"}:
        return public(final_result, final_result in {"FAIL FINAL ATTEMPT", "FAILED FINAL ATTEMPT"})

    status = normalized(source.get("status") or source.get("latest_status"))
    if status in {"FAIL FINAL ATTEMPT", "FAILED FINAL ATTEMPT"}:
        return "FAIL-Final Attempt"
    sup_results = [
        normalized(source.get(f"sup_transfer_{index}_result") or (source.get(f"sup_transfer_{index}") or {}).get("result"))
        for index in range(1, 3)
    ]
    required_sup_failed = sum(1 for result in sup_results if result in {"FAIL", "FAILED"}) >= 2
    if _shared_truthy(source.get("final_attempt")) and (required_sup_failed or _candidate_qualifying_failure(source)):
        return "FAIL-Final Attempt"
    if status in {"FAIL", "FAILED"}:
        return "Fail"
    if final_result in {"PASS", "PASSED", "RESUMED PASS"}:
        return public(final_result)
    if status:
        return public(status)
    return public(source.get("calculated_result")) or "INCOMPLETE"


def _apply_authoritative_candidate_status(row):
    next_row = dict(row or {})
    authoritative = _candidate_authoritative_status(next_row)
    next_row["status"] = authoritative
    next_row["latest_status"] = authoritative
    next_row["authoritative_status"] = authoritative
    return next_row


def _assemble_candidate_snapshot(candidate_rows, pending_rows, auto_archived_count=0):
    def summarize_candidate_groups(rows_to_group):
        grouped = {}
        for row in rows_to_group:
            grouped.setdefault(_candidate_name_key(row.get("candidate_name")), []).append(row)

        summaries = []
        for key, rows in grouped.items():
            if not key:
                continue
            rows.sort(key=lambda row: str(row.get("completed_at") or row.get("created_at") or ""), reverse=True)
            latest = rows[0]
            summary = _candidate_attempt_summary(rows)
            summaries.append({
                **latest,
                **summary,
                "attempts": rows,
                "latest_session_id": latest.get("session_id") or "",
                "latest_status": latest.get("status") or "",
                "last_session_date": latest.get("completed_at") or latest.get("created_at") or "",
            })
        return summaries

    active_candidates = [row for row in candidate_rows if _candidate_row_active(row)]
    archived_candidates = [row for row in candidate_rows if _shared_truthy(row.get("archived"))]
    candidate_summaries = summarize_candidate_groups(active_candidates)
    archived_summaries = summarize_candidate_groups(archived_candidates)

    pending_active = _filter_current_pending_sup_transfers(pending_rows, candidate_summaries)
    failed_not_final = [
        row for row in candidate_summaries
        if str(row.get("latest_status") or "").upper() == "FAIL"
        and not _candidate_row_withdrawn(row)
    ]
    failed_final_attempts = [
        row for row in candidate_summaries
        if str(row.get("latest_status") or "").upper() == "FAIL-FINAL ATTEMPT"
        and not _candidate_row_withdrawn(row)
    ]
    incomplete = [
        row for row in candidate_summaries
        if str(row.get("latest_status") or "").upper() == "INCOMPLETE" and not _candidate_row_withdrawn(row)
    ]
    withdrawn = [row for row in candidate_summaries if _candidate_row_withdrawn(row)]
    extra_attempt = [row for row in candidate_summaries if _candidate_row_extra_attempt(row)]
    passed_certifications = [
        row for row in candidate_summaries
        if str(row.get("latest_status") or "").upper() in {"PASS", "RESUMED-PASS"}
        and not _candidate_row_withdrawn(row)
    ]

    return {
        "ok": True,
        "setup": _shared_tracking_required_setup(),
        "autoArchivedCount": auto_archived_count,
        "candidates": candidate_summaries + archived_summaries,
        "pending": pending_active,
        "views": {
            "pending": pending_active,
            "failedNotFinal": failed_not_final,
            "failedFinalAttempts": failed_final_attempts,
            "incomplete": incomplete,
            "withdrawn": withdrawn,
            "extraAttemptGranted": extra_attempt,
            "passedCertifications": passed_certifications,
            "archived": archived_summaries,
            "allActive": [row for row in candidate_summaries if not _candidate_row_withdrawn(row)],
        },
    }


def _shared_admin_candidate_snapshot(context=None):
    if configured_provider_mode() == "supabase":
        try:
            provider = _get_active_data_provider()
            sessions_raw = provider.list_resource("candidate_sessions", limit=5000)
            pending_raw = provider.list_resource("supervisor_transfers", limit=5000)
            candidate_rows = []
            for s in sessions_raw or []:
                payload = dict(s.get("source_payload") or {})
                for k, v in s.items():
                    if k != "source_payload" and k not in payload:
                        payload[k] = v
                candidate_rows.append(_apply_authoritative_candidate_status(_normalize_shared_row(payload)))
            pending_rows = []
            for p in pending_raw or []:
                payload = dict(p.get("source_payload") or {})
                for k, v in p.items():
                    if k != "source_payload" and k not in payload:
                        payload[k] = v
                pending_rows.append(_normalize_shared_row(payload))
            return _assemble_candidate_snapshot(candidate_rows, pending_rows, auto_archived_count=0)
        except Exception as exc:
            logger.exception("[SHARED] Failed to read admin candidate tracking rows from Supabase: %s", exc)
            return {"ok": False, "error": _candidate_tracking_temporary_unavailable_message(), "setup": _shared_tracking_required_setup(), "candidates": [], "pending": []}

    context = context or _shared_sheet_context()
    if not context.get("ok"):
        return {"ok": False, "error": _candidate_tracking_temporary_unavailable_message(), "setup": _shared_tracking_required_setup(), "candidates": [], "pending": []}

    try:
        apps_script_client = context.get("appsScriptClient")
        if apps_script_client:
            tracking_result = apps_script_client.get("getCandidateTracking", {})
            raw_rows = tracking_result.get("rows") if isinstance(tracking_result, dict) else []
            if not isinstance(raw_rows, list):
                raw_rows = []
            candidates = []
            for index, row in enumerate(raw_rows, start=1):
                if not isinstance(row, dict):
                    continue
                candidate_name = str(row.get("candidate_name") or row.get("CandidateName") or row.get("Candidate Name") or "").strip()
                status = str(row.get("status") or row.get("Status") or "").strip()
                timestamp = str(row.get("completed_at") or row.get("Timestamp") or row.get("created_at") or "").strip()
                notes = str(row.get("notes") or row.get("Notes") or row.get("review_notes") or "").strip()
                updated_by = str(row.get("tester_name") or row.get("UpdatedBy") or row.get("updated_by") or "").strip()
                candidate = _apply_authoritative_candidate_status({
                    **{
                        key: value
                        for key, value in row.items()
                        if str(key).lower() == str(key)
                    },
                    "session_id": str(row.get("session_id") or f"apps-script-{index}"),
                    "candidate_name": candidate_name,
                    "status": status,
                    "latest_status": status,
                    "completed_at": timestamp,
                    "last_session_date": timestamp,
                    "notes": notes,
                    "review_notes": notes,
                    "tester_name": updated_by,
                    "attempt_count": row.get("attempt_count") or row.get("attempt_number") or 1,
                })
                candidate["attempts"] = [dict(candidate)]
                candidates.append(candidate)
            active = [row for row in candidates if not _shared_truthy(row.get("archived")) and str(row.get("status") or "").strip().upper() not in {"ARCHIVED", "REMOVED", "DELETED"}]
            archived = [row for row in candidates if _shared_truthy(row.get("archived")) or str(row.get("status") or "").strip().upper() in {"ARCHIVED", "REMOVED", "DELETED"}]
            withdrawn = [row for row in active if str(row.get("status") or "").strip().upper() == "WITHDREW FROM CERTIFICATION"]
            passed = [row for row in active if str(row.get("status") or "").strip().upper() in {"PASS", "PASSED", "RESUMED-PASS"}]
            failed_final = [row for row in active if str(row.get("status") or "").strip().upper() == "FAIL-FINAL ATTEMPT"]
            failed = [row for row in active if str(row.get("status") or "").strip().upper() in {"FAIL", "FAILED"}]
            incomplete = [row for row in active if str(row.get("status") or "").strip().upper() == "INCOMPLETE"]

            raw_pending = tracking_result.get("pendingRows") if isinstance(tracking_result, dict) else []
            pending = [
                {
                    **{key: value for key, value in row.items() if str(key).lower() == str(key)},
                    "pending_id": str(row.get("pending_id") or row.get("PendingId") or "").strip(),
                    "candidate_name": str(row.get("candidate_name") or row.get("CandidateName") or "").strip(),
                    "status": str(row.get("status") or row.get("Status") or "pending").strip(),
                    "created_at": str(row.get("created_at") or row.get("Timestamp") or "").strip(),
                }
                for row in (raw_pending or [])
                if isinstance(row, dict)
            ]
            pending_active = _filter_current_pending_sup_transfers(pending, candidates)

            return {
                "ok": True,
                "setup": _shared_tracking_required_setup(),
                "autoArchivedCount": 0,
                "candidates": candidates,
                "pending": pending_active,
                "views": {
                    "pending": pending_active,
                    "failedNotFinal": failed,
                    "failedFinalAttempts": failed_final,
                    "incomplete": incomplete,
                    "withdrawn": withdrawn,
                    "extraAttemptGranted": [row for row in active if _shared_truthy(row.get("extra_attempt_granted"))],
                    "passedCertifications": passed,
                    "archived": archived,
                    "allActive": active,
                },
            }

        sheets_api = context["service"].spreadsheets()
        sheet_id = context["sheet_id"]
        candidate_rows = [
            _apply_authoritative_candidate_status(_normalize_shared_row(row))
            for row in _shared_read_rows(
                sheets_api,
                sheet_id,
                SHARED_CANDIDATE_SESSIONS_TAB,
                SHARED_CANDIDATE_SESSION_HEADERS,
            )
        ]
        pending_rows = [
            _normalize_shared_row(row)
            for row in _shared_read_rows(
                sheets_api,
                sheet_id,
                SHARED_PENDING_SUP_TRANSFERS_TAB,
                SHARED_PENDING_SUP_TRANSFER_HEADERS,
            )
        ]
        auto_archived_count = _auto_archive_candidate_rows(sheets_api, sheet_id, candidate_rows)
        return _assemble_candidate_snapshot(candidate_rows, pending_rows, auto_archived_count)
    except Exception as exc:
        if _google_sheet_quota_or_temporary_error(exc):
            logger.warning("[SHARED] Candidate Tracking temporarily unavailable due to Google Sheets quota/rate limit: %s", exc)
        else:
            logger.exception("[SHARED] Failed to read admin candidate tracking rows: %s", exc)
        return {"ok": False, "error": _candidate_tracking_temporary_unavailable_message(), "setup": _shared_tracking_required_setup(), "candidates": [], "pending": []}


def _request_status_value(value):
    return str(value or "").strip().lower() or "pending"


def _approval_label(status):
    normalized = _request_status_value(status)
    if normalized == "approved":
        return "Approved"
    if normalized == "denied":
        return "Denied"
    return "Pending"


def _normalize_newbie_shift_number(value):
    text = re.sub(r"[\x00-\x1f\x7f]", "", str(value or "")).strip()
    return text[:64]


def _public_newbie_request(row):
    request_type = str(row.get("request_type") or "").strip().lower()
    requested_by = str(row.get("requested_by") or "").strip().lower()
    return {
        "id": row.get("request_id") or "",
        "request_id": row.get("request_id") or "",
        "session_id": row.get("session_id") or "",
        "category": "newbie_reschedule" if request_type == NEWBIE_REQUEST_RESCHEDULE else "newbie_initial",
        "categoryLabel": "Newbie Shift — Reschedule" if request_type == NEWBIE_REQUEST_RESCHEDULE else "Newbie Shift — Initial",
        "candidate": row.get("candidate_name") or "",
        "tester": row.get("tester_name") or "",
        "created_at": row.get("request_created_at") or "",
        "requested_schedule": row.get("scheduled_at") or row.get("rescheduled_at") or row.get("requested_scheduled_at") or "",
        "original_schedule": row.get("original_scheduled_at") or row.get("original_schedule") or row.get("newbie_shift_original_scheduled_at") or "",
        "timezone": row.get("timezone") or "",
        "newbie_shift_number": str(row.get("newbie_shift_number") or "").strip(),
        "requester": "Candidate" if requested_by == NEWBIE_REQUESTED_BY_CANDIDATE else "Tester/Trainer" if requested_by == NEWBIE_REQUESTED_BY_TESTER else "Other" if requested_by == "other" else "",
        "reason": row.get("request_reason") or "",
        "details": row.get("request_details") or "",
        "within_24_hours": _shared_truthy(row.get("within_24_hours")),
        "counts_as_attempt": _shared_truthy(row.get("counts_as_attempt")),
        "final_attempt": _shared_truthy(row.get("final_attempt")),
        "lead_time_seconds": row.get("lead_time_seconds"),
        "lead_time_category": row.get("lead_time_category") or "",
        "current_attempt": _positive_attempt_number(row.get("current_attempt"), 1),
        "resulting_attempt": _positive_attempt_number(row.get("resulting_attempt"), 1),
        "becomes_final_attempt": _shared_truthy(row.get("becomes_final_attempt")),
        "attempt_rule": row.get("attempt_rule") or "",
        "terminal_outcome": row.get("terminal_outcome") or "",
        "status": _approval_label(row.get("request_status")),
        "raw_status": _request_status_value(row.get("request_status")),
        "admin_decision_at": row.get("admin_decision_at") or "",
        "admin_decision_by": row.get("admin_decision_by") or "",
        "denial_reason": row.get("denial_reason") or "",
    }


def _public_deletion_request(row):
    audit_fields = {}
    for part in str(row.get("audit_summary") or "").split(";"):
        key, separator, value = part.partition("=")
        if separator:
            audit_fields[key.strip()] = value.strip()
    return {
        "id": row.get("request_id") or "",
        "request_id": row.get("request_id") or "",
        "session_id": row.get("session_id") or "",
        "category": "candidate_deletion",
        "categoryLabel": "Candidate Deletion Request",
        "candidate": row.get("candidate_name") or "",
        "tester": row.get("tester_name") or "",
        "created_at": row.get("created_at") or "",
        "requested_schedule": "",
        "original_schedule": "",
        "timezone": "",
        "requester": "Tester",
        "reason": row.get("reason") or "Trainer requested candidate-list deletion review.",
        "details": "",
        "within_24_hours": False,
        "counts_as_attempt": False,
        "final_attempt": _shared_truthy(audit_fields.get("final_attempt")),
        "status": _approval_label(row.get("status")),
        "raw_status": _request_status_value(row.get("status")),
        "admin_decision_at": row.get("admin_decision_at") or "",
        "admin_decision_by": row.get("admin_decision_by") or "",
        "denial_reason": row.get("denial_reason") or "",
        "target_scope": "single_session",
        "session_status": row.get("session_status") or "",
        "form_fill_status": audit_fields.get("form_fill_status") or FORM_FILL_NOT_ATTEMPTED,
        "completed_at": row.get("completed_at") or "",
        "deletion_scope": "Session History and Candidate Tracking",
    }


CORRECTION_REQUEST_TYPE = "candidate_information_correction"
ADMIN_CANDIDATE_EDIT_ACTION = "edit_candidate_information"
ADMIN_CANDIDATE_EDIT_AUDIT_TYPE = "candidate_information_admin_edit"
CORRECTION_ALLOWED_FIELDS = {
    "candidate_name": "Candidate Name",
    "headset_brand": "Headset Brand",
    "headset_model": "Headset Model",
}

CANDIDATE_UPDATE_ERROR_MESSAGES = {
    "candidate_update_no_changes": "No candidate information was changed.",
    "candidate_update_target_not_found": "The candidate session could not be found.",
    "candidate_update_identity_mismatch": "The candidate record no longer matches this session.",
    "candidate_update_unauthorized": "SAM is not authorized to update this candidate.",
    "candidate_update_action_unavailable": "The deployed Google service does not support this update yet.",
    "candidate_update_transport_failed": "The Google service is temporarily unavailable.",
    "candidate_update_response_invalid": "The update response was invalid.",
    "candidate_update_audit_failed": "The candidate was updated, but the audit record could not be saved.",
    "candidate_update_failed": "The candidate information could not be updated.",
}


def _candidate_update_failure(error_code, **extra):
    code = error_code if error_code in CANDIDATE_UPDATE_ERROR_MESSAGES else "candidate_update_failed"
    return {"ok": False, "error_code": code, "error": CANDIDATE_UPDATE_ERROR_MESSAGES[code], **extra}


def _candidate_update_error_code(value):
    text = str(value or "").strip().lower()
    if "no changes" in text or "has no changes" in text:
        return "candidate_update_no_changes"
    if "target was not found" in text or "session_id is required" in text or "session could not be found" in text:
        return "candidate_update_target_not_found"
    if "identity has changed" in text or "identity mismatch" in text or "no longer matches" in text:
        return "candidate_update_identity_mismatch"
    if "forbidden" in text or "unauthorized" in text or "not authorized" in text:
        return "candidate_update_unauthorized"
    if "unknown action" in text or "unsupported candidate operation" in text or "does not support" in text:
        return "candidate_update_action_unavailable"
    if "invalid response" in text:
        return "candidate_update_response_invalid"
    if "audit" in text:
        return "candidate_update_audit_failed"
    if any(token in text for token in ("timeout", "temporarily", "unavailable", "request failed", "connection")):
        return "candidate_update_transport_failed"
    return "candidate_update_failed"


def _normalize_correction_changes(value, require_changes=True):
    if isinstance(value, str):
        try:
            value = json.loads(value or "[]")
        except (TypeError, ValueError, json.JSONDecodeError):
            raise ValueError("correction_validation_failed")
    if not isinstance(value, list):
        raise ValueError("correction_validation_failed")
    normalized = []
    seen = set()
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("correction_validation_failed")
        field = str(item.get("field") or item.get("field_key") or "").strip().lower()
        if field not in CORRECTION_ALLOWED_FIELDS:
            raise ValueError("correction_unsupported_field")
        if field in seen:
            raise ValueError("correction_validation_failed")
        previous = str(item.get("previous_value") or "").strip()
        requested = str(item.get("requested_value") or "").strip()
        if not requested:
            raise ValueError("correction_validation_failed")
        if previous == requested:
            continue
        seen.add(field)
        normalized.append({
            "field": field,
            "field_key": field,
            "label": CORRECTION_ALLOWED_FIELDS[field],
            "previous_value": previous,
            "requested_value": requested,
        })
    if require_changes and not normalized:
        raise ValueError("correction_no_changes")
    return normalized


def _public_correction_request(row):
    try:
        changes = _normalize_correction_changes(row.get("changes_json") or row.get("changes") or [], require_changes=False)
    except ValueError:
        changes = []
    return {
        "id": row.get("request_id") or "",
        "request_id": row.get("request_id") or "",
        "session_id": row.get("source_session_id") or row.get("session_id") or "",
        "candidate_id": row.get("candidate_id") or "",
        "category": "candidate_correction",
        "categoryLabel": "Candidate Information Correction",
        "request_type": CORRECTION_REQUEST_TYPE,
        "candidate": row.get("candidate_name") or row.get("candidate") or "",
        "tester": row.get("tester_name") or row.get("tester") or "",
        "requester": row.get("tester_name") or row.get("tester") or "Tester",
        "reason": row.get("reason") or "",
        "changes": changes,
        "created_at": row.get("created_at") or row.get("submitted_at") or "",
        "submitted_at": row.get("submitted_at") or row.get("created_at") or "",
        "status": _approval_label(row.get("status")),
        "raw_status": _request_status_value(row.get("status")),
        "admin_decision_at": row.get("admin_decision_at") or row.get("decision_at") or "",
        "admin_decision_by": row.get("admin_decision_by") or row.get("decision_by") or "",
        "denial_reason": row.get("denial_reason") or "",
        "warning": row.get("warning") or "",
    }


def _request_category_counts(requests, headset_pending_count=0):
    pending = [item for item in requests if item.get("raw_status") == "pending"]
    workflow_count = len(pending)
    return {
        "newbieInitial": sum(1 for item in pending if item.get("category") == "newbie_initial"),
        "reschedules": sum(1 for item in pending if item.get("category") == "newbie_reschedule"),
        "candidateDeletions": sum(1 for item in pending if item.get("category") == "candidate_deletion"),
        "candidateCorrections": sum(1 for item in pending if item.get("category") == "candidate_correction"),
        "headsetReviews": headset_pending_count,
        "workflowRequests": workflow_count,
        "actionableTotal": workflow_count + headset_pending_count,
        "unresolved": workflow_count + headset_pending_count,
    }


def _candidate_terminal_for_newbie_shift(row):
    status = str(row.get("latest_status") or row.get("final_status") or row.get("status") or "").strip().lower()
    status = re.sub(r"[\u2013\u2014_-]+", " ", status)
    status = re.sub(r"\s+", " ", status).strip()
    if status in {
        "pass", "resumed pass", "fail final attempt", "failed final attempt",
        "withdrawn", "withdrew from certification", "removed", "deleted", "archived",
    }:
        return True
    if _shared_truthy(row.get("final_attempt")) and status in {"fail", "failed"}:
        return True
    return any(
        str(row.get(key) or "").strip().lower() == "pass"
        for key in ("sup_transfer_1_result", "sup_transfer_2_result")
    )


def _filter_obsolete_pending_newbie_requests(requests, candidate_tracking):
    candidates = (candidate_tracking or {}).get("candidates") or []
    by_session = {
        str(row.get("session_id") or "").strip(): row
        for row in candidates
        if str(row.get("session_id") or "").strip()
    }
    filtered = []
    for request in requests or []:
        candidate = by_session.get(str(request.get("session_id") or "").strip())
        is_pending_newbie = (
            request.get("category") in {"newbie_initial", "newbie_reschedule"}
            and request.get("raw_status") == "pending"
        )
        if is_pending_newbie and candidate and _candidate_terminal_for_newbie_shift(candidate):
            continue
        filtered.append(request)
    return filtered


REMOTE_NEWBIE_REQUEST_CACHE_TTL_SECONDS = 15
REMOTE_NEWBIE_REQUEST_BACKOFF_SECONDS = 30
_remote_newbie_request_cache_lock = threading.Lock()
_remote_newbie_request_cache = {
    "requests": [],
    "last_success": 0.0,
    "last_failure": 0.0,
    "in_flight": False,
}


def _canonical_remote_newbie_request(row):
    row = dict(row or {})
    source_tab = str(row.get("source_tab") or "").strip().lower()
    request_type_raw = str(row.get("request_type") or row.get("newbie_shift_request_type") or "").strip().lower()
    if source_tab == SHARED_CANDIDATE_DELETION_REQUESTS_TAB.lower() or request_type_raw == "candidate_deletion":
        return None
    request_type = (
        NEWBIE_REQUEST_RESCHEDULE
        if request_type_raw in {NEWBIE_REQUEST_RESCHEDULE, "newbie_shift_reschedule"}
        else NEWBIE_REQUEST_INITIAL
    )
    status = _normalize_newbie_request_status(
        row.get("request_status") or row.get("status") or row.get("raw_status")
    )
    return {
        "request_id": str(row.get("request_id") or row.get("newbie_shift_request_id") or "").strip(),
        "source_session_id": str(
            row.get("source_session_id") or row.get("session_id") or row.get("history_id") or ""
        ).strip(),
        "request_type": request_type,
        "status": status,
        "requested_by": str(row.get("requested_by") or row.get("requester") or "").strip(),
        "request_reason": str(row.get("request_reason") or row.get("reason") or "").strip(),
        "request_details": str(row.get("request_details") or row.get("details") or "").strip(),
        "request_created_at": str(row.get("request_created_at") or row.get("created_at") or "").strip(),
        "original_scheduled_at": str(
            row.get("original_scheduled_at")
            or row.get("original_schedule")
            or row.get("newbie_shift_original_scheduled_at")
            or ""
        ).strip(),
        "requested_scheduled_at": str(
            row.get("requested_scheduled_at") or row.get("scheduled_at") or row.get("rescheduled_at") or ""
        ).strip(),
        "rescheduled_at": str(row.get("rescheduled_at") or row.get("requested_scheduled_at") or "").strip(),
        "timezone": str(row.get("timezone") or "").strip(),
        "newbie_shift_number": str(row.get("newbie_shift_number") or "").strip(),
        "within_24_hours": row.get("within_24_hours"),
        "counts_as_attempt": row.get("counts_as_attempt"),
        "final_attempt": row.get("final_attempt"),
        "lead_time_seconds": row.get("lead_time_seconds"),
        "lead_time_category": str(row.get("lead_time_category") or "").strip(),
        "current_attempt": row.get("current_attempt"),
        "resulting_attempt": row.get("resulting_attempt"),
        "becomes_final_attempt": row.get("becomes_final_attempt"),
        "attempt_rule": str(row.get("attempt_rule") or "").strip(),
        "terminal_outcome": str(row.get("terminal_outcome") or "").strip(),
        "decision_at": str(
            row.get("decision_at") or row.get("admin_decision_at") or row.get("newbie_shift_admin_decision_at") or ""
        ).strip(),
        "decision_by": str(
            row.get("decision_by") or row.get("admin_decision_by") or row.get("newbie_shift_admin_decision_by") or ""
        ).strip(),
        "denial_reason": str(row.get("denial_reason") or row.get("newbie_shift_denial_reason") or "").strip(),
        "updated_at": str(row.get("updated_at") or "").strip(),
    }


def _candidate_row_remote_newbie_request(row):
    row = dict(row or {})
    return _canonical_remote_newbie_request({
        "request_id": row.get("newbie_shift_request_id"),
        "source_session_id": row.get("session_id"),
        "request_type": row.get("newbie_shift_request_type"),
        "status": row.get("newbie_shift_request_status"),
        "requested_by": row.get("newbie_shift_requested_by"),
        "request_reason": row.get("newbie_shift_request_reason"),
        "request_details": row.get("newbie_shift_request_details"),
        "request_created_at": row.get("newbie_shift_request_created_at"),
        "original_scheduled_at": row.get("newbie_shift_original_scheduled_at"),
        "requested_scheduled_at": row.get("newbie_shift_scheduled_at") or row.get("newbie_shift_rescheduled_at"),
        "rescheduled_at": row.get("newbie_shift_rescheduled_at"),
        "timezone": row.get("newbie_shift_timezone"),
        "newbie_shift_number": row.get("newbie_shift_number"),
        "within_24_hours": row.get("newbie_shift_within_24_hours"),
        "counts_as_attempt": row.get("newbie_shift_counts_as_attempt"),
        "final_attempt": row.get("final_attempt"),
        "lead_time_seconds": row.get("newbie_shift_lead_time_seconds"),
        "lead_time_category": row.get("newbie_shift_lead_time_category"),
        "current_attempt": row.get("newbie_shift_current_attempt"),
        "resulting_attempt": row.get("newbie_shift_resulting_attempt"),
        "becomes_final_attempt": row.get("newbie_shift_becomes_final_attempt"),
        "attempt_rule": row.get("newbie_shift_attempt_rule"),
        "terminal_outcome": row.get("newbie_shift_terminal_outcome"),
        "decision_at": row.get("newbie_shift_admin_decision_at"),
        "decision_by": row.get("newbie_shift_admin_decision_by"),
        "denial_reason": row.get("newbie_shift_denial_reason"),
    })


def _fetch_remote_newbie_requests():
    if configured_provider_mode() == "supabase":
        provider = _get_active_data_provider()
        raw_rows = provider.list_resource("pending_requests", limit=5000)
    else:
        context = _shared_sheet_context()
        if not context.get("ok"):
            raise RuntimeError("shared_request_context_unavailable")
        if context.get("appsScriptClient"):
            result = context["appsScriptClient"].get("getPendingRequests", {"include_resolved": "true"})
            raw_rows = result.get("requests") if isinstance(result, dict) else []
        else:
            raw_rows = _shared_read_rows(
                context["service"].spreadsheets(),
                context["sheet_id"],
                SHARED_NEWBIE_SHIFT_REQUESTS_TAB,
                SHARED_NEWBIE_SHIFT_REQUEST_HEADERS,
            )
    requests = []
    for row in raw_rows or []:
        if not isinstance(row, dict):
            continue
        normalized = _canonical_remote_newbie_request(row)
        if normalized and (normalized.get("request_id") or normalized.get("source_session_id")):
            requests.append(normalized)
    requests.sort(
        key=lambda item: str(
            item.get("decision_at") or item.get("updated_at") or item.get("request_created_at") or ""
        ),
        reverse=True,
    )
    return requests


def _remote_newbie_request_snapshot(force=False):
    now = time.monotonic()
    with _remote_newbie_request_cache_lock:
        cached_requests = SQLiteCollection.clone(_remote_newbie_request_cache.get("requests") or [])
        last_success = float(_remote_newbie_request_cache.get("last_success") or 0.0)
        last_failure = float(_remote_newbie_request_cache.get("last_failure") or 0.0)
        if not force and last_success and (now - last_success) < REMOTE_NEWBIE_REQUEST_CACHE_TTL_SECONDS:
            return {"ok": True, "requests": cached_requests, "source": "cache"}
        if not force and last_failure and (now - last_failure) < REMOTE_NEWBIE_REQUEST_BACKOFF_SECONDS:
            return {"ok": False, "requests": [], "source": "backoff"}
        if _remote_newbie_request_cache.get("in_flight"):
            return {"ok": False, "requests": [], "source": "in_flight"}
        _remote_newbie_request_cache["in_flight"] = True

    try:
        requests = _fetch_remote_newbie_requests()
    except Exception as exc:
        with _remote_newbie_request_cache_lock:
            _remote_newbie_request_cache["last_failure"] = time.monotonic()
            _remote_newbie_request_cache["in_flight"] = False
        logger.warning(
            "[REQUEST RECONCILIATION] Remote request refresh unavailable error_type=%s; local state preserved",
            type(exc).__name__,
        )
        return {"ok": False, "requests": [], "source": "remote"}

    with _remote_newbie_request_cache_lock:
        _remote_newbie_request_cache["requests"] = SQLiteCollection.clone(requests)
        _remote_newbie_request_cache["last_success"] = time.monotonic()
        _remote_newbie_request_cache["last_failure"] = 0.0
        _remote_newbie_request_cache["in_flight"] = False
    return {"ok": True, "requests": requests, "source": "remote"}


def _parse_request_decision_timestamp(value):
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _local_request_session_ids(record):
    return {
        str(value).strip()
        for value in (
            (record or {}).get("history_id"),
            (record or {}).get("session_id"),
            (record or {}).get("resume_source_history_id"),
        )
        if str(value or "").strip()
    }


def _remote_request_matches_local_record(record, remote):
    local_request_id = str((record or {}).get("newbie_shift_request_id") or "").strip()
    remote_request_id = str((remote or {}).get("request_id") or "").strip()
    local_session_ids = _local_request_session_ids(record)
    remote_session_id = str((remote or {}).get("source_session_id") or "").strip()

    if local_request_id:
        if not remote_request_id or local_request_id != remote_request_id:
            return False, "request_id_mismatch"
        if remote_session_id and local_session_ids and remote_session_id not in local_session_ids:
            return False, "source_session_conflict"
        return True, "request_id"

    if remote_session_id and local_session_ids and remote_session_id in local_session_ids:
        return True, "source_session_id"
    return False, "missing_or_mismatched_identifiers"


def _reconcile_local_newbie_request_record(record, remote):
    local = SQLiteCollection.clone(record or {})
    remote = _canonical_remote_newbie_request(remote) or {}
    matches, match_reason = _remote_request_matches_local_record(local, remote)
    if not matches:
        return local, False, match_reason

    remote_status = _normalize_newbie_request_status(remote.get("status"))
    local_status = _normalize_newbie_request_status(local.get("newbie_shift_request_status"))
    if remote_status == NEWBIE_REQUEST_PENDING:
        return local, False, "remote_pending"

    local_decision_at = _parse_request_decision_timestamp(local.get("newbie_shift_admin_decision_at"))
    remote_decision_at = _parse_request_decision_timestamp(remote.get("decision_at"))
    same_resolved_status = local_status == remote_status and local_status in {"approved", "denied"}
    if local_status in {"approved", "denied"} and local_status != remote_status:
        if not local_decision_at or not remote_decision_at or remote_decision_at <= local_decision_at:
            return local, False, "resolved_timestamp_not_newer"
    elif same_resolved_status and local_decision_at and remote_decision_at and remote_decision_at < local_decision_at:
        return local, False, "resolved_timestamp_older"

    overwrite_metadata = (
        local_status == NEWBIE_REQUEST_PENDING
        or (remote_decision_at and local_decision_at and remote_decision_at >= local_decision_at)
        or (same_resolved_status and remote_decision_at and not local_decision_at)
    )
    updates = {
        "newbie_shift_request_id": remote.get("request_id") or local.get("newbie_shift_request_id") or "",
        "newbie_shift_request_status": remote_status,
    }
    string_fields = {
        "newbie_shift_request_type": "request_type",
        "newbie_shift_requested_by": "requested_by",
        "newbie_shift_request_reason": "request_reason",
        "newbie_shift_request_details": "request_details",
        "newbie_shift_request_created_at": "request_created_at",
        "newbie_shift_original_scheduled_at": "original_scheduled_at",
        "newbie_shift_rescheduled_at": "rescheduled_at",
        "newbie_shift_scheduled_at": "requested_scheduled_at",
        "newbie_shift_timezone": "timezone",
        "newbie_shift_admin_decision_at": "decision_at",
        "newbie_shift_admin_decision_by": "decision_by",
        "newbie_shift_request_updated_at": "updated_at",
    }
    for local_key, remote_key in string_fields.items():
        remote_value = str(remote.get(remote_key) or "").strip()
        if not remote_value:
            continue
        if overwrite_metadata or not str(local.get(local_key) or "").strip():
            updates[local_key] = remote_value
    if overwrite_metadata and "newbie_shift_number" in remote:
        updates["newbie_shift_number"] = str(remote.get("newbie_shift_number") or "").strip()
    for local_key, remote_key in (
        ("newbie_shift_within_24_hours", "within_24_hours"),
        ("newbie_shift_counts_as_attempt", "counts_as_attempt"),
        ("newbie_shift_becomes_final_attempt", "becomes_final_attempt"),
    ):
        remote_value = remote.get(remote_key)
        if remote_value not in (None, "") and (overwrite_metadata or local_key not in local):
            updates[local_key] = _shared_truthy(remote_value)
    if remote.get("final_attempt") not in (None, "") and overwrite_metadata:
        updates["final_attempt"] = _shared_truthy(remote.get("final_attempt"))
    for local_key, remote_key in (
        ("newbie_shift_lead_time_seconds", "lead_time_seconds"),
        ("newbie_shift_current_attempt", "current_attempt"),
        ("newbie_shift_resulting_attempt", "resulting_attempt"),
    ):
        remote_value = remote.get(remote_key)
        if remote_value in (None, ""):
            continue
        try:
            normalized_value = int(float(remote_value))
        except (TypeError, ValueError):
            continue
        if overwrite_metadata or local_key not in local:
            updates[local_key] = normalized_value
    for local_key, remote_key in (
        ("newbie_shift_lead_time_category", "lead_time_category"),
        ("newbie_shift_attempt_rule", "attempt_rule"),
        ("newbie_shift_terminal_outcome", "terminal_outcome"),
    ):
        remote_value = str(remote.get(remote_key) or "").strip()
        if remote_value and (overwrite_metadata or not str(local.get(local_key) or "").strip()):
            updates[local_key] = remote_value

    if remote_status == "denied":
        remote_reason = str(remote.get("denial_reason") or "").strip()
        if remote_reason and (overwrite_metadata or not str(local.get("newbie_shift_denial_reason") or "").strip()):
            updates["newbie_shift_denial_reason"] = remote_reason
    elif overwrite_metadata or local_status != "approved":
        updates["newbie_shift_denial_reason"] = ""

    changed = any(local.get(key) != value for key, value in updates.items())
    if changed:
        local.update(updates)
    return local, changed, match_reason


def _reconcile_record_with_remote_requests(record, requests):
    reconciled = SQLiteCollection.clone(record or {})
    changed = False
    match_reason = "no_match"
    for remote in requests or []:
        next_record, item_changed, item_reason = _reconcile_local_newbie_request_record(reconciled, remote)
        if item_changed:
            reconciled = next_record
            changed = True
            match_reason = item_reason
            break
        if item_reason in {"remote_pending", "resolved_timestamp_not_newer", "resolved_timestamp_older"}:
            match_reason = item_reason
            break
    return reconciled, changed, match_reason


def _reconcile_candidate_tracking_with_requests(candidate_tracking, pending_requests):
    if not isinstance(candidate_tracking, dict) or not candidate_tracking.get("ok"):
        return candidate_tracking
    if not isinstance(pending_requests, dict) or not pending_requests.get("ok"):
        return candidate_tracking

    remote_requests = []
    for request in pending_requests.get("requests") or []:
        normalized = _canonical_remote_newbie_request(request)
        if normalized and (normalized.get("request_id") or normalized.get("source_session_id")):
            remote_requests.append(normalized)
    if not remote_requests:
        return candidate_tracking

    seen = set()

    def reconcile_rows(rows):
        for index, row in enumerate(rows or []):
            if not isinstance(row, dict) or id(row) in seen:
                continue
            seen.add(id(row))
            reconciled, changed, _reason = _reconcile_record_with_remote_requests(row, remote_requests)
            if changed:
                row.clear()
                row.update(reconciled)
            for attempt in row.get("attempts") or []:
                if not isinstance(attempt, dict) or id(attempt) in seen:
                    continue
                seen.add(id(attempt))
                next_attempt, attempt_changed, _attempt_reason = _reconcile_record_with_remote_requests(
                    attempt,
                    remote_requests,
                )
                if attempt_changed:
                    attempt.clear()
                    attempt.update(next_attempt)

    reconcile_rows(candidate_tracking.get("candidates"))
    for rows in (candidate_tracking.get("views") or {}).values():
        reconcile_rows(rows)
    return candidate_tracking


def _reconcile_remote_newbie_requests_into_local_state(force=False):
    snapshot = _remote_newbie_request_snapshot(force=force)
    if not snapshot.get("ok"):
        return {
            "ok": False,
            "historyUpdated": 0,
            "activeSessionUpdated": False,
            "source": snapshot.get("source"),
            "error_code": "newbie_shift_history_entry_unavailable",
        }

    requests = snapshot.get("requests") or []
    history_updated = 0
    missing_identifier_records = 0
    rows = db.history.store.fetchall("SELECT id, data FROM history_documents ORDER BY id DESC", ())
    for row in rows:
        existing = SQLiteCollection.decode(row["data"])
        if not str(existing.get("newbie_shift_request_id") or "").strip() and not _local_request_session_ids(existing):
            if existing.get("newbie_shift_data") or existing.get("newbie_shift_request_status"):
                missing_identifier_records += 1
            continue
        reconciled, changed, _reason = _reconcile_record_with_remote_requests(existing, requests)
        if not changed:
            continue
        db.history.store.execute(
            "UPDATE history_documents SET data = ?, timestamp = ? WHERE id = ?",
            (
                SQLiteCollection.encode(reconciled),
                str(reconciled.get("timestamp_iso") or reconciled.get("timestamp") or ""),
                row["id"],
            ),
        )
        history_updated += 1

    active_updated = False
    active = db.sessions._read_document("active_session")
    if active:
        reconciled, changed, _reason = _reconcile_record_with_remote_requests(active, requests)
        if changed:
            reconciled["_id"] = "active_session"
            db.sessions._write_document(reconciled)
            active_updated = True

    if missing_identifier_records:
        logger.info(
            "[REQUEST RECONCILIATION] Skipped local request records without stable identifiers count=%d",
            missing_identifier_records,
        )
    if history_updated or active_updated:
        logger.info(
            "[REQUEST RECONCILIATION] Applied targeted local updates history=%d active_session=%s",
            history_updated,
            active_updated,
        )
    return {
        "ok": True,
        "historyUpdated": history_updated,
        "activeSessionUpdated": active_updated,
        "source": snapshot.get("source"),
    }


def _safe_history_reconciliation(reconcile, error_code, *args, **kwargs):
    try:
        return reconcile(*args, **kwargs)
    except Exception as exc:
        logger.warning(
            "[HISTORY RECONCILIATION] Optional refresh unavailable source=%s error_type=%s; local History preserved",
            error_code,
            type(exc).__name__,
        )
        return {"ok": False, "historyUpdated": 0, "error_code": error_code}


def _fetch_remote_correction_requests():
    if configured_provider_mode() == "supabase":
        provider = _get_active_data_provider()
        raw_rows = provider.list_resource("pending_requests", limit=5000)
        requests = []
        for row in raw_rows or []:
            if not isinstance(row, dict):
                continue
            payload = dict(row.get("source_payload") or {})
            for k, v in row.items():
                if k != "source_payload" and k not in payload:
                    payload[k] = v
            cat = str(payload.get("category") or "").strip().lower()
            rtype = str(payload.get("request_type") or "").strip().lower()
            source_tab = str(payload.get("source_tab") or "")
            if source_tab == SHARED_CANDIDATE_CORRECTION_REQUESTS_TAB or "correction" in cat or rtype == CORRECTION_REQUEST_TYPE:
                requests.append(_public_correction_request(payload))
        return requests

    context = _shared_sheet_context()
    if not context.get("ok"):
        raise RuntimeError("correction_transport_unavailable")
    if context.get("appsScriptClient"):
        result = context["appsScriptClient"].get("getPendingRequests", {
            "include_resolved": "true", "request_type": CORRECTION_REQUEST_TYPE,
        })
        rows = result.get("requests") if isinstance(result, dict) else []
    else:
        rows = _shared_read_rows(
            context["service"].spreadsheets(), context["sheet_id"],
            SHARED_CANDIDATE_CORRECTION_REQUESTS_TAB, SHARED_CANDIDATE_CORRECTION_REQUEST_HEADERS,
        )
    return [_public_correction_request(row) for row in (rows or []) if isinstance(row, dict)]


def _reconcile_remote_corrections_into_local_history():
    try:
        requests = _fetch_remote_correction_requests()
    except Exception as exc:
        logger.warning("[CORRECTION RECONCILIATION] Remote refresh unavailable error_type=%s", type(exc).__name__)
        return {"ok": False, "historyUpdated": 0, "error_code": "correction_transport_unavailable"}
    by_request = {str(item.get("request_id") or "").strip(): item for item in requests if item.get("request_id")}
    by_session = {}
    for item in requests:
        session_id = str(item.get("session_id") or "").strip()
        if session_id:
            by_session.setdefault(session_id, []).append(item)
    updated = 0
    rows = db.history.store.fetchall("SELECT id, data FROM history_documents ORDER BY id DESC", ())
    for row in rows:
        record = SQLiteCollection.decode(row["data"])
        request_id = str(record.get("candidate_correction_request_id") or "").strip()
        remote = by_request.get(request_id) if request_id else None
        if not remote:
            candidates = by_session.get(str(record.get("history_id") or record.get("session_id") or "").strip(), [])
            remote = candidates[0] if len(candidates) == 1 else None
        if not remote:
            continue
        status = str(remote.get("raw_status") or "pending").lower()
        if status == str(record.get("candidate_correction_status") or "").lower() and status == "pending":
            continue
        next_record = SQLiteCollection.clone(record)
        next_record.update({
            "candidate_correction_request_id": remote.get("request_id") or request_id,
            "candidate_correction_status": status,
            "candidate_correction_changes": remote.get("changes") or [],
            "candidate_correction_reason": remote.get("reason") or record.get("candidate_correction_reason") or "",
            "candidate_correction_decision_at": remote.get("admin_decision_at") or "",
            "candidate_correction_decision_by": remote.get("admin_decision_by") or "",
            "candidate_correction_denial_reason": remote.get("denial_reason") or "",
        })
        if status == "approved" and not record.get("candidate_correction_applied_at"):
            headset_changes = []
            for change in remote.get("changes") or []:
                if change.get("field") == "candidate_name":
                    next_record["candidate"] = change.get("requested_value")
                    next_record["candidate_name"] = change.get("requested_value")
                elif change.get("field") in {"headset_brand", "headset_model"}:
                    headset_changes.append(change)
            if headset_changes:
                headset = _apply_headset_correction_values(record, headset_changes)
                next_record["headset_brand"] = headset["brand"] if headset["separate"] else headset["label"]
                if headset["separate"]:
                    next_record["headset_model"] = headset["model"]
                next_record["headset_label"] = headset["label"]
            next_record["candidate_correction_applied_at"] = remote.get("admin_decision_at") or datetime.now(timezone.utc).isoformat()
        if status in {"approved", "denied"}:
            next_record["candidate_correction_pending"] = False
        if next_record == record:
            continue
        db.history.store.execute(
            "UPDATE history_documents SET data = ?, timestamp = ? WHERE id = ?",
            (SQLiteCollection.encode(next_record), str(next_record.get("timestamp_iso") or next_record.get("timestamp") or ""), row["id"]),
        )
        updated += 1
    return {"ok": True, "historyUpdated": updated}


def _fetch_remote_candidate_information():
    if configured_provider_mode() == "supabase":
        provider = _get_active_data_provider()
        sessions_raw = provider.list_resource("candidate_sessions", limit=5000)
        rows = []
        for s in sessions_raw or []:
            if not isinstance(s, dict):
                continue
            payload = dict(s.get("source_payload") or {})
            for k, v in s.items():
                if k != "source_payload" and k not in payload:
                    payload[k] = v
            rows.append(payload)
        return rows

    context = _shared_sheet_context()
    if not context.get("ok"):
        raise RuntimeError("candidate_information_transport_unavailable")
    if context.get("appsScriptClient"):
        result = context["appsScriptClient"].get("getCandidateTracking", {})
        rows = result.get("rows") if isinstance(result, dict) else []
    else:
        rows = _shared_read_rows(
            context["service"].spreadsheets(),
            context["sheet_id"],
            SHARED_CANDIDATE_SESSIONS_TAB,
            SHARED_CANDIDATE_SESSION_HEADERS,
        )
    return [row for row in (rows or []) if isinstance(row, dict)]


def _reconcile_authoritative_candidate_information(candidate_rows):
    """Merge only authoritative candidate fields into exact local session IDs."""
    by_session = {}
    duplicate_sessions = set()
    for candidate in candidate_rows or []:
        session_id = str(candidate.get("session_id") or candidate.get("source_session_id") or "").strip()
        if not session_id:
            continue
        if session_id in by_session:
            duplicate_sessions.add(session_id)
            continue
        by_session[session_id] = candidate
    for session_id in duplicate_sessions:
        by_session.pop(session_id, None)

    updated = 0
    rows = db.history.store.fetchall("SELECT id, data FROM history_documents ORDER BY id DESC", ())
    for row in rows:
        record = SQLiteCollection.decode(row["data"])
        session_ids = {
            str(value).strip()
            for value in (
                record.get("history_id"),
                record.get("session_id"),
                record.get("source_session_id"),
            )
            if str(value or "").strip()
        }
        matches = [by_session[session_id] for session_id in session_ids if session_id in by_session]
        if len(matches) != 1:
            continue
        authoritative = matches[0]
        local_candidate_id = str(record.get("candidate_id") or "").strip()
        remote_candidate_id = str(authoritative.get("candidate_id") or "").strip()
        if local_candidate_id and remote_candidate_id and local_candidate_id != remote_candidate_id:
            continue

        candidate_name = str(
            authoritative.get("candidate_name")
            or authoritative.get("CandidateName")
            or authoritative.get("Candidate Name")
            or ""
        ).strip()
        headset = _candidate_headset_values(authoritative)
        next_record = SQLiteCollection.clone(record)
        if candidate_name:
            next_record["candidate"] = candidate_name
            next_record["candidate_name"] = candidate_name
        if headset["label"]:
            next_record["headset_brand"] = headset["brand"] if headset["separate"] else headset["label"]
            if headset["separate"]:
                next_record["headset_model"] = headset["model"]
            else:
                next_record.pop("headset_model", None)
            next_record["headset_label"] = headset["label"]
        has_authoritative_status = any(
            field in authoritative
            for field in (
                "status", "latest_status", "final_result", "calculated_result",
                "readiness_override_applied", "readiness_override_result",
                "sup_transfer_1_result", "sup_transfer_2_result", "final_attempt",
            )
        )
        authoritative_status = _candidate_authoritative_status(authoritative) if has_authoritative_status else ""
        if authoritative_status:
            next_record["status"] = authoritative_status
            next_record["final_status"] = authoritative_status
        for field in (
            "calculated_result", "final_result", "readiness_override_applied",
            "readiness_override_result", "readiness_override_reason",
            "readiness_override_explanation", "readiness_override_by",
            "readiness_override_at", "newbie_shift_number",
            "extra_attempt_granted", "extra_attempts_granted",
            "allowed_attempt_count", "current_attempt_number", "attempt_number",
        ):
            if field in authoritative:
                next_record[field] = authoritative.get(field)
        if any(field in authoritative for field in (
            "attempt_number", "current_attempt_number", "allowed_attempt_count",
            "extra_attempt_granted", "extra_attempts_granted", "final_attempt",
        )):
            attempt_state = calculate_candidate_attempt_state([authoritative])
            next_record["attempt_state"] = attempt_state
            next_record["current_attempt_number"] = attempt_state["current_attempt"]
            next_record["allowed_attempt_count"] = attempt_state["max_attempts"]
            next_record["final_attempt"] = attempt_state["final_attempt"]
        if next_record == record:
            continue
        db.history.store.execute(
            "UPDATE history_documents SET data = ?, timestamp = ? WHERE id = ?",
            (
                SQLiteCollection.encode(next_record),
                str(next_record.get("timestamp_iso") or next_record.get("timestamp") or ""),
                row["id"],
            ),
        )
        updated += 1
    return {
        "ok": True,
        "historyUpdated": updated,
        "ambiguousSessionIds": len(duplicate_sessions),
    }


def _reconcile_remote_candidate_information_into_local_history():
    try:
        return _reconcile_authoritative_candidate_information(_fetch_remote_candidate_information())
    except Exception as exc:
        logger.warning(
            "[CANDIDATE INFO RECONCILIATION] Remote refresh unavailable error_type=%s",
            type(exc).__name__,
        )
        return {
            "ok": False,
            "historyUpdated": 0,
            "error_code": "candidate_information_transport_unavailable",
        }


def _shared_pending_request_snapshot(headset_snapshot=None, context=None, candidate_tracking=None):
    if configured_provider_mode() == "supabase":
        headset_snapshot = headset_snapshot or _headset_review_snapshot()
        candidate_tracking = candidate_tracking or _shared_admin_candidate_snapshot()
        headset_pending_count = len(headset_snapshot.get("pending") or []) if headset_snapshot.get("ok") else 0
        try:
            provider = _get_active_data_provider()
            raw_requests = provider.list_resource("pending_requests", limit=5000)
            requests = []
            for row in raw_requests or []:
                if not isinstance(row, dict):
                    continue
                payload = dict(row.get("source_payload") or {})
                for k, v in row.items():
                    if k != "source_payload" and k not in payload:
                        payload[k] = v
                cat = str(payload.get("category") or "").strip().lower()
                rtype = str(payload.get("request_type") or "").strip().lower()
                source_tab = str(payload.get("source_tab") or "")
                if source_tab == SHARED_CANDIDATE_CORRECTION_REQUESTS_TAB or "correction" in cat or rtype == CORRECTION_REQUEST_TYPE:
                    requests.append(_public_correction_request(payload))
                elif source_tab == SHARED_CANDIDATE_DELETION_REQUESTS_TAB or "deletion" in cat or "deletion" in rtype:
                    requests.append(_public_deletion_request(payload))
                else:
                    requests.append(_public_newbie_request(payload))
            requests = _filter_obsolete_pending_newbie_requests(requests, candidate_tracking)
            requests.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
            return {
                "ok": True,
                "requests": requests,
                "headsetReviews": (headset_snapshot or {}).get("pending") or [],
                "counts": _request_category_counts(requests, headset_pending_count),
                "targeting": {
                    "mode": "all_authorized_admins",
                    "message": "Per-admin request targeting is not available from the current SAM identity source; all authorized SAM administrators can see pending requests.",
                },
            }
        except Exception as exc:
            logger.exception("[REQUESTS] Pending request snapshot unavailable from Supabase: %s", exc)
            return {
                "ok": False,
                "error": _pending_requests_temporary_unavailable_message(),
                "requests": [],
                "headsetReviews": (headset_snapshot or {}).get("pending") or [],
                "counts": _request_category_counts([], headset_pending_count),
                "targeting": {
                    "mode": "all_authorized_admins",
                    "message": "Per-admin request targeting is not available from the current SAM identity source; all authorized SAM administrators can see pending requests.",
                },
            }

    context = context or _shared_sheet_context()
    headset_snapshot = headset_snapshot or _headset_review_snapshot(context)
    candidate_tracking = candidate_tracking or _shared_admin_candidate_snapshot(context)
    headset_pending_count = len(headset_snapshot.get("pending") or []) if headset_snapshot.get("ok") else 0
    if context.get("appsScriptClient"):
        try:
            result = context["appsScriptClient"].get("getPendingRequests", {"include_resolved": "true"})
            raw_requests = result.get("requests") if isinstance(result, dict) else []
            requests = []
            for row in raw_requests or []:
                if not isinstance(row, dict):
                    continue
                if row.get("source_tab") == SHARED_CANDIDATE_CORRECTION_REQUESTS_TAB or str(row.get("request_type") or "").lower() == CORRECTION_REQUEST_TYPE:
                    requests.append(_public_correction_request({
                        "request_id": row.get("request_id"), "source_session_id": row.get("source_session_id"),
                        "candidate_id": row.get("candidate_id"), "candidate_name": row.get("candidate"),
                        "tester_name": row.get("tester"), "reason": row.get("reason"),
                        "changes_json": row.get("changes_json") or row.get("changes"),
                        "created_at": row.get("created_at"), "status": row.get("status"),
                        "admin_decision_at": row.get("decision_at"), "admin_decision_by": row.get("decision_by"),
                        "denial_reason": row.get("denial_reason"), "warning": row.get("warning"),
                    }))
                elif row.get("source_tab") == SHARED_CANDIDATE_DELETION_REQUESTS_TAB:
                    requests.append(_public_deletion_request({
                        "request_id": row.get("request_id"), "session_id": row.get("source_session_id"),
                        "candidate_name": row.get("candidate"), "tester_name": row.get("tester"),
                        "created_at": row.get("created_at"), "status": row.get("status"),
                        "reason": row.get("reason"), "audit_summary": row.get("details"),
                        "admin_decision_at": row.get("decision_at"), "admin_decision_by": row.get("decision_by"),
                        "denial_reason": row.get("denial_reason"),
                    }))
                else:
                    request_type = NEWBIE_REQUEST_RESCHEDULE if str(row.get("request_type") or "").lower() in {"reschedule", "newbie_shift_reschedule"} else NEWBIE_REQUEST_INITIAL
                    requests.append(_public_newbie_request({
                        "request_id": row.get("request_id"), "session_id": row.get("source_session_id"),
                        "request_type": request_type, "request_status": row.get("status"),
                        "candidate_name": row.get("candidate"), "tester_name": row.get("tester"),
                        "requested_by": row.get("requester"), "request_reason": row.get("reason"),
                        "request_details": row.get("details"), "request_created_at": row.get("created_at"),
                        "original_scheduled_at": row.get("original_scheduled_at"),
                        "scheduled_at": row.get("requested_scheduled_at"), "timezone": row.get("timezone"),
                        "newbie_shift_number": row.get("newbie_shift_number"),
                        "within_24_hours": row.get("within_24_hours"), "counts_as_attempt": row.get("counts_as_attempt"),
                        "final_attempt": row.get("final_attempt"), "admin_decision_at": row.get("decision_at"),
                        "lead_time_seconds": row.get("lead_time_seconds"), "lead_time_category": row.get("lead_time_category"),
                        "current_attempt": row.get("current_attempt"), "resulting_attempt": row.get("resulting_attempt"),
                        "becomes_final_attempt": row.get("becomes_final_attempt"), "attempt_rule": row.get("attempt_rule"),
                        "terminal_outcome": row.get("terminal_outcome"),
                        "admin_decision_by": row.get("decision_by"), "denial_reason": row.get("denial_reason"),
                    }))
            requests = _filter_obsolete_pending_newbie_requests(requests, candidate_tracking)
            return {
                "ok": True, "requests": requests, "headsetReviews": headset_snapshot.get("pending") or [],
                "counts": _request_category_counts(requests, headset_pending_count), "warning": "", "error_code": "", "message": "",
                "targeting": {"mode": "all_authorized_admins", "message": "Per-admin request targeting is not available from the current SAM identity source; all authorized SAM administrators can see pending requests."},
                "transport": "apps_script",
            }
        except Exception as exc:
            logger.warning("[REQUESTS] Apps Script pending request listing failed: %s", exc)
            return {
                "ok": False, "error": _pending_requests_temporary_unavailable_message(), "error_code": "apps_script_pending_requests_unavailable", "message": "",
                "requests": [], "headsetReviews": headset_snapshot.get("pending") or [], "counts": _request_category_counts([], headset_pending_count), "transport": "apps_script",
            }
    if not context.get("ok"):
        return {
            "ok": False,
            "error": _pending_requests_temporary_unavailable_message(),
            "requests": [],
            "headsetReviews": headset_snapshot.get("pending") or [],
            "counts": _request_category_counts([], headset_pending_count),
            "targeting": {
                "mode": "all_authorized_admins",
                "message": "Per-admin request targeting is not available from the current SAM identity source; all authorized SAM administrators can see pending requests.",
            },
        }
    try:
        sheets_api = context["service"].spreadsheets()
        sheet_id = context["sheet_id"]
        newbie_rows = _shared_read_rows(sheets_api, sheet_id, SHARED_NEWBIE_SHIFT_REQUESTS_TAB, SHARED_NEWBIE_SHIFT_REQUEST_HEADERS)
        deletion_rows = _shared_read_rows(sheets_api, sheet_id, SHARED_CANDIDATE_DELETION_REQUESTS_TAB, SHARED_CANDIDATE_DELETION_REQUEST_HEADERS)
        correction_rows = _shared_read_rows(sheets_api, sheet_id, SHARED_CANDIDATE_CORRECTION_REQUESTS_TAB, SHARED_CANDIDATE_CORRECTION_REQUEST_HEADERS)
        requests = ([_public_newbie_request(row) for row in newbie_rows]
                    + [_public_deletion_request(row) for row in deletion_rows]
                    + [
                        _public_correction_request(row)
                        for row in correction_rows
                        if str(row.get("request_type") or CORRECTION_REQUEST_TYPE).strip().lower() == CORRECTION_REQUEST_TYPE
                    ])
        requests = _filter_obsolete_pending_newbie_requests(requests, candidate_tracking)
        requests.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
        return {
            "ok": True,
            "requests": requests,
            "headsetReviews": headset_snapshot.get("pending") or [],
            "counts": _request_category_counts(requests, headset_pending_count),
            "targeting": {
                "mode": "all_authorized_admins",
                "message": "Per-admin request targeting is not available from the current SAM identity source; all authorized SAM administrators can see pending requests.",
            },
        }
    except Exception as exc:
        logger.warning("[REQUESTS] Pending request snapshot unavailable: %s", exc)
        return {
            "ok": False,
            "error": _pending_requests_temporary_unavailable_message(),
            "requests": [],
            "headsetReviews": headset_snapshot.get("pending") or [],
            "counts": _request_category_counts([], headset_pending_count),
            "targeting": {
                "mode": "all_authorized_admins",
                "message": "Per-admin request targeting is not available from the current SAM identity source; all authorized SAM administrators can see pending requests.",
            },
        }


def _shared_admin_snapshot():
    if configured_provider_mode() == "supabase":
        headset_reviews = _headset_review_snapshot()
        candidate_tracking = _shared_admin_candidate_snapshot()
        pending_requests = _shared_pending_request_snapshot(headset_reviews, None, candidate_tracking)
        candidate_tracking = _reconcile_candidate_tracking_with_requests(candidate_tracking, pending_requests)
        return {
            "ok": all(section.get("ok") for section in (headset_reviews, pending_requests, candidate_tracking)),
            "candidateTracking": candidate_tracking,
            "pendingRequests": pending_requests,
            "headsetReviews": headset_reviews,
            "refreshedAt": datetime.now(timezone.utc).isoformat(),
        }

    context = _shared_sheet_context()
    headset_reviews = _headset_review_snapshot(context)
    candidate_tracking = _shared_admin_candidate_snapshot(context)
    pending_requests = _shared_pending_request_snapshot(headset_reviews, context, candidate_tracking)
    candidate_tracking = _reconcile_candidate_tracking_with_requests(candidate_tracking, pending_requests)
    return {
        "ok": all(section.get("ok") for section in (headset_reviews, pending_requests, candidate_tracking)),
        "candidateTracking": candidate_tracking,
        "pendingRequests": pending_requests,
        "headsetReviews": headset_reviews,
        "refreshedAt": datetime.now(timezone.utc).isoformat(),
    }


def _set_row_value(row, key, value):
    if key in row:
        row[key] = value


def _find_request_row(rows, request_id):
    return next((row for row in rows if str(row.get("request_id") or "").strip() == str(request_id or "").strip()), None)


def _apply_candidate_correction_direct(sheets_api, sheet_id, source_session_id, changes, candidate_id=""):
    source_session_id = str(source_session_id or "").strip()
    if not source_session_id:
        return {"ok": False, "error_code": "correction_target_not_found", "updated": 0}
    rows = _shared_read_rows(sheets_api, sheet_id, SHARED_CANDIDATE_SESSIONS_TAB, SHARED_CANDIDATE_SESSION_HEADERS)
    target = next((row for row in rows if str(row.get("session_id") or "").strip() == source_session_id), None)
    if not target:
        return {"ok": False, "error_code": "correction_target_not_found", "updated": 0}
    candidate_id = str(candidate_id or "").strip()
    target_candidate_id = str(target.get("candidate_id") or "").strip()
    if candidate_id and target_candidate_id and candidate_id != target_candidate_id:
        return {"ok": False, "error_code": "correction_identity_mismatch", "updated": 0}
    normalized = _normalize_correction_changes(changes)
    applied = []
    name_changes = [change for change in normalized if change["field"] == "candidate_name"]
    headset_changes = [change for change in normalized if change["field"] in {"headset_brand", "headset_model"}]
    corrected_headset = None
    for change in name_changes:
        current = str(target.get("candidate_name") or "").strip()
        if current == change["requested_value"]:
            continue
        if change["previous_value"] and current != change["previous_value"]:
            return {"ok": False, "error_code": "correction_identity_mismatch", "updated": 0}
        target["candidate_name"] = change["requested_value"]
        applied.append(change)
    if headset_changes:
        try:
            headset = _apply_headset_correction_values(target, headset_changes)
            corrected_headset = headset
        except ValueError:
            return {"ok": False, "error_code": "correction_identity_mismatch", "updated": 0}
        current_label = _candidate_headset_values(target)["label"]
        if headset["label"] != current_label:
            target["headset_brand"] = headset["label"]
            applied.extend(headset_changes)
    if applied:
        _shared_update_existing_row(
            sheets_api, sheet_id, SHARED_CANDIDATE_SESSIONS_TAB, SHARED_CANDIDATE_SESSION_HEADERS,
            target["_row_number"], _shared_row_values(target, SHARED_CANDIDATE_SESSION_HEADERS),
        )
        if corrected_headset and corrected_headset.get("brand") and corrected_headset.get("model"):
            try:
                review_rows = _shared_read_rows(sheets_api, sheet_id, HEADSET_REVIEW_LOG_TAB, HEADSET_REVIEW_LOG_HEADERS)
            except Exception as exc:
                if "missing sheet" not in str(exc).lower():
                    raise
                review_rows = []
            for review in review_rows:
                if str(review.get("source_session_id") or "").strip() != source_session_id:
                    continue
                review["Brand"] = corrected_headset["brand"]
                review["Model"] = corrected_headset["model"]
                review["updated_at"] = datetime.now(timezone.utc).isoformat()
                _shared_update_existing_row(
                    sheets_api, sheet_id, HEADSET_REVIEW_LOG_TAB, HEADSET_REVIEW_LOG_HEADERS,
                    review["_row_number"], _shared_row_values(review, HEADSET_REVIEW_LOG_HEADERS),
                )
                break
        name_change = next((item for item in applied if item["field"] == "candidate_name"), None)
        if name_change:
            try:
                pending_rows = _shared_read_rows(sheets_api, sheet_id, SHARED_PENDING_SUP_TRANSFERS_TAB, SHARED_PENDING_SUP_TRANSFER_HEADERS)
            except Exception as exc:
                if "missing sheet" not in str(exc).lower():
                    raise
                pending_rows = []
            for pending in pending_rows:
                if str(pending.get("original_session_id") or "").strip() != source_session_id:
                    continue
                pending["candidate_name"] = name_change["requested_value"]
                _shared_update_existing_row(
                    sheets_api, sheet_id, SHARED_PENDING_SUP_TRANSFERS_TAB, SHARED_PENDING_SUP_TRANSFER_HEADERS,
                    pending["_row_number"], _shared_row_values(pending, SHARED_PENDING_SUP_TRANSFER_HEADERS),
                )
    return {"ok": True, "updated": len(applied), "already_applied": not applied, "changes": applied or normalized}


def _apply_candidate_deletion_terminal_direct(sheets_api, sheet_id, source_session_id, request_id):
    source_session_id = str(source_session_id or "").strip()
    if not source_session_id:
        return {"updated": 0, "pendingUpdated": 0, "already_applied": False}
    candidates = _shared_read_rows(sheets_api, sheet_id, SHARED_CANDIDATE_SESSIONS_TAB, SHARED_CANDIDATE_SESSION_HEADERS)
    updated = 0
    already_applied = False
    for row in candidates:
        if str(row.get("session_id") or "").strip() != source_session_id:
            continue
        already_applied = (_shared_truthy(row.get("archived")) and str(row.get("status") or "").strip().upper() in {"REMOVED", "DELETED"})
        if not already_applied:
            row.update({
                "archived": True, "status": "REMOVED", "needs_sup_transfer": False,
                "pending_sup_transfer_id": "", "newbie_shift_scheduled_at": "", "newbie_shift_timezone": "",
                "newbie_shift_request_status": "", "deletion_request_id": request_id,
                "deletion_request_status": "approved",
            })
            _shared_update_existing_row(
                sheets_api, sheet_id, SHARED_CANDIDATE_SESSIONS_TAB, SHARED_CANDIDATE_SESSION_HEADERS,
                row["_row_number"], _shared_row_values(row, SHARED_CANDIDATE_SESSION_HEADERS),
            )
            updated += 1
        break
    pending_updated = 0
    pending_rows = _shared_read_rows(sheets_api, sheet_id, SHARED_PENDING_SUP_TRANSFERS_TAB, SHARED_PENDING_SUP_TRANSFER_HEADERS)
    for row in pending_rows:
        if str(row.get("original_session_id") or "").strip() != source_session_id:
            continue
        if str(row.get("status") or "").strip().lower() in {"pending", "in progress", "in_progress"}:
            row["status"] = "cancelled"
            row["notes"] = "Obsolete after approved candidate deletion."
            _shared_update_existing_row(
                sheets_api, sheet_id, SHARED_PENDING_SUP_TRANSFERS_TAB, SHARED_PENDING_SUP_TRANSFER_HEADERS,
                row["_row_number"], _shared_row_values(row, SHARED_PENDING_SUP_TRANSFER_HEADERS),
            )
            pending_updated += 1
    obsolete_requests = 0
    for tab, headers, session_key, status_key in (
        (SHARED_NEWBIE_SHIFT_REQUESTS_TAB, SHARED_NEWBIE_SHIFT_REQUEST_HEADERS, "session_id", "request_status"),
        (SHARED_CANDIDATE_CORRECTION_REQUESTS_TAB, SHARED_CANDIDATE_CORRECTION_REQUEST_HEADERS, "source_session_id", "status"),
    ):
        for row in _shared_read_rows(sheets_api, sheet_id, tab, headers):
            if str(row.get(session_key) or "").strip() != source_session_id or _request_status_value(row.get(status_key)) != "pending":
                continue
            row[status_key] = "denied"
            row["admin_decision_at"] = datetime.now(timezone.utc).isoformat()
            row["admin_decision_by"] = "SAM deletion reconciliation"
            row["denial_reason"] = "Request became obsolete after approved candidate deletion."
            _shared_update_existing_row(sheets_api, sheet_id, tab, headers, row["_row_number"], _shared_row_values(row, headers))
            obsolete_requests += 1
    return {"updated": updated, "pendingUpdated": pending_updated, "obsoleteRequests": obsolete_requests, "already_applied": already_applied}


def _update_candidate_request_fields(sheets_api, sheet_id, session_id, request_id, status, actor, decided_at, denial_reason="", attempt_outcome=None, newbie_shift_number=None):
    if not session_id:
        return 0
    candidate_rows = _shared_read_rows(sheets_api, sheet_id, SHARED_CANDIDATE_SESSIONS_TAB, SHARED_CANDIDATE_SESSION_HEADERS)
    updated = 0
    for row in candidate_rows:
        if str(row.get("session_id") or "").strip() != str(session_id).strip():
            continue
        row["newbie_shift_request_id"] = request_id or row.get("newbie_shift_request_id") or ""
        row["newbie_shift_request_status"] = status
        row["newbie_shift_admin_decision_at"] = decided_at
        row["newbie_shift_admin_decision_by"] = actor
        row["newbie_shift_denial_reason"] = denial_reason
        if newbie_shift_number is not None:
            row["newbie_shift_number"] = _normalize_newbie_shift_number(newbie_shift_number)
        outcome = dict(attempt_outcome or {})
        resulting_attempt = _positive_attempt_number(outcome.get("resulting_attempt"), 0)
        if resulting_attempt > 0:
            row["attempt_number"] = resulting_attempt
        if outcome.get("final_attempt") not in (None, ""):
            row["final_attempt"] = _shared_truthy(outcome.get("final_attempt"))
        terminal_outcome = str(outcome.get("terminal_outcome") or "").strip()
        if terminal_outcome:
            row["status"] = terminal_outcome
            row["final_result"] = terminal_outcome
        _shared_update_existing_row(
            sheets_api,
            sheet_id,
            SHARED_CANDIDATE_SESSIONS_TAB,
            SHARED_CANDIDATE_SESSION_HEADERS,
            row["_row_number"],
            _shared_row_values(row, SHARED_CANDIDATE_SESSION_HEADERS),
        )
        updated += 1
    return updated


def _shared_pending_request_action(payload):
    request_id = str((payload or {}).get("request_id") or "").strip()
    category = str((payload or {}).get("category") or "").strip()
    decision_input = str((payload or {}).get("decision") or "").strip().lower()
    actor = str((payload or {}).get("actor") or (payload or {}).get("admin") or "SAM").strip() or "SAM"
    denial_reason = str((payload or {}).get("denial_reason") or "").strip()
    expected_status = str((payload or {}).get("expected_status") or "pending").strip().lower()
    newbie_shift_number = _normalize_newbie_shift_number((payload or {}).get("newbie_shift_number"))
    if decision_input in {"approve", "approved"}:
        decision_cmd = "approve"
        decision = "approved"
    elif decision_input in {"deny", "denied"}:
        decision_cmd = "deny"
        decision = "denied"
    else:
        return {"ok": False, "error": "Decision must be approved or denied."}
    if decision == "denied" and not denial_reason:
        return {"ok": False, "error": "A denial reason is required."}
    if not request_id:
        return {"ok": False, "error": "Request id is required."}

    context = _shared_sheet_context()
    if not context.get("ok"):
        return {"ok": False, "error": _candidate_tracking_temporary_unavailable_message(), "setup": _shared_tracking_required_setup()}
    if context.get("appsScriptClient"):
        from services.apps_script_api import AppsScriptApiError
        if category == "newbie_initial":
            request_type = "initial_newbie_shift"
        elif category == "newbie_reschedule":
            request_type = "newbie_shift_reschedule"
        elif category == "candidate_deletion":
            request_type = "candidate_deletion"
        elif category == "candidate_correction":
            request_type = CORRECTION_REQUEST_TYPE
        else:
            return {"ok": False, "error": "Unsupported request category."}

        apps_script_client = context["appsScriptClient"]
        decided_at = datetime.now(timezone.utc).isoformat()
        try:
            result = apps_script_client.post("decidePendingRequest", {
                "request_id": request_id,
                "request_type": request_type,
                "decision": decision_cmd,
                "expected_status": expected_status,
                "decision_by": actor,
                "denial_reason": denial_reason,
                "newbie_shift_number": newbie_shift_number,
            })
            if not isinstance(result, dict):
                result = {}

            response = {
                "ok": result.get("ok") if "ok" in result else True,
                "request_id": result.get("request_id") or request_id,
                "request_type": result.get("request_type") or request_type,
                "status": result.get("status") or result.get("request_status") or decision,
                "decision": result.get("decision") or decision_cmd,
                "decision_at": result.get("decision_at") or decided_at,
                "decision_by": result.get("decision_by") or actor,
                "denial_reason": result.get("denial_reason") or denial_reason,
            }
            for field in [
                "candidate_session_synced",
                "deletion_action_required",
                "candidate_session_updated",
                "applied_changes",
                "candidate_deletion_applied",
                "candidate_updates",
                "pending_updates",
                "warning",
                "error_code",
                "message",
            ]:
                if field in result:
                    response[field] = result[field]
            return response
        except AppsScriptApiError as exc:
            err_msg = str(exc)
            lowered = err_msg.lower()
            if "not found" in lowered or "missing" in lowered:
                friendly = "Request was not found."
            elif "status has changed" in lowered or "already resolved" in lowered or "already approved" in lowered or "already denied" in lowered or "status mismatch" in lowered or "expected-status" in lowered:
                friendly = "Request has already been resolved."
            elif "lock timeout" in lowered:
                friendly = "Temporary database lock conflict. Please try again in a moment."
            elif "invalid decision" in lowered:
                friendly = "Decision must be approved or denied."
            elif "denial reason" in lowered:
                friendly = "A denial reason is required."
            else:
                friendly = _candidate_tracking_temporary_unavailable_message()
            logger.warning("[REQUESTS] Apps Script pending request decision rejected: %s", exc)
            return {
                "ok": False,
                "error": friendly,
                "error_code": "apps_script_pending_request_error"
            }
        except Exception as exc:
            logger.exception("[REQUESTS] Apps Script pending request decision transport failed: %s", exc)
            return {
                "ok": False,
                "error": _candidate_tracking_temporary_unavailable_message(),
                "error_code": "apps_script_pending_request_transport_failed"
            }

    try:
        sheets_api = context["service"].spreadsheets()
        sheet_id = context["sheet_id"]
        decided_at = datetime.now(timezone.utc).isoformat()
        if category in {"newbie_initial", "newbie_reschedule"}:
            rows = _shared_read_rows(sheets_api, sheet_id, SHARED_NEWBIE_SHIFT_REQUESTS_TAB, SHARED_NEWBIE_SHIFT_REQUEST_HEADERS)
            row = _find_request_row(rows, request_id)
            if not row:
                return {"ok": False, "error": "Request was not found."}
            current_status = _request_status_value(row.get("request_status"))
            if current_status != expected_status:
                return {"ok": False, "error": f"Request has already been {_approval_label(current_status).lower()}."}
            row["request_status"] = decision
            row["admin_decision_at"] = decided_at
            row["admin_decision_by"] = actor
            row["denial_reason"] = denial_reason if decision == "denied" else ""
            if decision == "approved":
                row["newbie_shift_number"] = newbie_shift_number
            _shared_update_existing_row(
                sheets_api,
                sheet_id,
                SHARED_NEWBIE_SHIFT_REQUESTS_TAB,
                SHARED_NEWBIE_SHIFT_REQUEST_HEADERS,
                row["_row_number"],
                _shared_row_values(row, SHARED_NEWBIE_SHIFT_REQUEST_HEADERS),
            )
            candidate_updates = _update_candidate_request_fields(
                sheets_api,
                sheet_id,
                row.get("session_id") or "",
                request_id,
                decision,
                actor,
                decided_at,
                denial_reason if decision == "denied" else "",
                attempt_outcome=row,
                newbie_shift_number=newbie_shift_number if decision == "approved" else None,
            )
            return {"ok": True, "request_id": request_id, "category": category, "status": decision, "candidateUpdates": candidate_updates}

        if category == "candidate_deletion":
            rows = _shared_read_rows(sheets_api, sheet_id, SHARED_CANDIDATE_DELETION_REQUESTS_TAB, SHARED_CANDIDATE_DELETION_REQUEST_HEADERS)
            row = _find_request_row(rows, request_id)
            if not row:
                return {"ok": False, "error": "Request was not found."}
            current_status = _request_status_value(row.get("status"))
            if current_status != expected_status:
                return {"ok": False, "error": f"Request has already been {_approval_label(current_status).lower()}."}
            row["status"] = decision
            row["admin_decision_at"] = decided_at
            row["admin_decision_by"] = actor
            row["denial_reason"] = denial_reason if decision == "denied" else ""
            _shared_update_existing_row(
                sheets_api,
                sheet_id,
                SHARED_CANDIDATE_DELETION_REQUESTS_TAB,
                SHARED_CANDIDATE_DELETION_REQUEST_HEADERS,
                row["_row_number"],
                _shared_row_values(row, SHARED_CANDIDATE_DELETION_REQUEST_HEADERS),
            )
            terminal_result = {"updated": 0, "pendingUpdated": 0, "already_applied": False}
            if decision == "approved":
                terminal_result = _apply_candidate_deletion_terminal_direct(
                    sheets_api, sheet_id, row.get("session_id") or "", request_id,
                )
            return {
                "ok": True,
                "request_id": request_id,
                "category": category,
                "status": decision,
                "deletion_action_required": False,
                "candidate_deletion_applied": decision == "approved",
                "candidateUpdates": terminal_result.get("updated", 0),
                "pendingUpdates": terminal_result.get("pendingUpdated", 0),
                "already_applied": terminal_result.get("already_applied", False),
            }

        if category == "candidate_correction":
            rows = _shared_read_rows(sheets_api, sheet_id, SHARED_CANDIDATE_CORRECTION_REQUESTS_TAB, SHARED_CANDIDATE_CORRECTION_REQUEST_HEADERS)
            row = _find_request_row(rows, request_id)
            if not row:
                return {"ok": False, "error": "Request was not found.", "error_code": "correction_target_not_found"}
            current_status = _request_status_value(row.get("status"))
            if current_status != expected_status:
                return {"ok": False, "error": "Request has already been resolved.", "error_code": "correction_already_resolved"}
            correction_result = {"ok": True, "updated": 0, "changes": []}
            if decision == "approved":
                try:
                    correction_result = _apply_candidate_correction_direct(
                        sheets_api, sheet_id, row.get("source_session_id") or "", row.get("changes_json") or "[]",
                    )
                except ValueError as exc:
                    return {"ok": False, "error": "The correction request is invalid.", "error_code": str(exc)}
                if not correction_result.get("ok"):
                    return {"ok": False, "error": "The correction target no longer matches the submitted request.", "error_code": correction_result.get("error_code")}
            row["status"] = decision
            row["admin_decision_at"] = decided_at
            row["admin_decision_by"] = actor
            row["denial_reason"] = denial_reason if decision == "denied" else ""
            row["updated_at"] = decided_at
            _shared_update_existing_row(
                sheets_api, sheet_id, SHARED_CANDIDATE_CORRECTION_REQUESTS_TAB, SHARED_CANDIDATE_CORRECTION_REQUEST_HEADERS,
                row["_row_number"], _shared_row_values(row, SHARED_CANDIDATE_CORRECTION_REQUEST_HEADERS),
            )
            return {
                "ok": True, "request_id": request_id, "category": category, "status": decision,
                "candidate_session_updated": correction_result.get("updated", 0) > 0,
                "applied_changes": correction_result.get("changes", []),
                "already_applied": correction_result.get("already_applied", False),
            }

        return {"ok": False, "error": "Unsupported request category."}
    except Exception as exc:
        logger.exception("[REQUESTS] Failed to apply pending request decision: %s", exc)
        return {"ok": False, "error": _candidate_tracking_temporary_unavailable_message()}


def _shared_admin_candidate_action(payload):
    action = str((payload or {}).get("action") or "").strip()
    candidate_name = str((payload or {}).get("candidate_name") or "").strip()
    session_id = str((payload or {}).get("session_id") or (payload or {}).get("latest_session_id") or "").strip()
    pending_id = str((payload or {}).get("pending_id") or "").strip()
    reason = str((payload or {}).get("reason") or "").strip()
    actor = str((payload or {}).get("actor") or (payload or {}).get("changed_by") or "SAM").strip() or "SAM"
    supported_actions = {
        "withdraw",
        "restore_withdrawal",
        "restore_active",
        "grant_extra_attempt",
        "cancel_pending",
        "delete_candidate_history",
        "archive_candidate",
        "mark_passed",
        "mark_failed",
        "mark_incomplete",
        "move_pending_sup_transfer",
        "remove_pending_sup_transfer",
        ADMIN_CANDIDATE_EDIT_ACTION,
    }
    if action not in supported_actions:
        return {"ok": False, "error": "Unsupported candidate tracking action."}
    if action == ADMIN_CANDIDATE_EDIT_ACTION and not session_id:
        return _candidate_update_failure("candidate_update_target_not_found")
    if action == ADMIN_CANDIDATE_EDIT_ACTION and not reason:
        return {"ok": False, "error": "A correction reason is required.", "error_code": "correction_reason_required"}
    exact_session_actions = {"mark_passed", "mark_failed", "grant_extra_attempt", "mark_incomplete", "move_pending_sup_transfer", "remove_pending_sup_transfer"}
    if action in exact_session_actions and not session_id:
        return {"ok": False, "error": "Refresh Candidate Tracking before changing this exact certification record."}
    if not candidate_name and not session_id and not pending_id:
        targets = (payload or {}).get("targets") or []
        if action != "delete_candidate_history" or not isinstance(targets, list) or not targets:
            return {"ok": False, "error": "Candidate name, session id, or pending id is required."}

    context = _shared_sheet_context()
    if not context.get("ok"):
        return {"ok": False, "error": _candidate_tracking_temporary_unavailable_message(), "setup": _shared_tracking_required_setup()}

    try:
        apps_script_client = context.get("appsScriptClient")
        if apps_script_client:
            from services.apps_script_api import AppsScriptApiError
            apps_script_payload = dict(payload or {})
            apps_script_payload["operation"] = action
            apps_script_payload.pop("action", None)
            try:
                result = apps_script_client.post("updateCandidateTracking", apps_script_payload)
            except AppsScriptApiError as exc:
                return _candidate_update_failure(_candidate_update_error_code(exc))
            if not isinstance(result, dict):
                return _candidate_update_failure("candidate_update_response_invalid")
            if result.get("updated") is not True:
                return _candidate_update_failure(
                    result.get("error_code") or _candidate_update_error_code(result.get("error") or result.get("message")),
                    candidate_updated=bool(result.get("candidateUpdated") or result.get("candidate_updated")),
                )
            return {"ok": True, "action": action, **result}
        sheets_api = context["service"].spreadsheets()
        sheet_id = context["sheet_id"]
        candidate_rows = _shared_read_rows(sheets_api, sheet_id, SHARED_CANDIDATE_SESSIONS_TAB, SHARED_CANDIDATE_SESSION_HEADERS)
        pending_rows = _shared_read_rows(sheets_api, sheet_id, SHARED_PENDING_SUP_TRANSFERS_TAB, SHARED_PENDING_SUP_TRANSFER_HEADERS)
        target_key = _candidate_name_key(candidate_name)
        now_iso = datetime.now(timezone.utc).isoformat()
        retention_until = _add_business_days(datetime.now(timezone.utc), 10).date().isoformat()
        updated_candidates = 0
        updated_pending = 0
        pending_append_row = None

        if action == ADMIN_CANDIDATE_EDIT_ACTION:
            try:
                changes = _normalize_correction_changes((payload or {}).get("changes") or [])
            except ValueError as exc:
                return _candidate_update_failure("candidate_update_no_changes" if str(exc) == "correction_no_changes" else "candidate_update_failed")
            try:
                _shared_read_rows(
                    sheets_api, sheet_id, SHARED_CANDIDATE_CORRECTION_REQUESTS_TAB,
                    SHARED_CANDIDATE_CORRECTION_REQUEST_HEADERS,
                )
            except Exception:
                return _candidate_update_failure("candidate_update_audit_failed", candidate_updated=False)
            correction = _apply_candidate_correction_direct(
                sheets_api, sheet_id, session_id, changes, (payload or {}).get("candidate_id") or "",
            )
            if not correction.get("ok"):
                code = "candidate_update_target_not_found" if correction.get("error_code") == "correction_target_not_found" else "candidate_update_identity_mismatch"
                return _candidate_update_failure(code)
            fingerprint = hashlib.sha256(json.dumps({"session": session_id, "changes": changes}, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()[:12]
            request_id = str((payload or {}).get("request_id") or f"admin-correction-{session_id}-{fingerprint}")
            now_iso = datetime.now(timezone.utc).isoformat()
            audit_row = {
                "request_id": request_id, "request_type": ADMIN_CANDIDATE_EDIT_AUDIT_TYPE,
                "source_session_id": session_id, "candidate_id": (payload or {}).get("candidate_id") or session_id,
                "candidate_name": candidate_name, "tester_name": actor,
                "reason": reason, "changes_json": json.dumps(changes, separators=(",", ":")),
                "created_at": now_iso, "status": "approved", "admin_decision_at": now_iso,
                "admin_decision_by": actor, "denial_reason": "", "updated_at": now_iso,
            }
            try:
                _shared_update_or_append_row(
                    sheets_api, sheet_id, SHARED_CANDIDATE_CORRECTION_REQUESTS_TAB,
                    SHARED_CANDIDATE_CORRECTION_REQUEST_HEADERS, "request_id", request_id,
                    _shared_row_values(audit_row, SHARED_CANDIDATE_CORRECTION_REQUEST_HEADERS),
                )
            except Exception:
                return _candidate_update_failure("candidate_update_audit_failed", candidate_updated=True)
            return {"ok": True, "action": action, "request_id": request_id, **correction}

        def manual_note(previous_status, new_status, note_text=""):
            note = (
                f"Manual SAM correction by {actor} at {now_iso}. "
                f"Previous status: {previous_status or 'unknown'}. New status: {new_status or 'unknown'}."
            )
            if note_text:
                note = f"{note} Reason: {note_text}"
            return note

        def append_note(existing, note):
            return "\n\n".join(part for part in [existing or "", note] if str(part or "").strip())

        def fail_status_for_row(row):
            return "FAIL-Final Attempt" if _shared_truthy(row.get("final_attempt")) else "Fail"

        def build_pending_row_from_candidate(row, next_pending_id):
            first, last_initial = _split_candidate_name(row.get("candidate_name"))
            return {
                "pending_id": next_pending_id,
                "candidate_name": row.get("candidate_name") or "",
                "candidate_first_name": row.get("candidate_first_name") or first,
                "candidate_last_initial": row.get("candidate_last_initial") or last_initial,
                "original_tester_name": row.get("tester_name") or "",
                "original_session_id": row.get("session_id") or session_id or "",
                "created_at": now_iso,
                "status": "pending",
                "final_attempt": _shared_bool(_shared_truthy(row.get("final_attempt"))),
                "mock_call_summary": row.get("mock_call_summary") or "",
                "call_1_result": row.get("call_1_result") or "",
                "call_2_result": row.get("call_2_result") or "",
                "call_3_result": row.get("call_3_result") or "",
                "needed_reason": "Manual SAM correction: supervisor transfer still required.",
                "completed_by": "",
                "completed_at": "",
                "completed_status": "",
                "notes": manual_note(row.get("status"), "pending", reason),
                "headset_usb": row.get("headset_usb") or "",
                "noise_cancel": row.get("noise_cancel") or "",
                "headset_brand": row.get("headset_brand") or "",
                "vpn_on": row.get("vpn_on") or "",
                "vpn_off": row.get("vpn_off") or "",
                "chrome_default": row.get("chrome_default") or "",
                "extensions_disabled": row.get("extensions_disabled") or "",
                "popups_allowed": row.get("popups_allowed") or "",
                "skills": row.get("skills") or "",
            }

        if action == "delete_candidate_history":
            raw_targets = (payload or {}).get("targets")
            if not isinstance(raw_targets, list) or not raw_targets:
                raw_targets = [{
                    "candidate_name": candidate_name,
                    "session_id": session_id,
                    "pending_id": pending_id,
                }]

            target_names = {
                _candidate_name_key(target.get("candidate_name"))
                for target in raw_targets
                if isinstance(target, dict) and target.get("candidate_name")
            }
            target_session_ids = {
                str(target.get("session_id") or target.get("latest_session_id") or "").strip()
                for target in raw_targets
                if isinstance(target, dict) and (target.get("session_id") or target.get("latest_session_id"))
            }
            target_pending_ids = {
                str(target.get("pending_id") or "").strip()
                for target in raw_targets
                if isinstance(target, dict) and target.get("pending_id")
            }
            target_session_ids.discard("")
            target_pending_ids.discard("")
            target_names.discard("")

            candidate_delete_rows = [
                row for row in candidate_rows
                if (
                    str(row.get("session_id") or "").strip() in target_session_ids
                    or _candidate_name_key(row.get("candidate_name")) in target_names
                )
            ]
            pending_delete_rows = [
                row for row in pending_rows
                if (
                    str(row.get("pending_id") or "").strip() in target_pending_ids
                    or str(row.get("original_session_id") or "").strip() in target_session_ids
                    or _candidate_name_key(row.get("candidate_name")) in target_names
                )
            ]
            if not candidate_delete_rows and not pending_delete_rows:
                return {"ok": False, "error": "No matching Candidate Sessions or Pending Sup Transfers rows were found to delete."}

            candidate_delete_session_ids = {
                str(row.get("session_id") or "").strip()
                for row in candidate_delete_rows
                if str(row.get("session_id") or "").strip()
            }
            if candidate_delete_session_ids:
                review_schema = _headset_review_schema_from_context(context)
                review_rows = _shared_read_rows(
                    sheets_api,
                    sheet_id,
                    HEADSET_REVIEW_LOG_TAB,
                    _headset_review_headers(review_schema),
                )
                if any(
                    str(row.get("source_session_id") or "").strip() in candidate_delete_session_ids
                    for row in review_rows
                ):
                    return {
                        "ok": False,
                        "error": "Candidate session has a linked headset review. Resolve the review relationship before deleting the session.",
                    }

            requests = []
            candidate_gid = _shared_sheet_gid(sheets_api, sheet_id, SHARED_CANDIDATE_SESSIONS_TAB)
            pending_gid = _shared_sheet_gid(sheets_api, sheet_id, SHARED_PENDING_SUP_TRANSFERS_TAB)
            if candidate_delete_rows and candidate_gid is None:
                return {"ok": False, "error": "Candidate Sessions sheet id could not be resolved."}
            if pending_delete_rows and pending_gid is None:
                return {"ok": False, "error": "Pending Sup Transfers sheet id could not be resolved."}

            for row in sorted(candidate_delete_rows, key=lambda item: int(item.get("_row_number") or 0), reverse=True):
                row_number = int(row.get("_row_number") or 0)
                if row_number > 1:
                    requests.append({
                        "deleteDimension": {
                            "range": {
                                "sheetId": candidate_gid,
                                "dimension": "ROWS",
                                "startIndex": row_number - 1,
                                "endIndex": row_number,
                            },
                        },
                    })
            for row in sorted(pending_delete_rows, key=lambda item: int(item.get("_row_number") or 0), reverse=True):
                row_number = int(row.get("_row_number") or 0)
                if row_number > 1:
                    requests.append({
                        "deleteDimension": {
                            "range": {
                                "sheetId": pending_gid,
                                "dimension": "ROWS",
                                "startIndex": row_number - 1,
                                "endIndex": row_number,
                            },
                        },
                    })
            if not requests:
                return {"ok": False, "error": "No deletable shared candidate rows were found."}
            sheets_api.batchUpdate(spreadsheetId=sheet_id, body={"requests": requests}).execute()
            logger.info(
                "[SHARED] Deleted SAM candidate history rows. candidates=%s pending=%s targets=%s",
                len(candidate_delete_rows),
                len(pending_delete_rows),
                len(raw_targets),
            )
            return {
                "ok": True,
                "action": action,
                "deletedCandidateRows": len(candidate_delete_rows),
                "deletedPendingRows": len(pending_delete_rows),
            }

        for row in candidate_rows:
            matches = (
                str(row.get("session_id") or "").strip() == session_id
                if action in exact_session_actions
                else (
                    (session_id and str(row.get("session_id") or "").strip() == session_id)
                    or (target_key and _candidate_name_key(row.get("candidate_name")) == target_key)
                )
            )
            if not matches:
                continue
            if action == "withdraw":
                row["status"] = "WITHDREW FROM CERTIFICATION"
                row["withdrawn"] = "TRUE"
                row["withdrawn_at"] = now_iso
                row["retention_until"] = row.get("retention_until") or retention_until
            elif action == "restore_active":
                row["archived"] = "FALSE"
                if str(row.get("status") or "").upper() in {"ARCHIVED", "REMOVED"}:
                    row["status"] = "INCOMPLETE"
                row["review_notes"] = append_note(row.get("review_notes"), f"Restored from archive by {actor} at {now_iso}.")
            elif action == "restore_withdrawal":
                row["withdrawn"] = "FALSE"
                row["withdrawn_at"] = ""
                if str(row.get("status") or "").upper() == "WITHDREW FROM CERTIFICATION":
                    row["status"] = "INCOMPLETE"
                row["review_notes"] = "\n\n".join(part for part in [row.get("review_notes") or "", "Admin restored candidate from withdrew from certification status."] if part)
            elif action == "grant_extra_attempt":
                current_extra_count = _candidate_extra_attempt_count(row)
                expected_extra_count = (payload or {}).get("expected_extra_attempts_granted")
                if expected_extra_count not in (None, ""):
                    try:
                        if int(expected_extra_count) != current_extra_count:
                            return {
                                "ok": True, "action": action, "already_applied": True,
                                "extra_attempts_granted": current_extra_count,
                                "allowed_attempt_count": max(CERTIFICATION_BASE_MAX_ATTEMPTS + current_extra_count, _positive_attempt_number(row.get("allowed_attempt_count"), 0)),
                            }
                    except (TypeError, ValueError):
                        return {"ok": False, "error": "Refresh Candidate Tracking before granting another attempt."}
                next_extra_count = current_extra_count + 1
                row["extra_attempt_granted"] = "TRUE"
                row["extra_attempt_reason"] = reason
                row["extra_attempts_granted"] = next_extra_count
                row["allowed_attempt_count"] = max(
                    CERTIFICATION_BASE_MAX_ATTEMPTS + next_extra_count,
                    _positive_attempt_number(row.get("allowed_attempt_count"), 0),
                )
                row["extra_attempt_last_action_id"] = str((payload or {}).get("action_id") or f"extra-{session_id}-{next_extra_count}")
                row["extra_attempt_granted_by"] = actor
                row["extra_attempt_granted_at"] = now_iso
                row["withdrawn"] = "FALSE"
                row["withdrawn_at"] = ""
                if str(row.get("status") or "").upper() == "WITHDREW FROM CERTIFICATION":
                    row["status"] = "INCOMPLETE"
                row["review_notes"] = "\n\n".join(part for part in [row.get("review_notes") or "", f"Extra attempt granted. {reason}".strip()] if part)
            elif action == "archive_candidate":
                row["archived"] = "TRUE"
                row["review_notes"] = append_note(
                    row.get("review_notes"),
                    f"Archived manually in SAM by {actor} at {now_iso}.{f' Reason: {reason}' if reason else ''}",
                )
            elif action in {"mark_passed", "mark_failed", "mark_incomplete", "move_pending_sup_transfer", "remove_pending_sup_transfer"}:
                previous_status = row.get("status") or ""
                if action == "mark_passed":
                    row["status"] = "Pass"
                    row["final_result"] = "Pass"
                    row["mock_calls_completed"] = "TRUE"
                    row["sup_transfers_completed"] = "TRUE"
                    row["needs_sup_transfer"] = "FALSE"
                    row["pending_sup_transfer_id"] = ""
                elif action == "mark_failed":
                    row["status"] = fail_status_for_row(row)
                    row["final_result"] = row["status"]
                    row["needs_sup_transfer"] = "FALSE"
                    row["pending_sup_transfer_id"] = ""
                elif action == "mark_incomplete":
                    row["status"] = "INCOMPLETE"
                    row["needs_sup_transfer"] = "FALSE"
                    row["pending_sup_transfer_id"] = ""
                elif action == "move_pending_sup_transfer":
                    next_pending_id = pending_id or row.get("pending_sup_transfer_id") or f"pending-{row.get('session_id') or session_id or uuid.uuid4()}"
                    row["status"] = "INCOMPLETE"
                    row["needs_sup_transfer"] = "TRUE"
                    row["pending_sup_transfer_id"] = next_pending_id
                    if pending_append_row is None:
                        pending_append_row = build_pending_row_from_candidate(row, next_pending_id)
                elif action == "remove_pending_sup_transfer":
                    row["status"] = "INCOMPLETE"
                    row["needs_sup_transfer"] = "FALSE"
                    row["pending_sup_transfer_id"] = ""
                row["withdrawn"] = "FALSE"
                row["withdrawn_at"] = ""
                if action in {"mark_passed", "mark_failed"}:
                    row["readiness_override_applied"] = "TRUE"
                    row["readiness_override_result"] = row["status"]
                    row["readiness_override_reason"] = reason
                    row["readiness_override_explanation"] = manual_note(previous_status, row.get("status"), reason)
                    row["readiness_override_by"] = actor
                    row["readiness_override_at"] = now_iso
                row["review_notes"] = append_note(row.get("review_notes"), manual_note(previous_status, row.get("status"), reason))
            _shared_update_existing_row(sheets_api, sheet_id, SHARED_CANDIDATE_SESSIONS_TAB, SHARED_CANDIDATE_SESSION_HEADERS, row["_row_number"], _shared_row_values(row, SHARED_CANDIDATE_SESSION_HEADERS))
            updated_candidates += 1

        for row in pending_rows:
            matches = (
                (pending_id and str(row.get("pending_id") or "").strip() == pending_id)
                or (session_id and str(row.get("original_session_id") or "").strip() == session_id)
                or (target_key and _candidate_name_key(row.get("candidate_name")) == target_key)
            )
            if not matches:
                continue
            if action == "withdraw":
                row["status"] = "withdrawn"
                row["completed_at"] = now_iso
                row["completed_status"] = "WITHDREW FROM CERTIFICATION"
                row["notes"] = "\n\n".join(part for part in [row.get("notes") or "", "Admin marked candidate as withdrew from certification."] if part)
            elif action == "restore_withdrawal":
                if str(row.get("status") or "").strip().lower() == "withdrawn":
                    row["status"] = "pending"
                    row["completed_at"] = ""
                    row["completed_status"] = ""
                row["notes"] = "\n\n".join(part for part in [row.get("notes") or "", "Admin restored candidate from withdrew from certification status."] if part)
            elif action == "grant_extra_attempt":
                row["status"] = "pending"
                row["notes"] = "\n\n".join(part for part in [row.get("notes") or "", f"Extra attempt granted. {reason}".strip()] if part)
            elif action == "cancel_pending":
                row["status"] = "cancelled"
                row["completed_at"] = now_iso
                row["completed_status"] = "cancelled"
                row["notes"] = "\n\n".join(part for part in [row.get("notes") or "", "Admin cancelled pending supervisor transfer."] if part)
            elif action == "archive_candidate":
                previous_status = row.get("status") or ""
                row["status"] = "archived"
                row["completed_by"] = actor
                row["completed_at"] = row.get("completed_at") or now_iso
                row["completed_status"] = row.get("completed_status") or "archived"
                row["notes"] = append_note(row.get("notes"), manual_note(previous_status, "archived", reason))
            elif action == "mark_passed":
                previous_status = row.get("status") or ""
                row["status"] = "completed"
                row["completed_by"] = actor
                row["completed_at"] = now_iso
                row["completed_status"] = "PASS"
                row["notes"] = append_note(row.get("notes"), manual_note(previous_status, "PASS", reason))
            elif action == "mark_failed":
                previous_status = row.get("status") or ""
                row["status"] = "completed"
                row["completed_by"] = actor
                row["completed_at"] = now_iso
                row["completed_status"] = "FAIL"
                row["notes"] = append_note(row.get("notes"), manual_note(previous_status, "FAIL", reason))
            elif action in {"mark_incomplete", "remove_pending_sup_transfer"}:
                previous_status = row.get("status") or ""
                row["status"] = "cancelled"
                row["completed_by"] = actor
                row["completed_at"] = now_iso
                row["completed_status"] = "INCOMPLETE"
                row["notes"] = append_note(row.get("notes"), manual_note(previous_status, "INCOMPLETE", reason))
            elif action == "move_pending_sup_transfer":
                previous_status = row.get("status") or ""
                row["status"] = "pending"
                row["completed_by"] = ""
                row["completed_at"] = ""
                row["completed_status"] = ""
                row["notes"] = append_note(row.get("notes"), manual_note(previous_status, "pending", reason))
            _shared_update_existing_row(sheets_api, sheet_id, SHARED_PENDING_SUP_TRANSFERS_TAB, SHARED_PENDING_SUP_TRANSFER_HEADERS, row["_row_number"], _shared_row_values(row, SHARED_PENDING_SUP_TRANSFER_HEADERS))
            updated_pending += 1

        if action == "move_pending_sup_transfer" and updated_pending == 0 and pending_append_row:
            next_pending_id = pending_append_row.get("pending_id")
            _shared_update_or_append_row(
                sheets_api,
                sheet_id,
                SHARED_PENDING_SUP_TRANSFERS_TAB,
                SHARED_PENDING_SUP_TRANSFER_HEADERS,
                "pending_id",
                next_pending_id,
                _shared_row_values(pending_append_row, SHARED_PENDING_SUP_TRANSFER_HEADERS),
            )
            updated_pending += 1

        if updated_candidates == 0 and updated_pending == 0:
            return {"ok": False, "error": "No matching Candidate Sessions or Pending Sup Transfers rows were updated."}
        return {"ok": True, "updatedCandidates": updated_candidates, "updatedPending": updated_pending, "action": action}
    except Exception as exc:
        if _google_sheet_quota_or_temporary_error(exc):
            logger.warning("[SHARED] Candidate admin action temporarily unavailable due to Google Sheets quota/rate limit: %s", exc)
        else:
            logger.exception("[SHARED] Candidate admin action failed: %s", exc)
        return {"ok": False, "error": _candidate_tracking_temporary_unavailable_message(), "setup": _shared_tracking_required_setup()}


def _sam_master_sheet_context():
    try:
        from services.apps_script_api import create_apps_script_sheet_service
        apps_script_result = create_apps_script_sheet_service(ROOT_DIR, expected_role="sam")
        if apps_script_result.get("ok") and apps_script_result.get("client"):
            return {
                "ok": True,
                "service": None,
                "appsScriptClient": apps_script_result["client"],
                "sheet_id": "",
                "transport": "apps_script",
            }
    except Exception as exc:
        logger.warning("[SAM-SETUP] transport=apps_script status=unavailable error_type=%s", type(exc).__name__)

    if _is_development_mode():
        service_result = _get_shared_tracking_sheet_service()
        if service_result.get("ok") and service_result.get("service"):
            return {
                "ok": True,
                "service": service_result["service"],
                "appsScriptClient": None,
                "sheet_id": service_result["sheet_id"],
                "transport": "direct_sheets_development",
            }

    return {
        "ok": False,
        "errorCode": "setup_configuration_unavailable",
    }


SAM_SETUP_ERROR_MESSAGES = {
    "setup_configuration_unavailable": "SAM setup is temporarily unavailable because its administrator configuration could not be loaded.",
    "setup_authorization_failed": "SAM could not verify setup authorization. Contact support if this continues.",
    "setup_admin_not_found": "The administrator name or PIN was not recognized.",
    "setup_invalid_admin": "The administrator name or PIN was not recognized.",
    "setup_invalid_pin": "The administrator name or PIN was not recognized.",
    "setup_transport_unavailable": "SAM could not verify setup right now. Check the connection and try again.",
    "setup_response_invalid": "SAM received an invalid setup response. Please try again.",
    "setup_persistence_failed": "SAM verified the administrator, but could not save setup on this device. Please try again.",
}


def _sam_setup_error(error_code):
    code = error_code if error_code in SAM_SETUP_ERROR_MESSAGES else "setup_transport_unavailable"
    return {
        "ok": False,
        "errorCode": code,
        "error": SAM_SETUP_ERROR_MESSAGES[code],
    }


def _sam_setup_transport_error_code(exc):
    text = str(exc or "").lower()
    if any(marker in text for marker in ("unauthorized", "forbidden", "401", "403")):
        return "setup_authorization_failed"
    if any(marker in text for marker in ("invalid response", "json", "decode")):
        return "setup_response_invalid"
    if any(marker in text for marker in ("unknown action", "missing sheet", "missing headers", "not configured")):
        return "setup_configuration_unavailable"
    return "setup_transport_unavailable"


def _normalize_sam_setup_remote_result(result):
    if not isinstance(result, dict):
        return _sam_setup_error("setup_response_invalid")
    if result.get("ok") is False:
        return _sam_setup_error(result.get("errorCode"))
    if result.get("ok") is not True:
        return _sam_setup_error("setup_response_invalid")
    name = " ".join(str(result.get("name") or "").split())
    role = str(result.get("role") or "").strip()
    if not name or not role:
        return _sam_setup_error("setup_response_invalid")
    return {"ok": True, "name": name, "role": role}


def _ensure_sam_authorized_users(sheets_api, sheet_id):
    metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
    tabs = {
        ((sheet.get("properties") or {}).get("title") or ""): sheet
        for sheet in metadata.get("sheets", [])
    }
    logger.info("[SAM-SETUP] Tab check tab=%s found=%s", SAM_AUTHORIZED_USERS_TAB, SAM_AUTHORIZED_USERS_TAB in tabs)
    return _verify_sam_authorized_users_tab(sheets_api, sheet_id, tabs)


def _read_sam_authorized_users(sheets_api, sheet_id):
    status = _ensure_sam_authorized_users(sheets_api, sheet_id)
    if not status.get("ok"):
        return status, []
    rows = _shared_read_rows(sheets_api, sheet_id, SAM_AUTHORIZED_USERS_TAB, SAM_AUTHORIZED_USER_HEADERS)
    logger.info("[SAM-SETUP] Read authorized-user rows=%d headerStatus=%s", len(rows), status.get("headerStatus") or "unknown")
    normalized_rows = []
    for row in rows:
        normalized = _normalize_shared_row(row)
        normalized["_row_number"] = row.get("_row_number")
        normalized_rows.append(normalized)
    return status, normalized_rows


def _sam_setup_status():
    context = _sam_master_sheet_context()
    if not context.get("ok"):
        return {**_sam_setup_error(context.get("errorCode")), "configured": False}
    try:
        client = context.get("appsScriptClient")
        if client:
            result = client.get("getSamSetupStatus")
            if not isinstance(result, dict) or result.get("ok") is not True or not isinstance(result.get("configured"), bool):
                return {**_sam_setup_error("setup_response_invalid"), "configured": False}
            return {"ok": True, "configured": result["configured"], "errorCode": "", "error": ""}
        status, _rows = _read_sam_authorized_users(context["service"].spreadsheets(), context["sheet_id"])
        return {
            "ok": bool(status.get("ok")),
            "configured": bool(status.get("ok")),
            "defaultOwnerCreated": bool(status.get("defaultOwnerCreated")),
            "errorCode": "" if status.get("ok") else "setup_configuration_unavailable",
            "error": "" if status.get("ok") else SAM_SETUP_ERROR_MESSAGES["setup_configuration_unavailable"],
        }
    except Exception as exc:
        code = _sam_setup_transport_error_code(exc)
        logger.warning("[SAM-SETUP] status=failed error_code=%s error_type=%s", code, type(exc).__name__)
        return {**_sam_setup_error(code), "configured": False}


def _complete_sam_setup(payload):
    entered_name = " ".join(str((payload or {}).get("name") or "").split())
    entered_pin = str((payload or {}).get("pin") or "").strip()
    device_name = str((payload or {}).get("device_name") or "").strip()[:120]
    if not entered_name or not entered_pin:
        return _sam_setup_error("setup_invalid_admin" if not entered_name else "setup_invalid_pin")

    context = _sam_master_sheet_context()
    if not context.get("ok"):
        return _sam_setup_error(context.get("errorCode"))

    try:
        client = context.get("appsScriptClient")
        if client:
            result = client.post("completeSamSetup", {
                "name": entered_name,
                "pin": entered_pin,
                "device_name": device_name,
            })
            normalized = _normalize_sam_setup_remote_result(result)
            logger.info(
                "[SAM-SETUP] transport=apps_script status=%s error_code=%s",
                "complete" if normalized.get("ok") else "rejected",
                normalized.get("errorCode") or "",
            )
            return normalized

        sheets_api = context["service"].spreadsheets()
        status, rows = _read_sam_authorized_users(sheets_api, context["sheet_id"])
        if not status.get("ok"):
            return _sam_setup_error("setup_configuration_unavailable")
        matched_name_row = None
        name_key = entered_name.casefold()
        for row in rows:
            if str(row.get("name") or "").strip().casefold() != name_key:
                continue
            matched_name_row = row
            pin_ok = hmac.compare_digest(str(row.get("pin") or "").strip(), entered_pin)
            enabled_ok = _shared_truthy(row.get("enabled"))
            if not pin_ok:
                return _sam_setup_error("setup_invalid_pin")
            if not enabled_ok:
                return _sam_setup_error("setup_authorization_failed")
            if pin_ok and enabled_ok:
                target = row
                break
        else:
            target = None
        if not matched_name_row:
            return _sam_setup_error("setup_admin_not_found")
        if not target:
            return _sam_setup_error("setup_authorization_failed")

        target["installed"] = "TRUE"
        target["install_date"] = target.get("install_date") or datetime.now(timezone.utc).isoformat()
        if device_name:
            target["device_name"] = device_name
        _shared_update_existing_row(
            sheets_api,
            context["sheet_id"],
            SAM_AUTHORIZED_USERS_TAB,
            SAM_AUTHORIZED_USER_HEADERS,
            target["_row_number"],
            _shared_row_values(target, SAM_AUTHORIZED_USER_HEADERS),
        )
        logger.info("[SAM-SETUP] transport=direct_sheets_development status=complete")
        return {"ok": True, "name": target.get("name") or entered_name, "role": target.get("role") or "user"}
    except Exception as exc:
        code = _sam_setup_transport_error_code(exc)
        logger.warning("[SAM-SETUP] status=failed error_code=%s error_type=%s", code, type(exc).__name__)
        return _sam_setup_error(code)


def _ensure_update_tabs(service, sheet_id):
    try:
        sheets_api = service.spreadsheets()
        metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
        tabs = {
            ((sheet.get("properties") or {}).get("title") or ""): sheet
            for sheet in metadata.get("sheets", [])
        }
        requests = [
            {"addSheet": {"properties": {"title": title}}}
            for title in _update_sheet_required_setup().keys()
            if title not in tabs
        ]
        if requests:
            sheets_api.batchUpdate(spreadsheetId=sheet_id, body={"requests": requests}).execute()
        for title, headers in _update_sheet_required_setup().items():
            quoted = _quote_sheet_title_for_a1(title)
            last_col = _column_letter(len(headers))
            current = sheets_api.values().get(
                spreadsheetId=sheet_id,
                range=f"{quoted}!A1:{last_col}1",
            ).execute().get("values", [[]])[0]
            if current[: len(headers)] != headers:
                has_conflicting_header = any(_normalize_notification_text(value) for value in current)
                if has_conflicting_header:
                    return {"ok": False, "error": f"Update tab '{title}' has unexpected headers.", "setup": _update_sheet_required_setup()}
                sheets_api.values().update(
                    spreadsheetId=sheet_id,
                    range=f"{quoted}!A1:{last_col}1",
                    valueInputOption="USER_ENTERED",
                    body={"values": [headers]},
                ).execute()
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": f"Unable to create or verify update tabs: {exc}", "setup": _update_sheet_required_setup()}


def _parse_update_notes(value):
    return [
        line.strip().lstrip("-").strip()
        for line in str(value or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
        if line.strip()
    ]


def _get_update_metadata(app_name):
    normalized = str(app_name or "").strip().lower()
    tab_name = UPDATE_SAM_TAB if normalized in {"sam", "notification-manager", "notification"} else UPDATE_MTS_TAB
    expected_app = "sam" if tab_name == UPDATE_SAM_TAB else "mts"
    service_result = _get_shared_tracking_sheet_service()
    if not service_result.get("ok"):
        return {"ok": False, "error": service_result.get("error"), "setup": _update_sheet_required_setup()}

    apps_script_client = service_result.get("appsScriptClient")
    if apps_script_client:
        try:
            result = apps_script_client.get("getUpdateMetadata")
            returned_app = str((result or {}).get("app") or "").strip().lower()
            returned_tab = str((result or {}).get("tab") or "").strip()
            if returned_app != expected_app or returned_tab != tab_name:
                logger.warning(
                    "[UPDATE] Apps Script update metadata role mismatch expected_app=%s returned_app=%s",
                    expected_app,
                    returned_app or "missing",
                )
                return {
                    "ok": False,
                    "error": "The update service configuration does not match this application.",
                    "setup": _update_sheet_required_setup(),
                }
            row = (result or {}).get("row")
            if not isinstance(row, dict):
                row = {}
            return {
                "ok": True,
                "app": expected_app,
                "tab": tab_name,
                "latestVersion": str(row.get("Version") or "").strip(),
                "requiredVersion": str(row.get("RequiredVersion") or "").strip(),
                "releaseDate": str(row.get("Release Date") or "").strip(),
                "releaseTitle": str(row.get("Release Title") or "").strip(),
                "downloadUrl": str(row.get("URL") or "").strip(),
                "notes": _parse_update_notes(row.get("Notes") or ""),
                "source": "master-google-sheet",
                "setup": _update_sheet_required_setup(),
            }
        except Exception:
            logger.warning("[UPDATE] Apps Script update metadata read failed for %s.", expected_app)
            return {
                "ok": False,
                "error": "Unable to read update metadata through the configured update service.",
                "setup": _update_sheet_required_setup(),
            }

    ensure_result = _ensure_update_tabs(service_result["service"], service_result["sheet_id"])
    if not ensure_result.get("ok"):
        return ensure_result

    try:
        sheets_api = service_result["service"].spreadsheets()
        rows = _shared_read_rows(sheets_api, service_result["sheet_id"], tab_name, UPDATE_TAB_HEADERS)
        row = next((candidate for candidate in rows if str(candidate.get("Version") or "").strip()), None)
        if not row:
            return {"ok": True, "app": normalized or "mts", "tab": tab_name, "latestVersion": "", "requiredVersion": "", "downloadUrl": "", "releaseDate": "", "releaseTitle": "", "notes": []}
        return {
            "ok": True,
            "app": "sam" if tab_name == UPDATE_SAM_TAB else "mts",
            "tab": tab_name,
            "latestVersion": str(row.get("Version") or "").strip(),
            "requiredVersion": str(row.get("RequiredVersion") or "").strip(),
            "releaseDate": str(row.get("Release Date") or "").strip(),
            "releaseTitle": str(row.get("Release Title") or "").strip(),
            "downloadUrl": str(row.get("URL") or "").strip(),
            "notes": _parse_update_notes(row.get("Notes") or ""),
            "source": "master-google-sheet",
            "setup": _update_sheet_required_setup(),
        }
    except Exception as exc:
        logger.warning("[UPDATE] Failed to read update metadata from %s: %s", tab_name, exc)
        return {"ok": False, "error": f"Unable to read update metadata from {tab_name}: {exc}", "setup": _update_sheet_required_setup()}


def _mock_call_summary(session):
    parts = []
    for i in range(1, 4):
        call = session.get(f"call_{i}") or {}
        if call.get("result"):
            parts.append(f"Call {i}: {call.get('result')} ({call.get('type') or 'Unknown type'})")
    return "; ".join(parts)


def _final_notes_field(session, field_name):
    """Extract a specific field from finalEvaluatorNotes."""
    notes = session.get("finalEvaluatorNotes") or {}
    if not notes:
        return ""
    if field_name == "other":
        return str(notes.get("other") or notes.get("notes") or "").strip()
    return str(notes.get(field_name) or "").strip()


def _get_evaluator_notes_summary(session):
    """Generate the evaluator notes summary representation for the candidate row."""
    if session.get("evaluatorNotesSummaryEdited"):
        return session.get("evaluatorNotesSummaryEdited")
    if session.get("evaluatorNotesSummary"):
        return session.get("evaluatorNotesSummary")
    notes = session.get("finalEvaluatorNotes") or {}
    if not notes:
        return ""
    parts = []
    if notes.get("historyOnly"):
        parts.append("(History-Only Notes - not included in summaries)")
    if notes.get("notes"):
        parts.append(notes.get("notes").strip())
    if notes.get("strengths"):
        parts.append(f"Strengths: {notes.get('strengths').strip()}")
    if notes.get("needsCoaching"):
        parts.append(f"Needs Coaching: {notes.get('needsCoaching').strip()}")
    if notes.get("other"):
        parts.append(f"Other Notes: {notes.get('other').strip()}")
    return "\n\n".join(p for p in parts if p)


def _readiness_tracking_values(session):
    judgment = _readiness_judgment(session)
    calculated = str(judgment.get("calculatedResult") or compute_calculated_status(session) or "").strip()
    final_result = compute_final_status(session)
    override_applied = _readiness_override_applied(session)
    return [
        calculated,
        final_result,
        _shared_bool(override_applied),
        str(judgment.get("overrideResult") or "").strip() if override_applied else "",
        str(judgment.get("primaryReason") or "").strip() if override_applied else "",
        str(judgment.get("explanation") or "").strip() if override_applied else "",
    ]


def _candidate_session_identity(session):
    """Return the exact stable identity used by Candidate Sessions."""
    return str(
        (session or {}).get("history_id")
        or (session or {}).get("resume_source_history_id")
        or (session or {}).get("session_id")
        or ""
    ).strip()


def _candidate_session_row(session, existing_rows=None):
    existing_rows = existing_rows or []
    session = _session_with_workflow_defaults(session)
    status = compute_final_status(session)
    shared_status = _shared_status(status)
    session_id = _candidate_session_identity(session) or str(uuid.uuid4())
    candidate_name = str(session.get("candidate_name") or session.get("candidate") or "").strip()
    first, last_initial = _split_candidate_name(candidate_name)
    pending_id = str(session.get("pending_sup_transfer_id") or session.get("shared_pending_id") or "").strip()
    needs_sup = _candidate_needs_sup_transfer(session, status)
    if needs_sup and not pending_id:
        pending_id = f"pending-{session_id}"
    created_at = str(session.get("timestamp_iso") or session.get("created_at") or datetime.now(timezone.utc).isoformat())
    completed_at = str(session.get("completed_at") or session.get("timestamp_iso") or datetime.now(timezone.utc).isoformat())
    attempt_number = (
        session.get("newbie_shift_resulting_attempt")
        if str(session.get("newbie_shift_request_type") or "").strip().lower() == NEWBIE_REQUEST_RESCHEDULE
        else None
    ) or session.get("attempt_number") or _session_attempt_number(existing_rows, candidate_name)
    review_notes = session.get("review_notes") or ""
    if session.get("candidate_override_used"):
        override_note = "Final-attempt override used for this candidate."
        if session.get("candidate_override_reason"):
            override_note = f"{override_note} {session.get('candidate_override_reason')}"
        review_notes = "\n\n".join(part for part in [review_notes, override_note] if str(part or "").strip())

    newbie_request_status = session.get("newbie_shift_request_status") or NEWBIE_REQUEST_PENDING
    newbie_decision_by = session.get("newbie_shift_admin_decision_by") or ""
    newbie_decision_at = session.get("newbie_shift_admin_decision_at") or ""
    if session.get("newbie_shift_request_id") and not _is_newbie_shift_approval_required():
        if newbie_request_status == NEWBIE_REQUEST_PENDING:
            newbie_request_status = "approved"
            if not newbie_decision_by:
                newbie_decision_by = NEWBIE_REQUEST_POLICY_APPROVED_ACTOR
            if not newbie_decision_at:
                newbie_decision_at = session.get("newbie_shift_request_created_at") or datetime.now(timezone.utc).isoformat()

    return [
        session_id,
        candidate_name,
        first,
        last_initial,
        session.get("tester_name") or "",
        "sup_transfer_only" if session.get("supervisor_only") else "mock_session",
        attempt_number,
        _shared_bool(session.get("final_attempt")),
        shared_status,
        created_at,
        completed_at,
        _count_completed(session, "call", 3),
        _count_completed(session, "sup_transfer", 2),
        (session.get("call_1") or {}).get("result") or "",
        (session.get("call_2") or {}).get("result") or "",
        (session.get("call_3") or {}).get("result") or "",
        (session.get("sup_transfer_1") or {}).get("result") or "",
        (session.get("sup_transfer_2") or {}).get("result") or "",
        session.get("coaching_summary") or "",
        session.get("fail_summary") or "",
        review_notes,
        _shared_bool(needs_sup),
        pending_id,
        _shared_bool(session.get("withdrawn") or shared_status == "WITHDREW FROM CERTIFICATION"),
        session.get("withdrawn_at") or "",
        _shared_bool(session.get("extra_attempt_granted")),
        session.get("extra_attempt_reason") or "",
        _shared_retention_until(shared_status, session),
        _shared_bool(False),
        _shared_optional_bool(session.get("headset_usb")),
        _shared_optional_bool(session.get("noise_cancel")),
        session.get("headset_brand") or "",
        _shared_optional_bool(session.get("vpn_on")),
        _shared_optional_bool(session.get("vpn_off")),
        _shared_optional_bool(session.get("chrome_default")),
        _shared_optional_bool(session.get("extensions_disabled")),
        _shared_optional_bool(session.get("popups_allowed")),
        ", ".join(session.get("skills") or []) if isinstance(session.get("skills"), list) else session.get("skills") or "",
        _final_notes_field(session, "strengths"),
        _final_notes_field(session, "needsCoaching"),
        _final_notes_field(session, "other"),
        _shared_bool((session.get("finalEvaluatorNotes") or {}).get("historyOnly", False)),
        _get_evaluator_notes_summary(session),
        (session.get("finalEvaluatorNotes") or {}).get("createdAt") or "",
        *_readiness_tracking_values(session),
        session.get("form_fill_status") or FORM_FILL_NOT_ATTEMPTED,
        session.get("form_filled_at") or "",
        session.get("newbie_shift_scheduled_at") or "",
        session.get("newbie_shift_timezone") or "",
        session.get("newbie_shift_request_id") or "",
        session.get("newbie_shift_request_type") or NEWBIE_REQUEST_INITIAL,
        newbie_request_status,
        session.get("newbie_shift_requested_by") or "",
        session.get("newbie_shift_request_reason") or "",
        session.get("newbie_shift_request_details") or "",
        session.get("newbie_shift_request_created_at") or "",
        session.get("newbie_shift_original_scheduled_at") or "",
        session.get("newbie_shift_rescheduled_at") or "",
        _shared_bool(session.get("newbie_shift_within_24_hours")),
        _shared_bool(session.get("newbie_shift_counts_as_attempt")),
        newbie_decision_at,
        newbie_decision_by,
        session.get("newbie_shift_denial_reason") or "",
        session.get("deletion_request_id") or "",
        session.get("deletion_request_status") or "",
        session.get("deletion_request_created_at") or "",
        session.get("extra_attempts_granted") or "",
        session.get("allowed_attempt_count") or "",
        session.get("current_attempt_number") or attempt_number,
        session.get("extra_attempt_last_action_id") or "",
        session.get("extra_attempt_granted_by") or "",
        session.get("extra_attempt_granted_at") or "",
        session.get("readiness_override_by") or "",
        session.get("readiness_override_at") or "",
        session.get("newbie_shift_number") or "",
    ], pending_id, needs_sup


def _pending_sup_transfer_row(session, pending_id, existing_row=None, completed=False):
    session = _session_with_workflow_defaults(session)
    status = compute_final_status(session)
    candidate_name = str(session.get("candidate_name") or session.get("candidate") or "").strip()
    first, last_initial = _split_candidate_name(candidate_name)
    original_session_id = str(session.get("resume_source_history_id") or session.get("history_id") or "").strip()
    if not original_session_id:
        original_session_id = str(session.get("session_id") or "").strip()
    if not original_session_id:
        original_session_id = str(uuid.uuid4())
    is_completed = completed or _shared_status(status) in {"PASS", "FAIL", "FAIL-Final Attempt", "RESUMED-PASS"}
    pending_status = "pending"
    if is_completed:
        pending_status = "completed" if status in {"Pass", "RESUMED-PASS"} else "failed_final" if status == "FAIL-Final Attempt" else "completed"
    elif session.get("withdrawn"):
        pending_status = "withdrawn"
    elif session.get("resumed_sup_transfer_only") or session.get("shared_pending_sup_transfer"):
        pending_status = "resumed"
    created_at = (existing_row or {}).get("created_at") or session.get("timestamp_iso") or datetime.now(timezone.utc).isoformat()
    completed_at = datetime.now(timezone.utc).isoformat() if is_completed else ""
    notes = "\n\n".join(
        part for part in [
            session.get("coaching_summary") or "",
            session.get("fail_summary") or "",
            session.get("review_notes") or "",
        ]
        if str(part or "").strip()
    )
    return [
        pending_id,
        candidate_name,
        first,
        last_initial,
        session.get("resume_source_tester") or session.get("tester_name") or (existing_row or {}).get("original_tester_name") or "",
        original_session_id,
        created_at,
        pending_status,
        _shared_bool(session.get("final_attempt")),
        _mock_call_summary(session),
        (session.get("call_1") or {}).get("result") or "",
        (session.get("call_2") or {}).get("result") or "",
        (session.get("call_3") or {}).get("result") or "",
        "Mock calls passed; supervisor transfer still required.",
        session.get("tester_name") or "" if is_completed else "",
        completed_at,
        _shared_status(status) if is_completed else "",
        notes,
        _shared_optional_bool(session.get("headset_usb")),
        _shared_optional_bool(session.get("noise_cancel")),
        session.get("headset_brand") or "",
        _shared_optional_bool(session.get("vpn_on")),
        _shared_optional_bool(session.get("vpn_off")),
        _shared_optional_bool(session.get("chrome_default")),
        _shared_optional_bool(session.get("extensions_disabled")),
        _shared_optional_bool(session.get("popups_allowed")),
        ", ".join(session.get("skills") or []) if isinstance(session.get("skills"), list) else session.get("skills") or "",
        _final_notes_field(session, "strengths"),
        _final_notes_field(session, "needsCoaching"),
        _final_notes_field(session, "other"),
        _get_evaluator_notes_summary(session),
        *_readiness_tracking_values(session),
        session.get("form_fill_status") or FORM_FILL_NOT_ATTEMPTED,
        session.get("form_filled_at") or "",
        session.get("newbie_shift_scheduled_at") or "",
        session.get("newbie_shift_timezone") or "",
        session.get("newbie_shift_request_id") or "",
        session.get("newbie_shift_request_type") or NEWBIE_REQUEST_INITIAL,
        session.get("newbie_shift_request_status") or NEWBIE_REQUEST_PENDING,
        session.get("newbie_shift_requested_by") or "",
        session.get("newbie_shift_request_reason") or "",
        session.get("newbie_shift_request_details") or "",
        session.get("newbie_shift_request_created_at") or "",
        session.get("newbie_shift_original_scheduled_at") or "",
        session.get("newbie_shift_rescheduled_at") or "",
        _shared_bool(session.get("newbie_shift_within_24_hours")),
        _shared_bool(session.get("newbie_shift_counts_as_attempt")),
        session.get("newbie_shift_number") or "",
    ]


def _newbie_shift_request_row(session):
    session = _apply_newbie_reschedule_attempt(_session_with_workflow_defaults(session))
    session_id = str(session.get("history_id") or session.get("resume_source_history_id") or session.get("session_id") or "").strip()
    if not session_id:
        session_id = str(uuid.uuid4())
    candidate_name = str(session.get("candidate_name") or session.get("candidate") or "").strip()
    first, last_initial = _split_candidate_name(candidate_name)
    request_id = str(session.get("newbie_shift_request_id") or f"newbie-{session_id}").strip()

    raw_status = session.get("newbie_shift_request_status")
    decision_by = session.get("newbie_shift_admin_decision_by") or ""
    decision_at = session.get("newbie_shift_admin_decision_at") or ""
    if not _is_newbie_shift_approval_required():
        if not raw_status or raw_status == NEWBIE_REQUEST_PENDING:
            raw_status = "approved"
            if not decision_by:
                decision_by = NEWBIE_REQUEST_POLICY_APPROVED_ACTOR
            if not decision_at:
                decision_at = session.get("newbie_shift_request_created_at") or datetime.now(timezone.utc).isoformat()
    else:
        raw_status = raw_status or NEWBIE_REQUEST_PENDING

    return [
        request_id,
        session_id,
        candidate_name,
        first,
        last_initial,
        session.get("tester_name") or "",
        session.get("newbie_shift_request_type") or NEWBIE_REQUEST_INITIAL,
        raw_status,
        session.get("newbie_shift_requested_by") or "",
        session.get("newbie_shift_request_reason") or "",
        session.get("newbie_shift_request_details") or "",
        session.get("newbie_shift_request_created_at") or "",
        session.get("newbie_shift_original_scheduled_at") or "",
        session.get("newbie_shift_rescheduled_at") or "",
        session.get("newbie_shift_scheduled_at") or "",
        session.get("newbie_shift_timezone") or "",
        _shared_bool(session.get("newbie_shift_within_24_hours")),
        _shared_bool(session.get("newbie_shift_counts_as_attempt")),
        _shared_bool(session.get("final_attempt")),
        decision_at,
        decision_by,
        session.get("newbie_shift_denial_reason") or "",
        session.get("newbie_shift_request_updated_at") or "",
        session.get("newbie_shift_lead_time_seconds") if session.get("newbie_shift_lead_time_seconds") is not None else "",
        session.get("newbie_shift_lead_time_category") or "",
        session.get("newbie_shift_current_attempt") or 1,
        session.get("newbie_shift_resulting_attempt") or 1,
        _shared_bool(session.get("newbie_shift_becomes_final_attempt")),
        session.get("newbie_shift_attempt_rule") or "",
        session.get("newbie_shift_terminal_outcome") or "",
        session.get("newbie_shift_number") or "",
    ], request_id


def _newbie_request_submission_fingerprint(session):
    keys = (
        "newbie_shift_request_id",
        "history_id",
        "resume_source_history_id",
        "session_id",
        "newbie_shift_request_type",
        "newbie_shift_requested_by",
        "newbie_shift_request_reason",
        "newbie_shift_request_details",
        "newbie_shift_request_created_at",
        "newbie_shift_original_scheduled_at",
        "newbie_shift_rescheduled_at",
        "newbie_shift_scheduled_at",
        "newbie_shift_timezone",
        "newbie_shift_number",
        "newbie_shift_lead_time_seconds",
        "newbie_shift_current_attempt",
        "newbie_shift_resulting_attempt",
        "newbie_shift_counts_as_attempt",
        "final_attempt",
        "newbie_shift_terminal_outcome",
    )
    encoded = json.dumps({
        key: "" if (session or {}).get(key) is None else (session or {}).get(key)
        for key in keys
    }, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _validate_newbie_reschedule_submission(session):
    source = _apply_newbie_reschedule_attempt(session)
    if not str(source.get("newbie_shift_request_id") or "").strip():
        return "missing_session_identity"
    if not any(str(source.get(key) or "").strip() for key in ("history_id", "resume_source_history_id", "session_id")):
        return "missing_session_identity"
    if not str(source.get("newbie_shift_request_reason") or "").strip():
        return "validation_failed"
    if calculate_newbie_reschedule_attempt(source).get("validation_error"):
        return "invalid_schedule"
    if not _aware_iso_datetime(source.get("newbie_shift_rescheduled_at") or source.get("newbie_shift_scheduled_at")):
        return "invalid_schedule"
    return ""


def _newbie_request_error_message(error_code):
    messages = {
        "authorization_failed": "The reschedule service could not verify this app. Contact an administrator.",
        "forbidden_action": "This app is not allowed to submit reschedule requests. Contact an administrator.",
        "unsupported_action": "The reschedule service needs an administrator update before requests can be submitted.",
        "validation_failed": "We couldn’t submit the reschedule because required scheduling information is missing. Review the date, time, requester, and reason.",
        "missing_session_identity": "We couldn’t submit the reschedule because the source session could not be identified. Return to History and start the reschedule again.",
        "invalid_schedule": "We couldn’t submit the reschedule because the original or requested schedule is invalid. Review the date, time, and timezone.",
        "duplicate_request": "This reschedule request has already been submitted and is waiting for review.",
        "already_resolved": "This reschedule request has already been reviewed. Refresh to see the latest status.",
        "transport_timeout": "The reschedule could not be submitted right now. Your information was saved. Try again.",
        "remote_unavailable": "The reschedule could not be submitted right now. Your information was saved. Try again.",
        "response_shape_error": "The reschedule service returned an unexpected response. Your information was saved. Try again or contact an administrator.",
        "persistence_failed": "The reschedule information could not be saved locally. Try again.",
    }
    return messages.get(error_code, messages["remote_unavailable"])


def _classify_newbie_request_exception(exc):
    text = str(exc or "").strip().lower()
    if "unauthorized" in text or "authorization" in text or "401" in text:
        return "authorization_failed"
    if "forbidden" in text or "403" in text:
        return "forbidden_action"
    if "unknown action" in text or "unsupported" in text:
        return "unsupported_action"
    if "already" in text and any(token in text for token in ("resolved", "approved", "denied")):
        return "already_resolved"
    if "timeout" in text or "timed out" in text or "lock" in text or "busy" in text:
        return "transport_timeout"
    if "incomplete" in text or "required" in text or "invalid" in text:
        return "validation_failed"
    return "remote_unavailable"


def _candidate_deletion_request_row(record, request_id):
    record = _session_with_workflow_defaults(record)
    session_id = str(record.get("history_id") or record.get("resume_source_history_id") or "").strip()
    candidate_name = str(record.get("candidate_name") or record.get("candidate") or "").strip()
    first, last_initial = _split_candidate_name(candidate_name)
    completed_at = str(record.get("completed_at") or record.get("timestamp_iso") or record.get("timestamp") or "").strip()
    audit_parts = [
        f"status={record.get('status') or record.get('final_status') or ''}",
        f"final_attempt={_shared_bool(record.get('final_attempt'))}",
        f"form_fill_status={record.get('form_fill_status') or FORM_FILL_NOT_ATTEMPTED}",
    ]
    return [
        request_id,
        session_id,
        candidate_name,
        first,
        last_initial,
        record.get("tester_name") or "",
        record.get("deletion_request_created_at") or datetime.now(timezone.utc).isoformat(),
        record.get("deletion_request_status") or DELETION_REQUEST_PENDING,
        _shared_bool(True),
        record.get("deletion_request_reason") or "Trainer requested local history deletion plus SAM candidate-list review.",
        record.get("status") or record.get("final_status") or "",
        completed_at,
        "; ".join(audit_parts),
        record.get("admin_decision_at") or "",
        record.get("admin_decision_by") or "",
        record.get("denial_reason") or "",
    ]


def _sync_newbie_shift_request(session, sheets_api, sheet_id, existing_rows=None):
    session = _session_with_workflow_defaults(session)
    if not session.get("newbie_shift_request_id"):
        return ""
    if existing_rows is None:
        existing_rows = _shared_read_rows(
            sheets_api,
            sheet_id,
            SHARED_NEWBIE_SHIFT_REQUESTS_TAB,
            SHARED_NEWBIE_SHIFT_REQUEST_HEADERS,
        )
    existing = _find_request_row(existing_rows, session.get("newbie_shift_request_id"))
    if existing:
        existing_status = _normalize_newbie_request_status(existing.get("request_status") or existing.get("status"))
        if existing_status in {"approved", "denied"}:
            return "already_resolved"
        session, _changed, _reason = _reconcile_local_newbie_request_record(session, existing)
    row_values, request_id = _newbie_shift_request_row(session)
    return _shared_update_or_append_row(
        sheets_api,
        sheet_id,
        SHARED_NEWBIE_SHIFT_REQUESTS_TAB,
        SHARED_NEWBIE_SHIFT_REQUEST_HEADERS,
        "request_id",
        request_id,
        row_values,
    )


def _sync_newbie_shift_request_only(session):
    """Upsert one Newbie Shift request without changing Candidate Tracking."""
    session = _apply_newbie_reschedule_attempt(_session_with_workflow_defaults(session))
    validation_error = _validate_newbie_reschedule_submission(session)
    if validation_error:
        logger.warning("[NEWBIE REQUEST] Request rejected category=%s", validation_error)
        return {"ok": False, "errorCode": validation_error, "error": _newbie_request_error_message(validation_error)}
    fingerprint = _newbie_request_submission_fingerprint(session)
    if (
        str(session.get("newbie_shift_request_confirmed_at") or "").strip()
        and hmac.compare_digest(
            str(session.get("newbie_shift_request_submission_fingerprint") or ""),
            fingerprint,
        )
    ):
        return {"ok": True, "action": "already_confirmed", "requestId": session.get("newbie_shift_request_id"), "fingerprint": fingerprint}
    context = _shared_sheet_context()
    if not context.get("ok"):
        error_code = "remote_unavailable"
        logger.warning("[NEWBIE REQUEST] Request upsert unavailable category=%s", error_code)
        return {"ok": False, "errorCode": error_code, "error": _newbie_request_error_message(error_code)}
    try:
        if context.get("appsScriptClient"):
            row_values, _request_id = _newbie_shift_request_row(session)
            request_row = dict(zip(SHARED_NEWBIE_SHIFT_REQUEST_HEADERS, row_values))
            request_row["source_session_id"] = request_row.pop("session_id", "")
            request_row["request_type"] = (
                "newbie_shift_reschedule"
                if request_row.get("request_type") == NEWBIE_REQUEST_RESCHEDULE
                else "initial_newbie_shift"
            )
            result = context["appsScriptClient"].post("upsertPendingRequest", {"request": request_row})
            if not isinstance(result, dict):
                error_code = "response_shape_error"
                return {"ok": False, "errorCode": error_code, "error": _newbie_request_error_message(error_code)}
            returned_id = str(result.get("request_id") or "").strip()
            if returned_id and returned_id != str(session.get("newbie_shift_request_id") or "").strip():
                error_code = "response_shape_error"
                return {"ok": False, "errorCode": error_code, "error": _newbie_request_error_message(error_code)}
            returned_status = str(result.get("status") or result.get("request_status") or "pending").strip().lower()
            if returned_status in {"approved", "denied"}:
                error_code = "already_resolved"
                return {"ok": False, "errorCode": error_code, "error": _newbie_request_error_message(error_code)}
            action = str(result.get("action") or "").strip().lower()
            if action not in {"created", "updated"}:
                error_code = "response_shape_error"
                return {"ok": False, "errorCode": error_code, "error": _newbie_request_error_message(error_code)}
            return {
                "ok": True,
                "action": action,
                "alreadyPending": action == "updated",
                "requestId": session.get("newbie_shift_request_id"),
                "fingerprint": fingerprint,
            }
        sheets_api = context["service"].spreadsheets()
        sheet_id = context["sheet_id"]
        action = _sync_newbie_shift_request(session, sheets_api, sheet_id)
        if action == "already_resolved":
            error_code = "already_resolved"
            return {"ok": False, "errorCode": error_code, "error": _newbie_request_error_message(error_code)}
        if action not in {"appended", "updated", "created"}:
            error_code = "response_shape_error"
            return {"ok": False, "errorCode": error_code, "error": _newbie_request_error_message(error_code)}
        return {
            "ok": True,
            "action": action,
            "alreadyPending": action == "updated",
            "requestId": session.get("newbie_shift_request_id"),
            "fingerprint": fingerprint,
        }
    except Exception as exc:
        error_code = _classify_newbie_request_exception(exc)
        logger.warning(
            "[NEWBIE REQUEST] Request upsert failed category=%s error_type=%s",
            error_code,
            type(exc).__name__,
        )
        return {"ok": False, "errorCode": error_code, "error": _newbie_request_error_message(error_code)}


def _trigger_candidate_lifecycle_dual_write(session, candidate_action):
    try:
        if not is_dual_write_enabled():
            return
        dm = get_dual_write_manager()
        candidate_name = str(session.get("candidate_name") or session.get("candidate") or "").strip()
        if not candidate_name:
            return
        first, last_initial = _split_candidate_name(candidate_name)
        session_id = _candidate_session_identity(session) or str(session.get("session_id") or "").strip()
        if not session_id:
            return

        is_new = candidate_action == "appended"
        source_cand_id = str(session.get("candidate_id") or f"cand-{candidate_name.lower().replace(' ', '-')}").strip()

        candidate_payload = {
            "source_candidate_id": source_cand_id,
            "display_name": candidate_name,
            "first_name": first,
            "last_initial": last_initial,
            "is_new": is_new,
        }

        status = compute_final_status(session)
        shared_status = _shared_status(status)

        session_payload = {
            "session_id": session_id,
            "candidate_name": candidate_name,
            "candidate_first_name": first,
            "candidate_last_initial": last_initial,
            "tester_name": session.get("tester_name") or "",
            "session_type": "sup_transfer_only" if session.get("supervisor_only") else "mock_session",
            "status": shared_status,
            "final_result": session.get("final_result") or shared_status,
            "attempt_number": session.get("attempt_number") or 1,
            "created_at": str(session.get("timestamp_iso") or session.get("created_at") or datetime.now(timezone.utc).isoformat()),
            "completed_at": str(session.get("completed_at") or session.get("timestamp_iso") or datetime.now(timezone.utc).isoformat()),
            "is_new": is_new,
            **session,
        }

        # Collect all completed call attempts
        call_results = [
            (1, (session.get("call_1") or {}).get("result") or session.get("call_1_result")),
            (2, (session.get("call_2") or {}).get("result") or session.get("call_2_result")),
            (3, (session.get("call_3") or {}).get("result") or session.get("call_3_result")),
        ]
        valid_calls = [(num, res) for num, res in call_results if res not in (None, "")]
        if not valid_calls:
            attempt_number = session.get("attempt_number") or session.get("current_attempt_number") or 1
            valid_calls = [(attempt_number, session.get("final_result") or shared_status or "Pass")]

        first_num, first_res = valid_calls[0]
        attempt_payload = {
            "source_action_id": f"google_sheets:attempt:{session_id}:{first_num}",
            "session_id": session_id,
            "attempt_number": first_num,
            "result": first_res,
            "occurred_at": str(session.get("completed_at") or session.get("created_at") or datetime.now(timezone.utc).isoformat()),
            "details": session,
        }

        wf_res = dm.execute_candidate_lifecycle_workflow(
            candidate_payload=candidate_payload,
            candidate_authoritative_write_fn=lambda: {"ok": True},
            session_payload=session_payload,
            session_authoritative_write_fn=lambda: {"ok": True},
            attempt_payload=attempt_payload,
            attempt_authoritative_write_fn=lambda: {"ok": True},
            actor=session.get("tester_name") or "MTS",
        )

        sess_row_id = getattr(wf_res.get("session_mirror_result"), "persisted_row_id", None)
        for num, res in valid_calls[1:]:
            dm.execute_dual_write(
                domain="session_attempts",
                mutation_type="create",
                authoritative_payload={
                    "source_action_id": f"google_sheets:attempt:{session_id}:{num}",
                    "session_id": sess_row_id or session_id,
                    "session_uuid": sess_row_id,
                    "attempt_number": num,
                    "result": res,
                    "occurred_at": str(session.get("completed_at") or session.get("created_at") or datetime.now(timezone.utc).isoformat()),
                    "details": session,
                },
                authoritative_write_fn=lambda: {"ok": True},
                actor=session.get("tester_name") or "MTS",
            )
    except Exception as exc:
        logger.warning("[DUAL-WRITE] Candidate lifecycle dual-write hook error: %s", exc)


def _sync_shared_candidate_tracking(session):
    context = _shared_sheet_context()
    if not context.get("ok"):
        logger.warning("[SHARED] Candidate tracking unavailable: %s Required setup: %s", context.get("error"), context.get("setup"))
        return {"ok": False, "error": context.get("error"), "setup": context.get("setup")}

    current_operation = "initialize"
    try:
        request_snapshot = _remote_newbie_request_snapshot()
        if request_snapshot.get("ok"):
            session, _changed, _reason = _reconcile_record_with_remote_requests(
                session,
                request_snapshot.get("requests") or [],
            )
        apps_script_client = context.get("appsScriptClient")
        if apps_script_client:
            candidate_values, pending_id, needs_sup = _candidate_session_row(session, [])
            candidate_row = dict(zip(SHARED_CANDIDATE_SESSION_HEADERS, candidate_values))
            candidate_payload = {"candidateRow": candidate_row}
            if needs_sup or session.get("shared_pending_sup_transfer") or session.get("pending_sup_transfer_id"):
                pending_id = pending_id or str(
                    session.get("pending_sup_transfer_id")
                    or f"pending-{candidate_row.get('session_id') or uuid.uuid4()}"
                )
                pending_values = _pending_sup_transfer_row(
                    session,
                    pending_id,
                    completed=not needs_sup,
                )
                candidate_payload["pendingRow"] = dict(
                    zip(SHARED_PENDING_SUP_TRANSFER_HEADERS, pending_values)
                )
            result = apps_script_client.post("updateCandidateTracking", candidate_payload)
            newbie_action = ""
            if session.get("newbie_shift_request_id"):
                row_values, request_id = _newbie_shift_request_row(session)
                request = dict(zip(SHARED_NEWBIE_SHIFT_REQUEST_HEADERS, row_values))
                request["source_session_id"] = request.pop("session_id", "")
                request["request_type"] = "newbie_shift_reschedule" if request.get("request_type") == NEWBIE_REQUEST_RESCHEDULE else "initial_newbie_shift"
                newbie_action = apps_script_client.post("upsertPendingRequest", {"request": request})
            response = result if isinstance(result, dict) else {}
            candidate_action = response.get("candidateAction") or "updated"
            _trigger_candidate_lifecycle_dual_write(session, candidate_action)
            return {
                "ok": True,
                "candidateAction": candidate_action,
                "pendingAction": response.get("pendingAction") or "",
                "newbieRequestAction": newbie_action,
                **response,
            }
        sheets_api = context["service"].spreadsheets()
        sheet_id = context["sheet_id"]
        current_operation = "read_candidate_rows"
        candidate_rows = _shared_read_rows(
            sheets_api,
            sheet_id,
            SHARED_CANDIDATE_SESSIONS_TAB,
            SHARED_CANDIDATE_SESSION_HEADERS,
        )
        current_operation = "read_newbie_request_rows"
        newbie_request_rows = _shared_read_rows(
            sheets_api,
            sheet_id,
            SHARED_NEWBIE_SHIFT_REQUESTS_TAB,
            SHARED_NEWBIE_SHIFT_REQUEST_HEADERS,
        )
        session, _changed, _reason = _reconcile_record_with_remote_requests(
            session,
            [
                normalized
                for normalized in (_canonical_remote_newbie_request(row) for row in newbie_request_rows)
                if normalized
            ],
        )
        candidate_session_id = str(
            session.get("history_id") or session.get("resume_source_history_id") or session.get("session_id") or ""
        ).strip()
        existing_candidate = next(
            (
                row for row in candidate_rows
                if candidate_session_id and str(row.get("session_id") or "").strip() == candidate_session_id
            ),
            None,
        )
        if existing_candidate:
            existing_remote = _candidate_row_remote_newbie_request(existing_candidate)
            if existing_remote:
                session, _changed, _reason = _reconcile_local_newbie_request_record(session, existing_remote)
        row_values, pending_id, needs_sup = _candidate_session_row(session, candidate_rows)
        session_id = row_values[0]
        current_operation = "candidate_update_or_append"
        candidate_action = _shared_update_or_append_row(
            sheets_api,
            sheet_id,
            SHARED_CANDIDATE_SESSIONS_TAB,
            SHARED_CANDIDATE_SESSION_HEADERS,
            "session_id",
            session_id,
            row_values,
        )

        pending_action = ""
        if needs_sup or session.get("shared_pending_sup_transfer") or session.get("pending_sup_transfer_id"):
            pending_id = pending_id or str(session.get("pending_sup_transfer_id") or f"pending-{session_id}")
            current_operation = "read_pending_rows"
            pending_rows = _shared_read_rows(
                sheets_api,
                sheet_id,
                SHARED_PENDING_SUP_TRANSFERS_TAB,
                SHARED_PENDING_SUP_TRANSFER_HEADERS,
            )
            existing_pending = next((row for row in pending_rows if row.get("pending_id") == pending_id), None)
            pending_row = _pending_sup_transfer_row(
                session,
                pending_id,
                existing_pending,
                completed=not needs_sup,
            )
            current_operation = "pending_update_or_append"
            pending_action = _shared_update_or_append_row(
                sheets_api,
                sheet_id,
                SHARED_PENDING_SUP_TRANSFERS_TAB,
                SHARED_PENDING_SUP_TRANSFER_HEADERS,
                "pending_id",
                pending_id,
                pending_row,
            )

        newbie_request_action = _sync_newbie_shift_request(
            session,
            sheets_api,
            sheet_id,
            existing_rows=newbie_request_rows,
        )

        _trigger_candidate_lifecycle_dual_write(session, candidate_action)
        return {"ok": True, "candidateAction": candidate_action, "pendingAction": pending_action, "newbieRequestAction": newbie_request_action}
    except Exception as exc:
        reason = _shared_permission_hint(exc)
        logger.exception("[SHARED] Failed to sync candidate tracking during %s. reason=%s error=%s", current_operation, reason, exc)
        return {
            "ok": False,
            "failedOperation": current_operation,
            "reason": reason,
            "sheetId": context.get("sheet_id"),
            "serviceAccountEmail": context.get("serviceAccountEmail") or _get_service_account_email(),
            "permissionNeeded": _sheet_permission_needed(current_operation),
            "error": f"Shared candidate tracking sync failed during {current_operation}: {_google_sheet_error_message(exc)}",
            "setup": _shared_tracking_required_setup(),
        }


def _normalize_shared_row(row):
    cleaned = {k: v for k, v in (row or {}).items() if not str(k).startswith("_")}
    for key, value in list(cleaned.items()):
        if isinstance(value, str) and value.upper() in {"TRUE", "FALSE"}:
            cleaned[key] = value.upper() == "TRUE"
    return cleaned


def _shared_candidate_match_score(query, candidate):
    query = " ".join(str(query or "").lower().split())
    candidate = " ".join(str(candidate or "").lower().split())
    if not query or not candidate:
        return 0
    if query == candidate:
        return 100
    query_parts = query.split()
    candidate_parts = candidate.split()
    if len(query_parts) >= 2:
        first_ok = candidate_parts and candidate_parts[0].startswith(query_parts[0])
        last_ok = len(candidate_parts) > 1 and candidate_parts[-1].startswith(query_parts[-1])
        if first_ok and last_ok:
            return 90 if len(query_parts[-1]) >= 2 else 75
        if all(any(part.startswith(qp) for part in candidate_parts) for qp in query_parts):
            return 80
    if candidate.startswith(query) and len(query) >= 3:
        return 65
    if query in candidate and len(query) >= 3:
        return 50
    return 0


def _shared_status_upper(row):
    return str((row or {}).get("status") or (row or {}).get("final_status") or "").strip().upper()


def _shared_row_date(row):
    value = str((row or {}).get("completed_at") or (row or {}).get("created_at") or (row or {}).get("displayDate") or "").strip()
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _shared_candidate_suggestion_visible(row, now=None):
    now = now or datetime.now(timezone.utc)
    row_dt = _shared_row_date(row)
    if not row_dt:
        return True
    if row_dt.tzinfo is None:
        row_dt = row_dt.replace(tzinfo=timezone.utc)
    age_days = max(0, (now - row_dt).days)
    status = _shared_status_upper(row)
    extra_attempt = _candidate_row_extra_attempt(row)
    if _candidate_row_withdrawn(row):
        return age_days <= 10
    if status in {"PASS", "RESUMED-PASS"}:
        return age_days <= 10
    if status == "FAIL-FINAL ATTEMPT" and not extra_attempt:
        return age_days <= 10
    if extra_attempt:
        return age_days <= 30
    return age_days <= 30


def _latest_shared_candidate_rows(rows):
    latest = {}
    for row in rows or []:
        key = " ".join(str(row.get("candidate_name") or "").lower().split())
        if not key:
            continue
        current = latest.get(key)
        if not current:
            latest[key] = row
            continue
        current_date = _shared_row_date(current)
        row_date = _shared_row_date(row)
        current_ts = current_date.timestamp() if current_date else 0
        row_ts = row_date.timestamp() if row_date else 0
        if row_ts >= current_ts:
            latest[key] = row
    return list(latest.values())


TERMINAL_PENDING_SUP_STATUSES = {
    "PASS",
    "PASSED",
    "PASSED CERTIFICATION",
    "RESUMED-PASS",
    "RESUMED PASS",
    "ARCHIVED",
    "WITHDREW FROM CERTIFICATION",
    "WITHDRAWN",
    "FAIL-FINAL ATTEMPT",
    "FAILED FINAL ATTEMPT",
    "FAILED CERTIFICATION",
    "NC/NS",
    "STOPPED RESPONDING",
}


def _shared_pending_terminal_status(row):
    status = str(
        (row or {}).get("latest_status")
        or (row or {}).get("final_result")
        or (row or {}).get("final_status")
        or (row or {}).get("status")
        or ""
    ).strip().upper()
    return status in TERMINAL_PENDING_SUP_STATUSES or _candidate_row_withdrawn(row) or _shared_truthy((row or {}).get("archived"))


def _filter_current_pending_sup_transfers(pending_rows, candidate_rows):
    latest_candidates = {
        _candidate_name_key(row.get("candidate_name")): row
        for row in _latest_shared_candidate_rows(candidate_rows or [])
        if _candidate_name_key(row.get("candidate_name"))
    }
    active_pending = [
        row for row in (pending_rows or [])
        if str(row.get("status") or "").strip().lower() in {"pending", "resumed"}
        and not _shared_pending_terminal_status(row)
    ]
    latest_pending = {
        _candidate_name_key(row.get("candidate_name")): row
        for row in _latest_shared_candidate_rows(active_pending)
        if _candidate_name_key(row.get("candidate_name"))
    }
    filtered = []
    for key, row in latest_pending.items():
        latest = latest_candidates.get(key)
        if latest:
            if _shared_pending_terminal_status(latest):
                continue
            if not _shared_truthy(latest.get("needs_sup_transfer")):
                continue
            latest_pending_id = str(latest.get("pending_sup_transfer_id") or "").strip()
            row_pending_id = str(row.get("pending_id") or row.get("pending_sup_transfer_id") or "").strip()
            if latest_pending_id and row_pending_id and latest_pending_id != row_pending_id:
                continue
        filtered.append(row)
    filtered.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return filtered


def _lookup_shared_candidate_sessions(candidate_name):
    query = " ".join(str(candidate_name or "").lower().split())
    if len(query) < 2:
        return {
            "ok": True,
            "matches": [],
            "finalAttempt": False,
            "finalAttemptUsed": False,
            "withdrawn": False,
            "extraAttemptGranted": False,
            "passedCertification": False,
            "qualifyingFailureCount": 0,
            "attemptState": calculate_candidate_attempt_state([]),
        }
    lookup_started = time.monotonic()
    logger.info("[SHARED] Candidate lookup started query_len=%d", len(query))
    if configured_provider_mode() == "supabase":
        try:
            provider = _get_active_data_provider()
            sessions_raw = provider.list_resource("candidate_sessions", limit=5000)
            rows = []
            for raw_row in sessions_raw or []:
                payload = dict(raw_row.get("source_payload") or {})
                for k, v in raw_row.items():
                    if k != "source_payload" and k not in payload:
                        payload[k] = v
                row = _normalize_shared_row(payload)
                row.update({
                    "candidate_name": str(row.get("candidate_name") or row.get("CandidateName") or row.get("Candidate Name") or "").strip(),
                    "status": str(row.get("status") or row.get("Status") or "").strip(),
                    "created_at": str(row.get("created_at") or row.get("Timestamp") or "").strip(),
                    "review_notes": str(row.get("review_notes") or row.get("Notes") or "").strip(),
                    "tester_name": str(row.get("tester_name") or row.get("UpdatedBy") or "").strip(),
                    "session_type": str(row.get("session_type") or row.get("SessionType") or row.get("Session Type") or "").strip(),
                    "attempt_number": str(row.get("attempt_number") or row.get("AttemptNumber") or row.get("Attempt Number") or "").strip(),
                    "final_attempt": str(row.get("final_attempt") or row.get("FinalAttempt") or row.get("Final Attempt") or "").strip(),
                    "completed_at": str(row.get("completed_at") or row.get("CompletedAt") or row.get("Completed At") or "").strip(),
                    "withdrawn": str(row.get("withdrawn") or row.get("Withdrawn") or "").strip(),
                    "extra_attempt_granted": str(row.get("extra_attempt_granted") or row.get("ExtraAttemptGranted") or row.get("Extra Attempt Granted") or "").strip(),
                    "archived": str(row.get("archived") or row.get("Archived") or "").strip(),
                })
                rows.append(row)
        except Exception as exc:
            logger.warning(
                "[SHARED] Candidate lookup failed query_len=%d duration_ms=%d error=%s",
                len(query),
                int((time.monotonic() - lookup_started) * 1000),
                exc,
            )
            return {"ok": False, "matches": [], "error": f"Shared candidate lookup unavailable: {exc}", "setup": _shared_tracking_required_setup()}
    else:
        try:
            context = _shared_sheet_context()
            if not context.get("ok"):
                logger.warning(
                    "[SHARED] Candidate lookup context unavailable query_len=%d error=%s",
                    len(query),
                    context.get("error"),
                )
                return {"ok": False, "matches": [], "error": context.get("error"), "setup": context.get("setup")}
            apps_script_client = context.get("appsScriptClient")
            if apps_script_client:
                rows = []
                for raw_row in _apps_script_rows(apps_script_client, "getCandidateTracking"):
                    row = _normalize_shared_row(raw_row)
                    row.update({
                        "candidate_name": str(row.get("candidate_name") or row.get("CandidateName") or row.get("Candidate Name") or "").strip(),
                        "status": str(row.get("status") or row.get("Status") or "").strip(),
                        "created_at": str(row.get("created_at") or row.get("Timestamp") or "").strip(),
                        "review_notes": str(row.get("review_notes") or row.get("Notes") or "").strip(),
                        "tester_name": str(row.get("tester_name") or row.get("UpdatedBy") or "").strip(),
                        "session_type": str(row.get("session_type") or row.get("SessionType") or row.get("Session Type") or "").strip(),
                        "attempt_number": str(row.get("attempt_number") or row.get("AttemptNumber") or row.get("Attempt Number") or "").strip(),
                        "final_attempt": str(row.get("final_attempt") or row.get("FinalAttempt") or row.get("Final Attempt") or "").strip(),
                        "completed_at": str(row.get("completed_at") or row.get("CompletedAt") or row.get("Completed At") or "").strip(),
                        "withdrawn": str(row.get("withdrawn") or row.get("Withdrawn") or "").strip(),
                        "extra_attempt_granted": str(row.get("extra_attempt_granted") or row.get("ExtraAttemptGranted") or row.get("Extra Attempt Granted") or "").strip(),
                        "archived": str(row.get("archived") or row.get("Archived") or "").strip(),
                    })
                    rows.append(row)
            else:
                sheets_api = context["service"].spreadsheets()
                rows = _shared_read_rows(sheets_api, context["sheet_id"], SHARED_CANDIDATE_SESSIONS_TAB, SHARED_CANDIDATE_SESSION_HEADERS)
        except Exception as exc:
            logger.warning(
                "[SHARED] Candidate lookup failed query_len=%d duration_ms=%d error=%s",
                len(query),
                int((time.monotonic() - lookup_started) * 1000),
                exc,
            )
            return {"ok": False, "matches": [], "error": f"Shared candidate lookup unavailable: {exc}", "setup": _shared_tracking_required_setup()}
    request_snapshot = _remote_newbie_request_snapshot()
    if request_snapshot.get("ok"):
        rows = [
            _reconcile_record_with_remote_requests(row, request_snapshot.get("requests") or [])[0]
            for row in rows
        ]
    matches = []
    for row in rows:
        candidate = " ".join(str(row.get("candidate_name") or "").lower().split())
        score = _shared_candidate_match_score(query, candidate)
        if score > 0:
            normalized = _normalize_shared_row(row)
            normalized["matchConfidence"] = score
            normalized["matchConfirmed"] = score >= 75
            normalized["displayDate"] = normalized.get("completed_at") or normalized.get("created_at") or ""
            matches.append(normalized)
    matches.sort(key=lambda row: (int(row.get("matchConfidence") or 0), str(row.get("completed_at") or row.get("created_at") or "")), reverse=True)
    active_matches = [row for row in matches if not _shared_truthy(row.get("archived"))]
    confirmed_matches = [row for row in active_matches if row.get("matchConfirmed")]
    attempt_state = calculate_candidate_attempt_state(confirmed_matches)
    qualifying_failures = attempt_state["counted_attempts"]
    final_attempt_used = attempt_state["terminal"] and attempt_state["reason"] == "final_attempt_exhausted"
    withdrawn = any(_candidate_row_withdrawn(row) or _shared_status_upper(row) == "WITHDREW FROM CERTIFICATION" for row in confirmed_matches)
    extra_attempt = any(_candidate_row_extra_attempt(row) for row in confirmed_matches)
    passed_certification = any(_shared_status_upper(row) in {"PASS", "PASSED", "RESUMED-PASS"} for row in confirmed_matches)
    visible_matches = _latest_shared_candidate_rows([row for row in active_matches if _shared_candidate_suggestion_visible(row)])
    visible_matches.sort(key=lambda row: (int(row.get("matchConfidence") or 0), str(row.get("completed_at") or row.get("created_at") or "")), reverse=True)
    logger.info(
        "[SHARED] Candidate lookup succeeded query_len=%d duration_ms=%d matches=%d visible=%d final_attempt=%s final_attempt_used=%s withdrawn=%s extra_attempt=%s",
        len(query),
        int((time.monotonic() - lookup_started) * 1000),
        len(matches),
        len(visible_matches),
        attempt_state["final_attempt"] and not attempt_state["terminal"],
        final_attempt_used and not extra_attempt,
        withdrawn,
        extra_attempt,
    )
    return {
        "ok": True,
        "matches": visible_matches[:20],
        "finalAttempt": attempt_state["final_attempt"] and not attempt_state["terminal"],
        "finalAttemptUsed": final_attempt_used and not extra_attempt,
        "qualifyingFailureCount": qualifying_failures,
        "attemptState": attempt_state,
        "withdrawn": withdrawn,
        "extraAttemptGranted": extra_attempt,
        "passedCertification": passed_certification and not extra_attempt,
    }


def _get_shared_pending_sup_transfers():
    if configured_provider_mode() == "supabase":
        try:
            provider = _get_active_data_provider()
            rows_raw = provider.list_resource("supervisor_transfers", limit=5000)
            candidate_raw = provider.list_resource("candidate_sessions", limit=5000)
            rows = []
            for r in rows_raw or []:
                payload = dict(r.get("source_payload") or {})
                for k, v in r.items():
                    if k != "source_payload" and k not in payload:
                        payload[k] = v
                rows.append(_normalize_shared_row(payload))
            candidate_rows = []
            for c in candidate_raw or []:
                payload = dict(c.get("source_payload") or {})
                for k, v in c.items():
                    if k != "source_payload" and k not in payload:
                        payload[k] = v
                candidate_rows.append(_normalize_shared_row(payload))
            items = _filter_current_pending_sup_transfers(rows, candidate_rows)
            return {"ok": True, "items": items}
        except Exception as exc:
            logger.warning("[SHARED] Pending supervisor transfer lookup unavailable from Supabase: %s", exc)
            return {"ok": False, "items": [], "error": f"Shared pending supervisor transfers unavailable: {exc}", "setup": _shared_tracking_required_setup()}

    try:
        context = _shared_sheet_context()
        if not context.get("ok"):
            return {"ok": False, "items": [], "error": context.get("error"), "setup": context.get("setup")}
        if context.get("appsScriptClient"):
            return {"ok": True, "items": []}
        sheets_api = context["service"].spreadsheets()
        rows = _shared_read_rows(sheets_api, context["sheet_id"], SHARED_PENDING_SUP_TRANSFERS_TAB, SHARED_PENDING_SUP_TRANSFER_HEADERS)
        candidate_rows = _shared_read_rows(sheets_api, context["sheet_id"], SHARED_CANDIDATE_SESSIONS_TAB, SHARED_CANDIDATE_SESSION_HEADERS)
    except Exception as exc:
        logger.warning("[SHARED] Pending supervisor transfer lookup unavailable; continuing local workflow: %s", exc)
        return {"ok": False, "items": [], "error": f"Shared pending supervisor transfers unavailable: {exc}", "setup": _shared_tracking_required_setup()}
    items = _filter_current_pending_sup_transfers(
        [_normalize_shared_row(row) for row in rows],
        [_normalize_shared_row(row) for row in candidate_rows],
    )
    return {"ok": True, "items": items}


# ══════════════════════════════════════════════════════════════════
# GEMINI SERVICE (summary generation)
# ══════════════════════════════════════════════════════════════════
SUMMARY_DISPLAY_LABELS_PATH = ROOT_DIR.parent / "frontend" / "src" / "utils" / "summaryDisplayLabels.json"


@lru_cache(maxsize=1)
def _summary_display_labels():
    try:
        with open(SUMMARY_DISPLAY_LABELS_PATH, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        if isinstance(loaded, dict):
            return {str(key): str(value) for key, value in loaded.items() if str(key or "").strip() and str(value or "").strip()}
    except Exception as exc:
        logger.warning("[SUMMARY] Unable to load summary display labels from %s: %s", SUMMARY_DISPLAY_LABELS_PATH, exc)
    return {}


def _normalize_summary_label_key(value):
    return re.sub(r"[\s_/\-]+", " ", str(value or "").strip().lower()).strip()


def _humanize_summary_label(value):
    raw = str(value or "").strip()
    if not raw:
        return ""
    labels = _summary_display_labels()
    if raw in labels:
        return labels[raw]
    normalized = _normalize_summary_label_key(raw)
    for key, label in labels.items():
        if _normalize_summary_label_key(key) == normalized:
            return label
    text = " ".join(raw.replace("_", " ").replace("/", " / ").split()).strip()
    preserved = {"ACD", "DTE", "VPN", "USB", "NC/NS", "EFT"}
    words = [
        part.upper() if part.upper() in preserved else part[:1].upper() + part[1:]
        for part in text.split()
    ]
    fallback = " ".join(words).strip()
    if fallback and not fallback.endswith("."):
        fallback = f"{fallback}."
    return fallback


def _summary_parent_label(value):
    raw = str(value or "").strip()
    if raw and raw in _summary_display_labels().values():
        return raw[:-1] if raw.endswith(".") else raw
    label = _humanize_summary_label(value).strip()
    return label[:-1] if label.endswith(".") else label


def _summary_child_sentence(value):
    raw = str(value or "").strip()
    if raw and raw in _summary_display_labels().values():
        return raw if raw.endswith(".") else f"{raw}."
    label = _humanize_summary_label(value).strip()
    return label if label.endswith(".") else f"{label}."


def _get_coaching_items(data):
    if not data:
        return []
    items = []
    coaching = data.get("coaching", {})
    for key, checked in coaching.items():
        if checked and "_" not in key and key != "Other":
            label = _summary_child_sentence(key)
            if label:
                items.append(label)
        elif checked and "_" in key:
            label = _summary_child_sentence(key)
            if label:
                items.append(label)
    notes = data.get("coach_notes", "")
    if coaching.get("Other") and str(notes or "").strip():
        items.append(notes)
    return items


def _get_fail_items(data):
    if not data or data.get("result") != "Fail":
        return []
    items = []
    fails = data.get("fails", {})
    fail_details = data.get("failReasonDetails") or data.get("fail_reason_details") or {}
    for key, checked in fails.items():
        if checked and key != "Other":
            detail = str(fail_details.get(key) or "").strip()
            label = _humanize_summary_label(key)
            if label:
                items.append(_format_fail_item_sentence(label, detail))
    notes = data.get("fail_notes", "")
    if notes:
        items.append(notes)
    return items


DISCORD_SCREENSHOT_SUMMARY_TEXT = (
    "Coaching was provided using the standard screenshots and Discord chat."
)

AUTO_FAIL_MESSAGES = {
    "nc/ns": "was a No Call / No Show. Session did not occur.",
    "stopped": "stopped responding in Discord during the session.",
    "vpn": "is using a VPN and was unable to turn it off.",
    "not ready": "was not ready for the session:",
}

AUTO_FAIL_HEADSET_KEYWORDS = ("usb", "noise")


def _resolve_auto_fail_message(name, auto_fail):
    """Map auto-fail reason to a human-readable sentence. Reduces nesting in build_clean_fail."""
    af = auto_fail.lower()
    for keyword, template in AUTO_FAIL_MESSAGES.items():
        if keyword in af:
            suffix = f" {auto_fail}" if template.endswith(":") else ""
            return f"{name} {template}{suffix}"
    if any(kw in af for kw in AUTO_FAIL_HEADSET_KEYWORDS):
        return f"{name} did not have a qualifying headset: {auto_fail}."
    return f"{name} - {auto_fail}."


def _collect_call_coaching_lines(session):
    """Gather coaching lines from call data."""
    lines = []
    for i in range(1, 4):
        call = session.get(f"call_{i}")
        if not call or not call.get("result"):
            continue
        coaching = _get_coaching_items(call)
        coaching_str = ", ".join(coaching) if coaching else "none noted"
        lines.append(f"Call {i} ({call.get('type', 'Unknown type')}): {call['result']}. Coaching: {coaching_str}.")
    return lines


def _collect_sup_coaching_lines(session):
    """Gather coaching lines from supervisor transfer data."""
    lines = []
    for i in range(1, 3):
        sup = session.get(f"sup_transfer_{i}")
        if not sup or not sup.get("result"):
            continue
        coaching = _get_coaching_items(sup)
        coaching_str = ", ".join(coaching) if coaching else "none noted"
        lines.append(f"Supervisor Transfer {i}: {sup['result']}. Coaching: {coaching_str}.")
    return lines


def _collect_fail_lines(session):
    """Gather fail reason lines from failed mock calls only."""
    lines = []
    for i in range(1, 4):
        call = session.get(f"call_{i}")
        if not call or call.get("result") != "Fail":
            continue
        reasons = _get_fail_items(call)
        reasons_str = ", ".join(reasons) if reasons else "unspecified"
        lines.append(f"Call {i} ({call.get('type', 'Unknown type')}) failed: {reasons_str}.")
    return lines


def _sentence_case(value):
    text = " ".join(str(value or "").replace("\n", " ").split()).strip(" .")
    if not text:
        return ""
    return text[0].upper() + text[1:]


def _looks_like_discord_screenshot_coaching(value):
    text = " ".join(str(value or "").replace("_", " ").replace("/", " ").split()).strip().lower()
    if not text:
        return False
    has_screenshot = "screenshot" in text
    has_discord_or_chat = "discord" in text or "chat" in text or "instruction" in text
    return has_screenshot and has_discord_or_chat


def _has_discord_screenshot_coaching(data):
    if not data:
        return False

    coaching = data.get("coaching", {})
    for key, checked in coaching.items():
        if checked and _looks_like_discord_screenshot_coaching(key):
            return True

    notes = data.get("coach_notes", "")
    return bool(coaching.get("Other") and _looks_like_discord_screenshot_coaching(notes))


def _dedupe_preserve_order(items):
    seen = set()
    result = []
    for item in items:
        normalized = " ".join(str(item or "").split()).strip().lower()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(str(item).strip())
    return result


def _format_management_list(items):
    cleaned = [_sentence_case(item) for item in items if _sentence_case(item)]
    if not cleaned:
        return ""
    if len(cleaned) == 1:
        return cleaned[0]
    if len(cleaned) == 2:
        return f"{cleaned[0]} and {cleaned[1]}"
    return f"{', '.join(cleaned[:-1])}, and {cleaned[-1]}"


SPECIAL_COACHING_GUIDANCE = (
    (
        "dont ask just verify address and phone number",
        (
            "Coaching was provided on verifying donor information. For an existing member "
            "who already gives the correct address and phone number to confirm the donor "
            "account, those details do not need to be asked again on the Call Info screen. "
            "The information still needs to be verified back to the caller, including the "
            "street-name spelling and phone type."
        ),
    ),
    (
        "phonetics table provided",
        "A phonetics table of the sound-alike letters was provided to the candidate for reference.",
    ),
    (
        "search name for every call",
        "Coaching was given on searching the caller's name on every call to help avoid creating duplicate member records.",
    ),
    (
        "do not volunteer information",
        "Coaching was given on avoiding verification of information the member has not yet provided, such as an email address.",
    ),
    (
        "use active listening and avoid repeating questions",
        "Coaching was provided on using active listening throughout the call and avoiding repeated questions the caller had already answered.",
    ),
    (
        "avoid interrupting or speaking over the caller",
        "Coaching was provided on allowing the caller to finish before responding and avoiding interruptions or speaking over the caller.",
    ),
    (
        "maintain a warm professional tone and use clear professional language",
        "Coaching was provided on maintaining a warm, professional tone and using clear, professional language throughout the call.",
    ),
)


def _normalize_coaching_item_key(value):
    text = str(value or "").lower().replace("'", "").replace("’", "")
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _get_special_coaching_guidance(item):
    normalized = _normalize_coaching_item_key(item)
    if not normalized:
        return ""
    for marker, guidance in SPECIAL_COACHING_GUIDANCE:
        if marker in normalized:
            return guidance
    return ""


def _extract_coaching_summary_parts(section):
    coaching = (section or {}).get("coaching", {}) or {}
    grouped = {}
    stable_top_level_keys = {
        "active_listening_no_repeat",
        "avoid_interrupting_caller",
        "warm_professional_tone_language",
    }

    for key, checked in coaching.items():
        if not checked or not key:
            continue
        if key == "Other":
            continue
        if key in stable_top_level_keys:
            parent = _summary_parent_label(key)
            if parent:
                grouped.setdefault(parent, [])
            continue
        if "_" in key:
            parent, child = key.split("_", 1)
            parent = _summary_parent_label(parent)
            child = _summary_child_sentence(key) or _summary_child_sentence(child)
            if not parent or not child:
                continue
            grouped.setdefault(parent, [])
            if child not in grouped[parent]:
                grouped[parent].append(child)
            continue
        parent = _summary_parent_label(key)
        if not parent:
            continue
        grouped.setdefault(parent, [])

    parts = []
    for parent, children in grouped.items():
        parent_text = _summary_parent_label(parent)
        child_values = [_summary_child_sentence(child) for child in children if _summary_child_sentence(child)]
        if child_values:
            parts.append(f"{parent_text}: {' '.join(child_values)}")
        else:
            parts.append(parent_text)
    return _reject_headset_like_summary_parts(parts, "coaching")


def _extract_fail_summary_parts(section):
    fails = (section or {}).get("fails", {}) or {}
    parts = []
    for key, checked in fails.items():
        if checked and key:
            label = _humanize_summary_label(key)
            if label:
                parts.append(label.rstrip("."))
    return _reject_headset_like_summary_parts(_dedupe_preserve_order(parts), "fail")


def _extract_fail_reason_details(section):
    details = (section or {}).get("failReasonDetails") or (section or {}).get("fail_reason_details") or {}
    if not isinstance(details, dict):
        return {}
    return {
        _humanize_summary_label(reason).rstrip("."): _normalize_notes_sentence(value)
        for reason, value in details.items()
        if _humanize_summary_label(reason) and _normalize_notes_sentence(value)
    }


def _format_fail_item_sentence(item, detail=""):
    label = str(item or "").strip().rstrip(".")
    detail_text = _normalize_notes_sentence(detail)
    if not label:
        return ""
    normalized = _normalize_summary_label_key(label)
    if detail_text and "paraphrased" in normalized and "script" in normalized:
        return f"Paraphrased the {detail_text} section of the script."
    if detail_text and "skipped" in normalized and "script" in normalized:
        return f"Skipped the {detail_text} section of the script."
    if detail_text:
        return f"{label}: {detail_text}."
    return f"{label}."


def _format_fail_reason_detail_lines(section):
    fail_items = [item for item in _extract_fail_summary_parts(section) if item != "Other"]
    fail_details = _extract_fail_reason_details(section)
    lines = []
    for item in fail_items:
        detail = fail_details.get(item)
        sentence = _format_fail_item_sentence(item, detail)
        if sentence:
            lines.append(f"Fail reason: {sentence}")
    return lines


def _reject_headset_like_summary_parts(parts, summary_type):
    if not parts:
        return []
    if _values_look_like_headsets(parts):
        logger.warning(
            "[SUMMARY] Rejected headset-like %s selections while building summaries.",
            summary_type,
        )
        return []
    return parts


def _normalize_notes_sentence(value):
    text = " ".join(str(value or "").replace("\n", " ").split()).strip()
    return text.rstrip(".")


def _collect_all_coaching_items(session):
    items = []
    for i in range(1, 4):
        items.extend(_get_coaching_items(session.get(f"call_{i}") or {}))
    for i in range(1, 3):
        items.extend(_get_coaching_items(session.get(f"sup_transfer_{i}") or {}))
    return _dedupe_preserve_order(items)


def _collect_all_fail_items(session):
    items = []
    for i in range(1, 4):
        items.extend(_get_fail_items(session.get(f"call_{i}") or {}))
    return _dedupe_preserve_order(items)


def _is_resumed_sup_transfer_session(session):
    return bool(
        session
        and session.get("supervisor_only")
        and (
            session.get("resumed_sup_transfer_only")
            or session.get("resume_source_history_id")
            or session.get("resume_source_timestamp_iso")
        )
    )


def _build_section_coaching_summary(section, label, include_fail_details=False):
    result = (section or {}).get("result")
    if result not in {"Pass", "Fail"}:
        return ""

    coaching = (section or {}).get("coaching", {}) or {}
    coaching_items = _extract_coaching_summary_parts(section)
    coaching_notes = _normalize_notes_sentence((section or {}).get("coach_notes", ""))
    has_discord_screenshot = _has_discord_screenshot_coaching(section)

    details = []
    if coaching_items:
        general_items = []
        special_guidance = []
        for item in coaching_items:
            if _looks_like_discord_screenshot_coaching(item):
                continue
            guidance = _get_special_coaching_guidance(item)
            if guidance:
                special_guidance.append(guidance)
            else:
                general_items.append(item)
        if general_items:
            details.append("Coaching addressed " + _format_management_list(general_items) + ".")
        details.extend(_dedupe_preserve_order(special_guidance))
    if has_discord_screenshot:
        details.append(DISCORD_SCREENSHOT_SUMMARY_TEXT)
    if coaching_notes and coaching.get("Other"):
        details.append(f"Coaching notes: {coaching_notes}.")
    if result == "Fail" and include_fail_details:
        fail_detail_lines = _format_fail_reason_detail_lines(section)
        fail_notes = _normalize_notes_sentence((section or {}).get("fail_notes", ""))
        if fail_detail_lines:
            details.extend(fail_detail_lines)
        fails = (section or {}).get("fails", {}) or {}
        if fail_notes and fails.get("Other"):
            details.append(f"Failed-call other notes: {fail_notes}.")

    if not details:
        if result == "Pass":
            return f"{label} - Pass - No additional coaching concerns documented."
        else:
            return f"{label} - Fail - No coaching items were selected for this portion of the session."

    return f"{label} - {result} - {' '.join(details)}"


def _build_section_fail_summary(section, label):
    if (section or {}).get("result") != "Fail":
        return ""

    fails = (section or {}).get("fails", {}) or {}
    fail_items = _extract_fail_summary_parts(section)
    fail_detail_lines = _format_fail_reason_detail_lines(section)
    fail_notes = _normalize_notes_sentence((section or {}).get("fail_notes", ""))
    details = []

    if fail_detail_lines:
        details.extend(fail_detail_lines)
    elif fail_items:
        details.append("Fail reasons: " + _format_management_list(fail_items) + ".")
    else:
        details.append("Fail reasons: N/A.")

    if fail_notes and fails.get("Other"):
        details.append(f"Fail notes: {fail_notes}.")

    return f"{label} - Fail - {' '.join(details)}"


def _has_tech_issue(session):
    val = str(session.get("tech_issue") or "").strip()
    return bool(val and val not in {"N/A", "No", "None"})


def _tech_issue_ended_session(session):
    return _shared_truthy((session or {}).get("tech_issue_ended_session"))


def _is_fail_na(session):
    """Return True unless the final session outcome requires a fail summary."""
    final_status = compute_final_status(session)
    return final_status not in {"Fail", "FAIL-Final Attempt", "NC/NS", FINAL_READINESS_NEEDS_RETEST}


def compute_calculated_status(session):
    auto_fail = session.get("auto_fail_reason")
    sup_only = session.get("supervisor_only", False)
    calls_passed = sum(1 for i in range(1, 4) if (session.get(f"call_{i}") or {}).get("result") == "Pass")
    calls_failed = sum(1 for i in range(1, 4) if (session.get(f"call_{i}") or {}).get("result") == "Fail")
    sups_passed = sum(1 for i in range(1, 3) if (session.get(f"sup_transfer_{i}") or {}).get("result") == "Pass")
    sups_failed = sum(1 for i in range(1, 3) if (session.get(f"sup_transfer_{i}") or {}).get("result") == "Fail")
    newbie = session.get("newbie_shift_data")
    final_attempt = bool(session.get("final_attempt"))
    resumed_sup = _is_resumed_sup_transfer_session(session)

    if _is_newbie_reschedule(session) and session.get("newbie_shift_terminal_outcome"):
        return str(session.get("newbie_shift_terminal_outcome"))

    if _is_newbie_reschedule(session) and session.get("newbie_shift_counts_as_attempt"):
        return "NC/NS"

    if auto_fail:
        auto_fail_text = str(auto_fail or "").strip().lower()
        if auto_fail_text.startswith("nc") or "same day drop" in auto_fail_text or "dropped the session within 24 hours" in auto_fail_text:
            return "NC/NS"
        return "FAIL-Final Attempt" if final_attempt else "Fail"

    if sup_only:
        if sups_passed >= 1:
            return "RESUMED-PASS" if resumed_sup else "Pass"
        if sups_failed >= 2:
            if session.get("supervisor_retry_required") and newbie is not None:
                return "Incomplete"
            return "FAIL-Final Attempt" if final_attempt else "Incomplete"
        if newbie is not None:
            return "Incomplete"
        return "Incomplete"

    if calls_passed >= 2:
        if sups_passed >= 1:
            return "Pass"
        if sups_failed >= 2:
            if session.get("supervisor_retry_required") and newbie is not None:
                return "Incomplete"
            return "FAIL-Final Attempt" if final_attempt else "Incomplete"
        if newbie is not None:
            return "Incomplete"
        return "Incomplete"

    if calls_failed >= 2:
        return "FAIL-Final Attempt" if final_attempt else "Fail"

    return "Incomplete"


def compute_final_status(session):
    if _readiness_override_applied(session):
        return str(_readiness_judgment(session).get("overrideResult") or "").strip()
    return compute_calculated_status(session)


def normalize_history_status(entry):
    explicit_status = entry.get("status")
    computed_status = compute_final_status(entry)
    if computed_status == "FAIL-Final Attempt":
        return "FAIL-Final Attempt"
    if explicit_status == "Incomplete" and computed_status in {"Pass", "RESUMED-PASS", "Fail", "NC/NS"}:
        return computed_status
    if explicit_status == "Fail" and entry.get("final_attempt"):
        return "FAIL-Final Attempt"
    if explicit_status == "Pass" and _is_resumed_sup_transfer_session(entry):
        return "RESUMED-PASS"
    if explicit_status in FINAL_READINESS_ALLOWED_RESULTS:
        return explicit_status

    explicit_final_status = entry.get("final_status")
    if explicit_final_status == "Fail" and entry.get("final_attempt"):
        return "FAIL-Final Attempt"
    if explicit_final_status == "Pass" and _is_resumed_sup_transfer_session(entry):
        return "RESUMED-PASS"
    if explicit_final_status in FINAL_READINESS_ALLOWED_RESULTS:
        return explicit_final_status

    if computed_status != "Fail":
        return computed_status

    if entry.get("auto_fail_reason"):
        auto_fail = (entry.get("auto_fail_reason") or "").strip().lower()
        if auto_fail.startswith("nc") or "same day drop" in auto_fail or "dropped the session within 24 hours" in auto_fail:
            return "NC/NS"
        return "Fail"

    call_fails = sum(1 for i in range(1, 4) if (entry.get(f"call_{i}") or {}).get("result") == "Fail")
    sup_fails = sum(1 for i in range(1, 3) if (entry.get(f"sup_transfer_{i}") or {}).get("result") == "Fail")
    sup_only = entry.get("supervisor_only", False)

    if call_fails >= 2:
        return "Fail"

    if sup_only and entry.get("final_attempt") and sup_fails >= 2:
        return "Fail"

    return "Incomplete"


def _format_local_history_timestamp(timestamp_dt):
    local_dt = timestamp_dt.astimezone()
    return {
        "timestamp": local_dt.strftime("%Y-%m-%d %I:%M %p"),
        "timestamp_iso": local_dt.isoformat(),
    }


def _normalize_history_timestamp(entry):
    timestamp_iso = (entry.get("timestamp_iso") or "").strip()
    if timestamp_iso:
        try:
            entry.update(_format_local_history_timestamp(datetime.fromisoformat(timestamp_iso)))
            return
        except ValueError:
            pass

    timestamp_text = (entry.get("timestamp") or "").strip()
    if not timestamp_text:
        return

    try:
        legacy_dt = datetime.strptime(timestamp_text, "%Y-%m-%d %I:%M %p").replace(tzinfo=timezone.utc)
        entry.update(_format_local_history_timestamp(legacy_dt))
    except ValueError:
        return


def _history_record_datetime(entry):
    if not entry:
        return None
    timestamp_iso = str(entry.get("timestamp_iso") or "").strip()
    if timestamp_iso:
        try:
            parsed = datetime.fromisoformat(timestamp_iso)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    timestamp_text = str(entry.get("timestamp") or "").strip()
    if timestamp_text:
        try:
            return datetime.strptime(timestamp_text, "%Y-%m-%d %I:%M %p").replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def _history_record_is_recent(entry, retention_days=30):
    record_dt = _history_record_datetime(entry)
    if not record_dt:
        return True
    return record_dt >= datetime.now(timezone.utc) - timedelta(days=retention_days)


def _recent_history_docs(docs):
    recent = []
    for doc in docs:
        _normalize_history_timestamp(doc)
        if _history_record_is_recent(doc):
            recent.append(doc)
    return recent


def _history_identity(record):
    history_id = str((record or {}).get("history_id") or "").strip()
    if history_id:
        return history_id
    candidate = str((record or {}).get("candidate_name") or (record or {}).get("candidate") or "").strip().lower()
    tester = str((record or {}).get("tester_name") or "").strip().lower()
    timestamp = str((record or {}).get("timestamp_iso") or (record or {}).get("timestamp") or "").strip()
    return "|".join([timestamp, tester, candidate])


def _resume_source_filter(session):
    source_history_id = str((session or {}).get("resume_source_history_id") or "").strip()
    if source_history_id:
        return {"history_id": source_history_id}
    source_timestamp = str((session or {}).get("resume_source_timestamp_iso") or "").strip()
    source_candidate = str((session or {}).get("resume_source_candidate") or "").strip()
    source_tester = str((session or {}).get("resume_source_tester") or "").strip()
    if source_timestamp:
        return {
            "timestamp_iso": source_timestamp,
            "candidate": source_candidate,
            "candidate_name": source_candidate,
            "tester_name": source_tester,
        }
    return {}


def _history_record_matches_source(record, source_filter):
    if not source_filter:
        return False
    if source_filter.get("history_id"):
        existing_history_id = str((record or {}).get("history_id") or "").strip()
        return existing_history_id == source_filter["history_id"] or _history_identity(record) == source_filter["history_id"]
    if source_filter.get("timestamp_iso") and str((record or {}).get("timestamp_iso") or "").strip() != source_filter["timestamp_iso"]:
        return False
    candidate = str((record or {}).get("candidate") or (record or {}).get("candidate_name") or "").strip().lower()
    expected_candidate = str(source_filter.get("candidate") or source_filter.get("candidate_name") or "").strip().lower()
    tester = str((record or {}).get("tester_name") or "").strip().lower()
    expected_tester = str(source_filter.get("tester_name") or "").strip().lower()
    if expected_candidate and candidate != expected_candidate:
        return False
    if expected_tester and tester != expected_tester:
        return False
    return True


def _history_record_matches_identifier(record, identifier):
    normalized_identifier = str(identifier or "").strip()
    if not normalized_identifier:
        return False
    history_id = str((record or {}).get("history_id") or "").strip()
    return history_id == normalized_identifier or _history_identity(record) == normalized_identifier


def _history_record_references_source(record, deleted_record):
    if not record or not deleted_record:
        return False

    deleted_history_id = str(deleted_record.get("history_id") or "").strip()
    deleted_identity = _history_identity(deleted_record)
    source_history_id = str(record.get("resume_source_history_id") or "").strip()
    if source_history_id and source_history_id in {deleted_history_id, deleted_identity}:
        return True

    source_timestamp = str(record.get("resume_source_timestamp_iso") or "").strip()
    deleted_timestamp = str(deleted_record.get("timestamp_iso") or "").strip()
    if not source_timestamp or source_timestamp != deleted_timestamp:
        return False

    source_candidate = str(record.get("resume_source_candidate") or "").strip().lower()
    deleted_candidate = str(deleted_record.get("candidate_name") or deleted_record.get("candidate") or "").strip().lower()
    source_tester = str(record.get("resume_source_tester") or "").strip().lower()
    deleted_tester = str(deleted_record.get("tester_name") or "").strip().lower()
    if source_candidate and deleted_candidate and source_candidate != deleted_candidate:
        return False
    if source_tester and deleted_tester and source_tester != deleted_tester:
        return False
    return True


def _unlink_resume_source_fields(record):
    cleaned = SQLiteCollection.clone(record or {})
    for key in (
        "resume_source_history_id",
        "resume_source_timestamp_iso",
        "resume_source_candidate",
        "resume_source_tester",
        "original_timestamp",
        "original_timestamp_iso",
    ):
        cleaned.pop(key, None)
    cleaned["resumed_from_history"] = False
    cleaned["resumed_sup_transfer_only"] = False
    return cleaned


async def _cleanup_deleted_history_references(deleted_record):
    rows = db.history.store.fetchall(
        "SELECT id, data FROM history_documents ORDER BY id DESC",
        (),
    )
    cleaned_history = 0
    for row in rows:
        existing = json.loads(row["data"])
        if not _history_record_references_source(existing, deleted_record):
            continue
        cleaned = _unlink_resume_source_fields(existing)
        db.history.store.execute(
            "UPDATE history_documents SET data = ?, timestamp = ? WHERE id = ?",
            (
                json.dumps(cleaned, ensure_ascii=False, default=str),
                str(cleaned.get("timestamp_iso") or cleaned.get("timestamp") or ""),
                row["id"],
            ),
        )
        cleaned_history += 1

    active_session = await db.sessions.find_one({"_id": "active_session"})
    cleaned_active_session = False
    if active_session and _history_record_references_source(active_session, deleted_record):
        cleaned = _unlink_resume_source_fields(active_session)
        cleaned["_id"] = "active_session"
        await db.sessions.replace_one({"_id": "active_session"}, cleaned, upsert=True)
        cleaned_active_session = True

    return {"history_records_unlinked": cleaned_history, "active_session_unlinked": cleaned_active_session}


async def _delete_history_record_by_identifier(identifier):
    rows = db.history.store.fetchall(
        "SELECT id, data FROM history_documents ORDER BY id DESC",
        (),
    )
    for row in rows:
        existing = json.loads(row["data"])
        if not _history_record_matches_identifier(existing, identifier):
            continue
        db.history.store.execute("DELETE FROM history_documents WHERE id = ?", (row["id"],))
        cleanup = await _cleanup_deleted_history_references(existing)
        return existing, cleanup
    return None, {"history_records_unlinked": 0, "active_session_unlinked": False}


def _attempt_history_snapshot(record):
    source = record or {}
    return {
        "attempt_number": source.get("attempt_number") or source.get("newbie_shift_current_attempt") or 1,
        "status": source.get("status") or source.get("final_status") or compute_final_status(source),
        "final_attempt": bool(source.get("final_attempt")),
        "timestamp": source.get("timestamp") or "",
        "timestamp_iso": source.get("timestamp_iso") or source.get("completed_at") or "",
        "call_1": source.get("call_1"),
        "call_2": source.get("call_2"),
        "call_3": source.get("call_3"),
        "sup_transfer_1": source.get("sup_transfer_1"),
        "sup_transfer_2": source.get("sup_transfer_2"),
        "newbie_shift_data": source.get("newbie_shift_data"),
        "newbie_shift_request_id": source.get("newbie_shift_request_id") or "",
        "coaching_summary": source.get("coaching_summary") or "",
        "fail_summary": source.get("fail_summary") or "",
    }


def _append_attempt_history(existing):
    history = [dict(item) for item in (existing.get("attempt_history") or []) if isinstance(item, dict)]
    snapshot = _attempt_history_snapshot(existing)
    identity = (
        str(snapshot.get("attempt_number") or ""),
        str(snapshot.get("timestamp_iso") or snapshot.get("timestamp") or ""),
        str(snapshot.get("status") or ""),
    )
    known = {
        (
            str(item.get("attempt_number") or ""),
            str(item.get("timestamp_iso") or item.get("timestamp") or ""),
            str(item.get("status") or ""),
        )
        for item in history
    }
    if identity not in known:
        history.append(snapshot)
    return history


async def _upsert_history_record(record, source_session=None):
    document = SQLiteCollection.clone(record)
    document["history_id"] = str(document.get("history_id") or uuid.uuid4())
    document_status = normalize_history_status(document)
    document["status"] = document_status
    document["final_status"] = document_status
    source_filter = _resume_source_filter(source_session or {})
    if source_filter:
        rows = db.history.store.fetchall(
            "SELECT id, data FROM history_documents ORDER BY id DESC",
            (),
        )
        for row in rows:
            existing = json.loads(row["data"])
            if not _history_record_matches_source(existing, source_filter):
                continue
            merged = {
                **existing,
                **document,
                "attempt_history": _append_attempt_history(existing),
                "history_id": existing.get("history_id") or document["history_id"],
                "resumed_from_history": True,
                "resumed_sup_transfer_only": True,
                "supervisor_only": bool(document.get("supervisor_only", False)),
                "resume_source_history_id": existing.get("history_id") or source_filter.get("history_id") or "",
                "resume_source_timestamp_iso": existing.get("timestamp_iso") or source_filter.get("timestamp_iso") or "",
                "original_timestamp": existing.get("timestamp") or "",
                "original_timestamp_iso": existing.get("timestamp_iso") or "",
            }
            merged_status = normalize_history_status(merged)
            merged["status"] = merged_status
            merged["final_status"] = merged_status
            merged["smart_resume_finalized"] = merged_status in {"Pass", "RESUMED-PASS", "Fail", "FAIL-Final Attempt", "NC/NS"}
            db.history.store.execute(
                "UPDATE history_documents SET data = ?, timestamp = ? WHERE id = ?",
                (
                    json.dumps(merged, ensure_ascii=False, default=str),
                    str(merged.get("timestamp_iso") or merged.get("timestamp") or ""),
                    row["id"],
                ),
            )
            return merged, "updated"

    document["smart_resume_finalized"] = document_status in {"Pass", "RESUMED-PASS", "Fail", "FAIL-Final Attempt", "NC/NS"}
    await db.history.insert_one(document)
    return document, "inserted"


def build_clean_coaching(session):
    auto_fail = session.get("auto_fail_reason")
    lines = []
    include_fail_details = True
    if not session.get("supervisor_only", False):
        for i in range(1, 4):
            line = _build_section_coaching_summary(
                session.get(f"call_{i}"),
                f"Call {i}",
                include_fail_details=include_fail_details,
            )
            if line:
                lines.append(line)
    for i in range(1, 3):
        line = _build_section_coaching_summary(
            session.get(f"sup_transfer_{i}"),
            f"Sup Transfer {i}",
            include_fail_details=include_fail_details,
        )
        if line:
            lines.append(line)
    if session.get("sup_dte_stuck"):
        first_name = str(session.get("candidate_name") or "The candidate").strip().split()[0] or "The candidate"
        lines.append(
            f"{first_name}'s supervisor transfer could not be completed. "
            "Their DTE would not go into Ready status. It was stuck on Full Capacity / Ready for Got Calls status."
        )
    if lines:
        base_summary = "\n".join(lines)
    elif auto_fail:
        base_summary = (
            "No coaching summary was generated before the session ended. "
            f"Session closed under the recorded auto-fail reason: {_sentence_case(auto_fail)}."
        )
    else:
        base_summary = "No coaching summary was generated because no coaching items were selected for this session."

    notes = session.get("finalEvaluatorNotes") or {}
    if notes and notes.get("includeInCoachingSummary", True) and not notes.get("historyOnly", False):
        fallback_parts = []
        if notes.get("notes"):
            fallback_parts.append(notes.get("notes").strip())
        if notes.get("strengths"):
            fallback_parts.append(notes.get("strengths").strip())
        if notes.get("needsCoaching"):
            fallback_parts.append(notes.get("needsCoaching").strip())
        if notes.get("other"):
            fallback_parts.append(notes.get("other").strip())
        if fallback_parts:
            fallback_notes_str = "Additional Notes: " + " ".join(fallback_parts)
            if base_summary.startswith("No coaching summary was generated"):
                return _append_readiness_override_note(fallback_notes_str, session)
            return _append_readiness_override_note(base_summary + "\n\n" + fallback_notes_str, session)

    return _append_readiness_override_note(base_summary, session)


def build_clean_fail(session):
    if _is_fail_na(session):
        return _append_readiness_override_note("N/A", session)

    auto_fail = session.get("auto_fail_reason")
    if auto_fail:
        base_fail = (
            "Session Auto-Fail - Fail - "
            f"Recorded auto-fail reason: {_sentence_case(auto_fail)}."
        )
    elif _tech_issue_ended_session(session) and compute_final_status(session) not in {
        "Fail", "FAIL-Final Attempt", "NC/NS", FINAL_READINESS_NEEDS_RETEST,
    }:
        issue = str(session.get("tech_issue") or "Technical issue unresolved").strip()
        base_fail = f"Session ended due to Technical Issues - {_sentence_case(issue)}."
    else:
        lines = []
        if session.get("supervisor_only", False):
            for i in range(1, 3):
                line = _build_section_fail_summary(session.get(f"sup_transfer_{i}"), f"Sup Transfer {i}")
                if line:
                    lines.append(line)
        else:
            for i in range(1, 4):
                line = _build_section_fail_summary(session.get(f"call_{i}"), f"Call {i}")
                if line:
                    lines.append(line)
            calls_failed = sum(1 for i in range(1, 4) if (session.get(f"call_{i}") or {}).get("result") == "Fail")
            if calls_failed < 2 or compute_final_status(session) == "FAIL-Final Attempt":
                for i in range(1, 3):
                    line = _build_section_fail_summary(session.get(f"sup_transfer_{i}"), f"Sup Transfer {i}")
                    if line:
                        lines.append(line)
        if lines:
            base_fail = "\n".join(lines)
        else:
            if _has_tech_issue(session):
                base_fail = "Session ended due to Technical Issues."
            elif session.get("stopped_responding") or "stopped responding" in str(session.get("auto_fail_reason") or "").lower():
                base_fail = "Candidate stopped responding in Discord during the session."
            else:
                base_fail = ""

    notes = session.get("finalEvaluatorNotes") or {}
    include_notes = notes.get("includeInFailSummary", True) and not notes.get("historyOnly", False)
    has_notes = bool(notes.get("notes", "").strip() or notes.get("needsCoaching", "").strip() or notes.get("other", "").strip() or notes.get("strengths", "").strip())
    
    if has_notes and include_notes:
        fallback_parts = []
        if notes.get("notes"):
            fallback_parts.append(notes.get("notes").strip())
        if notes.get("needsCoaching"):
            fallback_parts.append(notes.get("needsCoaching").strip())
        if notes.get("other"):
            fallback_parts.append(notes.get("other").strip())
        if notes.get("strengths"):
            fallback_parts.append(notes.get("strengths").strip())
        
        fallback_notes_str = "Additional Notes: " + " ".join(fallback_parts)
        if not base_fail:
            return _ensure_final_attempt_fail_summary(_append_readiness_override_note(fallback_notes_str, session), session)
        return _ensure_final_attempt_fail_summary(_append_readiness_override_note(base_fail + "\n\n" + fallback_notes_str, session), session)
    else:
        if not base_fail:
            return _ensure_final_attempt_fail_summary(_append_readiness_override_note("No structured fail reason was selected. See evaluator notes and call results for context.", session), session)
        return _ensure_final_attempt_fail_summary(_append_readiness_override_note(base_fail, session), session)


def _ensure_final_attempt_fail_summary(text, session):
    value = str(text or "").strip()
    if not _shared_truthy((session or {}).get("final_attempt")):
        return value
    if compute_final_status(session) not in {"Fail", "FAIL-Final Attempt", "NC/NS", FINAL_READINESS_NEEDS_RETEST}:
        return value
    if re.search(r"\bfinal attempt\b", value, flags=re.IGNORECASE):
        return value
    statement = "This session was the candidate's final attempt."
    return f"{value} {statement}".strip()


DEFAULT_GEMINI_COACHING_PROMPT = (
    "You are writing an internal certification test call results summary for management. "
    "Based on the coaching checkboxes selected during the mock certification session, "
    "write a clear, concise, management-facing summary of what occurred during the test. "
    "The summary must be objective, professional, and suitable for internal documentation. "
    "Use the existing session-note line structure when possible, keeping each completed call "
    "or supervisor transfer management-facing and concise. "
    "Incorporate the selected coaching checklist items directly into the summary instead of "
    "generalizing vaguely. Reference the specific coached items in plain language, and only "
    "reference coaching items that appear in the session notes. Keep checkbox-specific "
    "guidance from the session notes intact when it explains what was coached, including "
    "donor-information verification guidance, phonetics-table coaching, caller-name search "
    "coaching, and coaching on not volunteering unprovided member information. If a failed "
    "call or supervisor transfer includes fail-reason detail lines, preserve the connection "
    "between the fail reason and its detail. Do not drop the detail or attach it to a different "
    "reason. Do not address "
    "the candidate. Do not use second-person language such as 'you' or 'your'. Do not give "
    "new advice or instructions that are not already reflected in the session notes. Describe "
    "the observed performance and the coaching provided during the session. If the selected "
    "coaching includes screenshots, Discord chat, or standard instructions, explicitly include "
    "management-facing wording equivalent to 'Coaching was provided using the standard screenshots "
    "and Discord chat.' Treat this as the coaching method, not a coaching topic. Avoid repetitive wording, group related coaching "
    "themes naturally, and do not invent any coaching item that was not selected. "
    "CRITICAL WORDING RULES FOR EVALUATOR NOTES: "
    "If additional evaluator notes are provided, incorporate them directly and professionally. "
    "Do NOT use phrasing like 'The evaluator noted...', 'The evaluator stated...', or 'The notes say...'. "
    "Instead, use direct, professional phrasing (e.g. prefix with 'Additional Notes: ' followed by the direct observations). "
    "Keep wording professional, direct, and clear. Do not overstate the notes."
)

GEMINI_SCREENSHOT_DISCORD_RULE = (
    'If the selected coaching includes screenshots, Discord chat, or standard instructions, include '
    'management-facing wording equivalent to "Coaching was provided using the standard screenshots '
    'and Discord chat." Treat this as the coaching method, not a coaching topic.'
)

DEFAULT_GEMINI_FAIL_PROMPT = (
    "You are writing an internal certification test call failure summary for management. "
    "Based on the fail reasons selected during the mock certification session, write a "
    "clear, concise, management-facing summary of why the candidate did not pass. The "
    "summary must be objective, professional, and suitable for internal documentation. "
    "Incorporate the selected fail checklist items directly into the summary instead of "
    "generalizing vaguely. Reference the specific fail reasons in plain language, and only "
    "reference fail reasons that appear in the session notes. If a fail reason includes a "
    "Detail line, keep that detail tied to the same fail reason and include it as the specific "
    "context for what occurred. Do not address the candidate. "
    "Do not use second-person language such as 'you' or 'your'. Do not give advice or "
    "instructions such as 'should', 'try to', or 'remember to'. State what occurred during "
    "the session and any additional contributing issues. Avoid repetitive wording, group "
    "related fail reasons naturally, and do not invent fail reasons that were not selected. "
    "CRITICAL WORDING RULES FOR EVALUATOR NOTES: "
    "If additional evaluator notes are provided, incorporate them directly and professionally. "
    "Do NOT use phrasing like 'The evaluator noted...', 'The evaluator stated...', or 'The notes say...'. "
    "Instead, use direct, professional phrasing (e.g. prefix with 'Additional Notes: ' followed by the direct observations). "
    "Keep wording professional, direct, and clear. Do not overstate the notes."
)


def _clean_gemini_prompt_text(value):
    text = str(value or "").strip()
    if not text:
        return ""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if _values_look_like_headsets(lines):
        logger.warning("[GEMINI] Rejected headset-like Gemini prompt override.")
        return ""
    return text


def _ensure_required_gemini_coaching_rules(prompt):
    text = str(prompt or "").strip()
    if not text:
        return ""
    if "Coaching was provided using the standard screenshots and Discord chat." in text:
        return text
    return f"{text}\n\n{GEMINI_SCREENSHOT_DISCORD_RULE}"


def _safe_gemini_error_message(exc, api_key=""):
    text = str(exc or "Gemini summary generation failed.").strip() or "Gemini summary generation failed."
    key = str(api_key or "").strip()
    if key:
        text = text.replace(key, "[redacted]")
    text = re.sub(r"(?i)(api[_ -]?key[=: ]+)[A-Za-z0-9_\-\.]+", r"\1[redacted]", text)
    text = re.sub(r"AIza[0-9A-Za-z_\-]{20,}", "[redacted]", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:300]


def _get_gemini_prompt_details(settings, prompt_type):
    if prompt_type == "fail":
        setting_key = "gemini_fail_prompt"
        fallback = DEFAULT_GEMINI_FAIL_PROMPT
    else:
        setting_key = "gemini_coaching_prompt"
        fallback = DEFAULT_GEMINI_COACHING_PROMPT

    remote_or_local_prompt = _clean_gemini_prompt_text(EXTERNAL_CONTENT.get(setting_key))
    if remote_or_local_prompt:
        status = _content_source_status.get(setting_key) or {}
        source = status.get("detail") or status.get("source") or "local"
        if prompt_type != "fail":
            remote_or_local_prompt = _ensure_required_gemini_coaching_rules(remote_or_local_prompt)
        return remote_or_local_prompt, source

    if prompt_type != "fail":
        fallback = _ensure_required_gemini_coaching_rules(fallback)
    return fallback, "builtin"


_last_logged_gemini_prompt_sources = {}


def _log_gemini_prompt_source(prompt_type, source):
    prompt_name = "fail" if prompt_type == "fail" else "coaching"
    source_key = str(source or "builtin")
    if _last_logged_gemini_prompt_sources.get(prompt_name) == source_key:
        return
    _last_logged_gemini_prompt_sources[prompt_name] = source_key
    if source == "google_sheet_override":
        logger.info("[Gemini] Google Sheet %s override active", prompt_name)
    elif source == "local":
        logger.info("[Gemini] Local markdown %s prompt active", prompt_name)
    elif source == "builtin":
        logger.warning("[Gemini] Built-in Python %s prompt fallback active", prompt_name)
    else:
        logger.info("[Gemini] Loading %s prompt from %s", prompt_name, source)


def _get_gemini_prompt(settings, prompt_type):
    prompt, _source = _get_gemini_prompt_details(settings, prompt_type)
    return prompt

PREFERRED_GEMINI_TEXT_MODELS = (
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
)
GEMINI_REQUEST_TIMEOUT_SECONDS = 20
GEMINI_TEST_TIMEOUT_SECONDS = 10
GEMINI_RETRY_ATTEMPTS = 2
GEMINI_RETRY_DELAY_SECONDS = 0.6
_gemini_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="gemini-summary")


def _extract_gemini_text(response):
    try:
        text = (getattr(response, "text", "") or "").strip()
    except Exception:
        text = ""
    if text:
        return text

    candidates = getattr(response, "candidates", None) or []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or []
        for part in parts:
            candidate_text = (getattr(part, "text", "") or "").strip()
            if candidate_text:
                return candidate_text

    return ""


def _gemini_response_finish_reasons(response):
    reasons = []
    for candidate in getattr(response, "candidates", None) or []:
        reason = getattr(candidate, "finish_reason", "")
        if reason:
            reasons.append(str(reason))
    return reasons

_cached_gemini_model = None
_cached_gemini_model_key = None

def _select_supported_gemini_model(api_key: str) -> str:
    global _cached_gemini_model, _cached_gemini_model_key
    if _cached_gemini_model and _cached_gemini_model_key == api_key:
        return _cached_gemini_model

    if not api_key:
        raise RuntimeError("Gemini is enabled, but no API key is saved.")

    import google.generativeai as genai

    genai.configure(api_key=api_key)

    try:
        models = list(genai.list_models())
    except Exception as exc:
        raise RuntimeError(f"Unable to list Gemini models for this API key: {exc}") from exc

    supported = {}
    for model in models:
        name = (getattr(model, "name", "") or "").strip()
        methods = set(getattr(model, "supported_generation_methods", []) or [])
        if not name or "generateContent" not in methods:
            continue
        supported[name.split("/", 1)[-1]] = model

    for preferred_model in PREFERRED_GEMINI_TEXT_MODELS:
        if preferred_model in supported:
            logger.info("[GEMINI] Using supported model %s", preferred_model)
            _cached_gemini_model = preferred_model
            _cached_gemini_model_key = api_key
            return preferred_model

    discovered = ", ".join(sorted(supported.keys())) or "none"
    raise RuntimeError(
        "No supported Gemini text model was found for generateContent. "
        f"Available generateContent models for this API key: {discovered}"
    )


def _generate_gemini_summary(source_text, prompt_template, api_key, summary_type, final_notes_text="", instructions="", current_summary=""):
    if not api_key:
        raise RuntimeError("Gemini is enabled, but no API key is saved.")
    source_text = str(source_text or "").strip()
    source_lines = [line.strip() for line in source_text.splitlines() if line.strip()]
    if _values_look_like_headsets(source_lines):
        raise RuntimeError(
            "Summary source looked like approved-headset data instead of selected session items."
        )

    import google.generativeai as genai

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(_select_supported_gemini_model(api_key))
    if instructions:
        prompt = (
            f"{prompt_template}\n\n"
            f"You are revising the following existing {summary_type} summary:\n"
            f"--- EXISTING SUMMARY START ---\n{current_summary}\n--- EXISTING SUMMARY END ---\n\n"
            f"Please revise it based on these instructions:\n"
            f"Instructions: {instructions}\n\n"
            f"For context, the session notes are:\n{source_text}\n"
        )
        if final_notes_text:
            prompt += f"\nAnd the evaluator's final notes are:\n{final_notes_text}\n"
        prompt += "\nReturn only the revised summary text with no heading, markdown, or extra commentary."
    else:
        prompt = (
            f"{prompt_template}\n\n"
            f"Session notes:\n{source_text}\n"
        )
        if final_notes_text:
            prompt += f"\nEvaluator's final notes:\n{final_notes_text}\n"
        prompt += "\nReturn only the final summary text with no heading, markdown, or extra commentary."

    response = model.generate_content(prompt)
    text = _extract_gemini_text(response)
    if not text:
        raise RuntimeError(f"Gemini returned an empty {summary_type} summary.")
    return text


def _generate_gemini_summary_with_timeout(source_text, prompt_template, api_key, summary_type, final_notes_text="", instructions="", current_summary=""):
    last_error = None
    for attempt in range(1, GEMINI_RETRY_ATTEMPTS + 1):
        future = _gemini_executor.submit(
            _generate_gemini_summary,
            source_text,
            prompt_template,
            api_key,
            summary_type,
            final_notes_text,
            instructions,
            current_summary
        )
        try:
            return future.result(timeout=GEMINI_REQUEST_TIMEOUT_SECONDS)
        except FutureTimeoutError as exc:
            future.cancel()
            last_error = RuntimeError(f"Gemini {summary_type} summary timed out after {GEMINI_REQUEST_TIMEOUT_SECONDS} seconds.")
        except Exception as exc:
            last_error = exc
        if attempt < GEMINI_RETRY_ATTEMPTS:
            time.sleep(GEMINI_RETRY_DELAY_SECONDS)
    raise last_error or RuntimeError(f"Gemini {summary_type} summary failed.")


def _classify_gemini_test_error(exc, api_key=""):
    text = _safe_gemini_error_message(exc, api_key)
    lowered = text.lower()
    if "timeout" in lowered or "timed out" in lowered:
        return "timeout", "Gemini request timed out"
    if "429" in lowered or "rate limit" in lowered or "quota" in lowered or "resource exhausted" in lowered:
        return "rate_limit", "Gemini rate limit reached"
    if "api key" in lowered and ("invalid" in lowered or "not valid" in lowered):
        return "invalid_key", "Invalid Gemini API key"
    if "permission" in lowered or "unauthorized" in lowered or "forbidden" in lowered or "403" in lowered:
        return "invalid_key", "Invalid Gemini API key"
    if "network" in lowered or "connect" in lowered or "connection" in lowered or "dns" in lowered or "name resolution" in lowered:
        return "network_error", "Unable to connect to Gemini"
    return "error", "Unable to connect to Gemini"


def _perform_gemini_connection_test(api_key):
    if not api_key:
        return {"ok": False, "code": "no_key", "message": "No Gemini API key configured"}

    import google.generativeai as genai

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(_select_supported_gemini_model(api_key))
    response = model.generate_content(
        "Return ONLY the word: OK",
        generation_config={"max_output_tokens": 4, "temperature": 0},
    )
    text = _extract_gemini_text(response).strip()
    if not text:
        finish_reasons = _gemini_response_finish_reasons(response)
        if any(reason in {"2", "FinishReason.SAFETY", "SAFETY"} or "SAFETY" in reason.upper() for reason in finish_reasons):
            return {
                "ok": False,
                "code": "blocked_or_empty",
                "message": "Gemini connected, but the test response was blocked or empty. Try a simpler test prompt or check Gemini safety/API settings.",
                "detail": f"Gemini finish reason: {', '.join(finish_reasons)}",
            }
        return {
            "ok": False,
            "code": "blocked_or_empty",
            "message": "Gemini connected, but the test response was blocked or empty. Try a simpler test prompt or check Gemini safety/API settings.",
            "detail": "Gemini returned no text for the connection test.",
        }
    if text.upper().strip(" .\n\t") != "OK":
        raise RuntimeError("Gemini returned an unexpected test response.")
    return {"ok": True, "code": "success", "message": "Gemini connection successful"}


def test_gemini_connection_with_timeout(api_key):
    api_key = str(api_key or "").strip()
    if not api_key:
        return {"ok": False, "code": "no_key", "message": "No Gemini API key configured"}

    future = _gemini_executor.submit(_perform_gemini_connection_test, api_key)
    try:
        return future.result(timeout=GEMINI_TEST_TIMEOUT_SECONDS)
    except FutureTimeoutError as exc:
        future.cancel()
        code, message = _classify_gemini_test_error(
            RuntimeError(f"Gemini request timed out after {GEMINI_TEST_TIMEOUT_SECONDS} seconds."),
            api_key,
        )
        return {"ok": False, "code": code, "message": message, "detail": f"Gemini request timed out after {GEMINI_TEST_TIMEOUT_SECONDS} seconds."}
    except Exception as exc:
        code, message = _classify_gemini_test_error(exc, api_key)
        detail = _safe_gemini_error_message(exc, api_key)
        logger.warning("[Gemini] Connection test failed: %s", detail)
        return {"ok": False, "code": code, "message": message, "detail": detail}


def generate_summaries(session, api_key="", settings=None, instructions="", current_summary="", summary_type=None):
    import time
    start_time = time.perf_counter()

    if _is_newbie_reschedule(session):
        return {
            "coaching": _build_reschedule_coaching_summary(session),
            "fail": _build_reschedule_fail_summary(session),
            "used_gemini": False,
            "used_fallback": True,
            "gemini_enabled": False,
            "gemini_key_configured": False,
            "coaching_prompt_source": "deterministic-reschedule",
            "fail_prompt_source": "deterministic-reschedule",
            "gemini_error": "",
        }

    auto_fail_summaries = _auto_fail_review_summaries(session)
    use_gemini = bool(settings and settings.get("enable_gemini"))
    api_key = (api_key or "").strip()
    coaching_prompt, coaching_prompt_source = _get_gemini_prompt_details(settings, "coaching")
    fail_prompt, fail_prompt_source = _get_gemini_prompt_details(settings, "fail")
    _log_gemini_prompt_source("coaching", coaching_prompt_source)
    _log_gemini_prompt_source("fail", fail_prompt_source)
    diagnostics = {
        "used_gemini": False,
        "used_fallback": True,
        "gemini_enabled": use_gemini,
        "gemini_key_configured": bool(api_key),
        "coaching_prompt_source": coaching_prompt_source,
        "fail_prompt_source": fail_prompt_source,
        "gemini_error": "",
    }
    
    source = "retry" if instructions else ("gemini" if use_gemini and api_key else "fallback")
    logger.info(
        "[SUMMARY LOG] summary start, source=%s, fields=%d, payload_size=%d",
        source,
        len(session),
        len(str(session)),
    )

    if auto_fail_summaries and not instructions:
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        logger.info(
            "[SUMMARY LOG] summary end (auto_fail), source=%s, duration_ms=%d, fields=%d, payload_size=%d",
            "fallback",
            duration_ms,
            len(session),
            len(str(session)),
        )
        return {
            **auto_fail_summaries,
            "fail": _ensure_final_attempt_fail_summary(auto_fail_summaries.get("fail"), session),
            **diagnostics,
        }

    coaching = build_clean_coaching(session)
    fail = "N/A" if _is_fail_na(session) else build_clean_fail(session)

    if not use_gemini:
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        logger.info(
            "[SUMMARY LOG] summary end (fallback), source=%s, duration_ms=%d, fields=%d, payload_size=%d",
            "fallback",
            duration_ms,
            len(session),
            len(str(session)),
        )
        return {"coaching": coaching, "fail": fail, **diagnostics}
    if not api_key:
        message = "Gemini is enabled, but no API key is saved. Using generic summaries instead."
        duration_ms = int((time.perf_counter() - start_time) * 1000)
        logger.info(
            "[SUMMARY LOG] summary end (fallback_no_key), source=%s, duration_ms=%d, fields=%d, payload_size=%d",
            "fallback",
            duration_ms,
            len(session),
            len(str(session)),
        )
        return {
            "coaching": coaching,
            "fail": fail,
            "error": message,
            **{**diagnostics, "gemini_error": message},
        }

    readiness_context_text = _readiness_context_text(session)

    # Format evaluator notes for coaching summary
    notes = session.get("finalEvaluatorNotes") or {}
    coaching_notes_text = readiness_context_text
    if notes.get("includeInCoachingSummary", True) and not notes.get("historyOnly", False):
        notes_parts = []
        if notes.get("notes"):
            notes_parts.append(notes.get("notes").strip())
        if notes.get("strengths"):
            notes_parts.append(notes.get("strengths").strip())
        if notes.get("needsCoaching"):
            notes_parts.append(notes.get("needsCoaching").strip())
        if notes.get("other"):
            notes_parts.append(notes.get("other").strip())
        if notes_parts:
            coaching_notes_text = "\n".join(part for part in [coaching_notes_text, "Additional Notes: " + " ".join(notes_parts)] if part)

    # Format evaluator notes for fail summary
    fail_notes_text = readiness_context_text
    is_fail = not _is_fail_na(session)
    if is_fail and notes.get("includeInFailSummary", True) and not notes.get("historyOnly", False):
        notes_parts = []
        if notes.get("notes"):
            notes_parts.append(notes.get("notes").strip())
        if notes.get("needsCoaching"):
            notes_parts.append(notes.get("needsCoaching").strip())
        if notes.get("other"):
            notes_parts.append(notes.get("other").strip())
        if notes.get("strengths"):
            notes_parts.append(notes.get("strengths").strip())
        if notes_parts:
            fail_notes_text = "\n".join(part for part in [fail_notes_text, "Additional Notes: " + " ".join(notes_parts)] if part)

    res_coaching = None
    res_fail = None
    gemini_error = ""
    used_gemini = False

    # Generate coaching summary if needed
    if summary_type is None or summary_type == "coaching":
        if coaching == "No coaching data recorded." and not instructions:
            res_coaching = coaching
        else:
            try:
                if instructions and summary_type == "coaching":
                    res_coaching = _generate_gemini_summary_with_timeout(
                        coaching,
                        coaching_prompt,
                        api_key,
                        "coaching",
                        final_notes_text=coaching_notes_text,
                        instructions=instructions,
                        current_summary=current_summary
                    )
                else:
                    res_coaching = _generate_gemini_summary_with_timeout(
                        coaching,
                        coaching_prompt,
                        api_key,
                        "coaching",
                        final_notes_text=coaching_notes_text
                    )
                used_gemini = True
            except Exception as exc:
                logger.exception("[GEMINI] Coaching summary generation failed: %s", exc)
                gemini_error = f"Coaching summary failed: {_safe_gemini_error_message(exc, api_key)}"
                res_coaching = coaching

    # Generate fail summary if needed
    if summary_type is None or summary_type == "fail":
        if fail == "N/A" and not instructions:
            res_fail = fail
        else:
            try:
                if instructions and summary_type == "fail":
                    res_fail = _generate_gemini_summary_with_timeout(
                        fail,
                        fail_prompt,
                        api_key,
                        "fail",
                        final_notes_text=fail_notes_text,
                        instructions=instructions,
                        current_summary=current_summary
                    )
                else:
                    res_fail = _generate_gemini_summary_with_timeout(
                        fail,
                        fail_prompt,
                        api_key,
                        "fail",
                        final_notes_text=fail_notes_text
                    )
                used_gemini = True
            except Exception as exc:
                logger.exception("[GEMINI] Fail summary generation failed: %s", exc)
                if gemini_error:
                    gemini_error += " | "
                gemini_error += f"Fail summary failed: {_safe_gemini_error_message(exc, api_key)}"
                res_fail = fail

    # Return result
    ret = {
        **diagnostics,
        "used_gemini": used_gemini,
        "used_fallback": not used_gemini,
    }
    if res_coaching is not None:
        ret["coaching"] = res_coaching
    if res_fail is not None:
        ret["fail"] = _ensure_final_attempt_fail_summary(res_fail, session)
    if gemini_error:
        ret["gemini_error"] = gemini_error
        ret["error"] = gemini_error
        
    duration_ms = int((time.perf_counter() - start_time) * 1000)
    final_source = "retry" if instructions else ("gemini" if used_gemini else "fallback")
    logger.info(
        "[SUMMARY LOG] summary end, source=%s, duration_ms=%d, fields=%d, payload_size=%d",
        final_source,
        duration_ms,
        len(session),
        len(str(session)),
    )
        
    return ret


def _count_results(session, prefix, total, target):
    return sum(1 for i in range(1, total + 1) if (session.get(f"{prefix}_{i}") or {}).get("result") == target)


def _format_newbie_shift_for_form(session):
    if any((session.get(f"sup_transfer_{i}") or {}).get("result") == "Pass" for i in range(1, 3)):
        return "N/A"
    newbie = session.get("newbie_shift_data")
    if not newbie:
        return "N/A"
    parts = [newbie.get("newbie_date", "").strip(), "at", newbie.get("newbie_time", "").strip(), newbie.get("newbie_tz", "").strip()]
    return " ".join(part for part in parts if part).strip() or "N/A"


def _format_headset_for_form(session):
    model = str(session.get("headset_brand") or "N/A").strip() or "N/A"
    if _classify_auto_fail_reason(session.get("auto_fail_reason")) != "headset":
        return model
    usb = "Yes" if session.get("headset_usb") is True else "No" if session.get("headset_usb") is False else "N/A"
    noise = "Yes" if session.get("noise_cancel") is True else "No" if session.get("noise_cancel") is False else "N/A"
    reasons = str(session.get("auto_fail_reason") or "").strip()
    return f"{model} | USB: {usb} | Noise Cancelling Mic: {noise} | Reasons: {reasons}"


def _candidate_first_name(session):
    name = str((session or {}).get("candidate_name") or (session or {}).get("candidate") or "").strip()
    return name.split()[0] if name.split() else "The candidate"


def _reschedule_reason_sentence(session):
    reason = str((session or {}).get("newbie_shift_request_reason") or "").strip()
    details = str((session or {}).get("newbie_shift_request_details") or "").strip().strip(".")
    if not reason and not details:
        return "the schedule needed to change"
    if reason.lower() == "other":
        return details or "another reason"
    if details:
        return f"{reason[:1].lower()}{reason[1:]} ({details})"
    return f"{reason[:1].lower()}{reason[1:]}"


def _is_newbie_reschedule(session):
    return str((session or {}).get("newbie_shift_request_type") or "").strip().lower() == NEWBIE_REQUEST_RESCHEDULE


def _build_reschedule_coaching_summary(session):
    first = _candidate_first_name(session)
    reason = _reschedule_reason_sentence(session)
    schedule = _format_newbie_shift_for_form(session)
    requested_by = str((session or {}).get("newbie_shift_requested_by") or "").strip().lower()
    within_24 = bool((session or {}).get("newbie_shift_within_24_hours"))
    if requested_by == NEWBIE_REQUESTED_BY_TESTER:
        return f"This form was filled to document a Newbie Shift reschedule. The tester requested that {first}'s supervisor transfer test calls be rescheduled because {reason}. The new date and time is {schedule}. This tester-requested change should not count as a candidate attempt."
    if within_24:
        text = f"This form was filled to document a Newbie Shift reschedule. {first} requested that their supervisor transfer test calls be rescheduled because {reason}. The new tentative date and time is {schedule}. The request was received less than 24 hours before the Newbie Shift and will count as an attempt."
        if (session or {}).get("final_attempt"):
            text = f"{text} This session was their final attempt. {first} was instructed to email {CERTIFICATION_SUPPORT_EMAIL}; rescheduling approval is not guaranteed."
        return text
    return f"This form was filled to document a Newbie Shift reschedule. {first} requested that their supervisor transfer test calls be rescheduled because {reason}. The new date and time is {schedule}. The request was received 24 hours or more before the Newbie Shift and should not count as an attempt."


def _build_reschedule_fail_summary(session):
    requested_by = str((session or {}).get("newbie_shift_requested_by") or "").strip().lower()
    if requested_by != NEWBIE_REQUESTED_BY_CANDIDATE or not (session or {}).get("newbie_shift_within_24_hours"):
        return "N/A"
    first = _candidate_first_name(session)
    text = f"{first} requested that their supervisor transfer test calls be rescheduled. The request was received less than 24 hours before the Newbie Shift and will count as an attempt."
    if (session or {}).get("final_attempt"):
        text = f"{text} This session was their final attempt. {first} was instructed to email {CERTIFICATION_SUPPORT_EMAIL}; rescheduling approval is not guaranteed."
    return text


def _map_auto_fail_for_form(auto_fail_reason):
    reason = (auto_fail_reason or "").strip().lower()
    if not reason:
        return "N/A"
    if "same day drop" in reason or "dropped the session within 24 hours" in reason or "dropped within 24 hours" in reason:
        return "NC/NS"
    if "nc/ns" in reason or "nc / ns" in reason:
        return "NC/NS"
    if "stopped responding" in reason:
        return "Stopped responding in chat"
    if "unable to turn off vpn" in reason or "vpn" in reason:
        return "Unable to turn off VPN"
    if "wrong headset" in reason and "usb" in reason:
        return "Wrong headset (not USB)"
    if "wrong headset" in reason and "noise" in reason:
        return "Wrong headset (not noise cancelling)"
    if "not ready for session" in reason:
        return "Not ready for session (incorrect settings, can't get logged in to programs)"
    return "N/A"


def _classify_auto_fail_reason(auto_fail_reason):
    reason = " ".join(str(auto_fail_reason or "").strip().lower().split())
    if not reason:
        return ""
    if "same day drop" in reason or "dropped the session within 24 hours" in reason or "dropped within 24 hours" in reason:
        return "ncns"
    if "nc/ns" in reason or "nc / ns" in reason:
        return "ncns"
    if "stopped responding" in reason:
        return "stopped"
    if "unable to turn off vpn" in reason or "vpn" in reason:
        return "vpn"
    if "wrong headset" in reason:
        return "headset"
    if "not ready" in reason:
        return "not_ready"
    return "other"


def _auto_fail_completion_flags(session):
    if _is_newbie_reschedule(session) and session.get("newbie_shift_counts_as_attempt"):
        return {
            "mock_complete": "Yes" if _count_results(session, "call", 3, "Pass") >= 2 or session.get("supervisor_only", False) else "No",
            "sup_complete": "No",
            "all_complete": "No",
        }

    if not session.get("auto_fail_reason"):
        return None

    return {
        "mock_complete": "Yes" if session.get("supervisor_only", False) else "No",
        "sup_complete": "No",
        "all_complete": "No",
    }


def _completion_flags_for_form(session):
    auto_fail_flags = _auto_fail_completion_flags(session)
    if auto_fail_flags:
        return auto_fail_flags

    final_status = compute_final_status(session)
    sup_only = session.get("supervisor_only", False)
    calls_passed = _count_results(session, "call", 3, "Pass")
    sups_passed = _count_results(session, "sup_transfer", 2, "Pass")

    mock_complete = "Yes" if sup_only or calls_passed >= 2 else "No"
    sup_complete = "Yes" if sups_passed >= 1 else "No"
    all_complete = "Yes" if mock_complete == "Yes" and sup_complete == "Yes" else "No"
    if final_status in {"Pass", "RESUMED-PASS"}:
        mock_complete = "Yes"
        sup_complete = "Yes"
        all_complete = "Yes"
    elif _readiness_override_applied(session) and final_status in {"Fail", "FAIL-Final Attempt", "NC/NS", FINAL_READINESS_NEEDS_RETEST}:
        mock_complete = "No"
        sup_complete = "No"
        all_complete = "No"
    elif final_status in {"Fail", "FAIL-Final Attempt", "NC/NS", FINAL_READINESS_NEEDS_RETEST}:
        all_complete = "No"

    return {
        "mock_complete": mock_complete,
        "sup_complete": sup_complete,
        "all_complete": all_complete,
    }


def _auto_fail_review_summaries(session):
    auto_fail_reason = session.get("auto_fail_reason")
    if not auto_fail_reason:
        return None

    name = (session.get("candidate_name") or session.get("candidate") or "The candidate").strip() or "The candidate"
    auto_fail_type = _classify_auto_fail_reason(auto_fail_reason)
    coaching_lines = []

    if not session.get("supervisor_only", False):
        for i in range(1, 4):
            line = _build_section_coaching_summary(session.get(f"call_{i}"), f"Call {i}")
            if line:
                coaching_lines.append(line)
    for i in range(1, 3):
        line = _build_section_coaching_summary(session.get(f"sup_transfer_{i}"), f"Sup Transfer {i}")
        if line:
            coaching_lines.append(line)

    if auto_fail_type == "ncns":
        auto_fail_text = str(auto_fail_reason or "").strip().lower()
        fail_text = f"{name} dropped the session within 24 hours." if "same day drop" in auto_fail_text or "dropped" in auto_fail_text else f"{name} was a No Call No Show."
        if session.get("supervisor_only") and "same day drop" not in auto_fail_text and "dropped" not in auto_fail_text:
            fail_text = f"{name} was a No Call No Show for the supervisor transfer."
        if session.get("final_attempt"):
            fail_text = f"{fail_text} This session was their final attempt."
        return {"coaching": _append_readiness_override_note("N/A", session), "fail": _append_readiness_override_note(fail_text, session)}
    if auto_fail_type == "not_ready":
        return {"coaching": _append_readiness_override_note("N/A", session), "fail": _append_readiness_override_note(f"{name} was not ready or prepared for the session.", session)}
    if auto_fail_type == "headset":
        other_match = re.search(r"\bother\s*:\s*(.+?)\)?$", str(auto_fail_reason or ""), flags=re.IGNORECASE)
        denial_detail = other_match.group(1).strip() if other_match else ""
        fail_text = f"{name} was not using an approved USB headset with a noise-cancelling microphone."
        if denial_detail:
            fail_text = f"{fail_text} Headset review note: {denial_detail}."
        return {
            "coaching": _append_readiness_override_note(f"{name} was informed that a USB headset with a noise-cancelling microphone is required to contract with ACD.", session),
            "fail": _append_readiness_override_note(fail_text, session),
        }
    if auto_fail_type == "vpn":
        return {
            "coaching": _append_readiness_override_note(f"{name} was informed that the use of a VPN is not acceptable when contracting with ACD.", session),
            "fail": _append_readiness_override_note(f"{name} was using a VPN and was unable to turn it off.", session),
        }
    if auto_fail_type == "stopped":
        return {
            "coaching": _append_readiness_override_note("\n".join(coaching_lines) if coaching_lines else "N/A", session),
            "fail": _append_readiness_override_note(f"{name} stopped responding.", session),
        }
    return {
        "coaching": _append_readiness_override_note("\n".join(coaching_lines) if coaching_lines else "N/A", session),
        "fail": _append_readiness_override_note(_sentence_case(auto_fail_reason) + ".", session),
    }


def _map_tech_issue_for_form(session):
    session = session or {}
    if _is_resumed_sup_transfer_session(session) and not _shared_truthy(session.get("current_session_tech_issue")):
        return {"choice": "N/A", "other_text": ""}

    current = session.get("tech_issue")
    logs = [entry.get("issue", "") for entry in session.get("tech_issues_log", []) if isinstance(entry, dict)]
    candidates = [current, *reversed(logs)]

    for candidate in candidates:
        issue = (candidate or "").strip()
        lowered = issue.lower()
        if not issue or issue == "N/A":
            continue
        if lowered.startswith("other:"):
            other_text = issue.split(":", 1)[1].strip() or "Other"
            return {"choice": "Other", "other_text": other_text}
        if "no script pop" in lowered:
            return {"choice": "No script pop", "other_text": ""}
        if "calls would not route" in lowered:
            return {"choice": "Calls would not route", "other_text": ""}
        if "discord issues" in lowered:
            return {"choice": "Discord issues", "other_text": ""}
        if "internet speed" in lowered:
            return {"choice": "Internet speed issues", "other_text": ""}

    return {"choice": "N/A", "other_text": ""}


def build_form_fill_payload(session, settings, coaching_summary="", fail_summary=""):
    session = _session_with_workflow_defaults(session)
    sup_only = session.get("supervisor_only", False)
    tech_issue = _map_tech_issue_for_form(session)
    summaries = generate_summaries(session)
    completion_flags = _completion_flags_for_form(session)

    fail_reason = "N/A"
    if _is_newbie_reschedule(session):
        coaching_summary = coaching_summary or _build_reschedule_coaching_summary(session)
        fail_summary = fail_summary or _build_reschedule_fail_summary(session)

    if not _is_fail_na(session):
        fail_reason = (fail_summary or "").strip() or summaries["fail"]
        fail_reason = _ensure_final_attempt_fail_summary(fail_reason, session)

    return {
        "tester_name": (session.get("tester_name") or settings.get("tester_name") or settings.get("display_name") or "").strip(),
        "candidate_name": (session.get("candidate_name") or session.get("candidate") or "").strip(),
        "skills": ["Supervisor Transfer"] if sup_only else ["Mock Calls", "Supervisor Transfer"],
        "mock_complete": completion_flags["mock_complete"],
        "sup_complete": completion_flags["sup_complete"],
        "all_complete": completion_flags["all_complete"],
        "newbie_shift": _format_newbie_shift_for_form(session),
        "auto_fail": "NC/NS" if _is_newbie_reschedule(session) and session.get("newbie_shift_counts_as_attempt") else _map_auto_fail_for_form(session.get("auto_fail_reason")),
        "headset": _format_headset_for_form(session),
        "tech_issue_choice": tech_issue["choice"],
        "tech_issue_other": tech_issue["other_text"],
        "coaching": (coaching_summary or "").strip() or summaries["coaching"],
        "fail_reason": fail_reason,
    }


async def _record_form_fill_status(session, status, error_summary=""):
    status = _normalize_form_fill_status(status)
    now = datetime.now(timezone.utc).isoformat()
    update = {
        "form_fill_status": status,
        "form_fill_error_summary": str(error_summary or "")[:500],
    }
    if status == FORM_FILL_FILLED:
        update["form_filled_at"] = now

    active = await db.sessions.find_one({"_id": "active_session"})
    active_matches = False
    if active:
        active_id = str(active.get("history_id") or active.get("resume_source_history_id") or "").strip()
        session_id = str((session or {}).get("history_id") or (session or {}).get("resume_source_history_id") or "").strip()
        active_matches = not session_id or active_id == session_id or str(active.get("candidate_name") or "") == str((session or {}).get("candidate_name") or (session or {}).get("candidate") or "")
    if active_matches:
        await db.sessions.update_one({"_id": "active_session"}, {"$set": update}, upsert=False)

    history_id = str((session or {}).get("history_id") or "").strip()
    if history_id:
        rows = db.history.store.fetchall("SELECT id, data FROM history_documents ORDER BY id DESC")
        for row in rows:
            existing = SQLiteCollection.decode(row["data"])
            if not _history_record_matches_identifier(existing, history_id):
                continue
            existing.update(update)
            db.history.store.execute(
                "UPDATE history_documents SET data = ?, timestamp = ? WHERE id = ?",
                (SQLiteCollection.encode(existing), existing.get("timestamp") or "", row["id"]),
            )
            break
    return update


async def _safe_record_form_fill_status(session, status, error_summary=""):
    try:
        update = await _record_form_fill_status(session, status, error_summary)
        return {"ok": True, "update": update, "error": ""}
    except Exception as exc:
        logger.exception("[FORM-FILL] Form automation completed but status persistence failed: %s", exc)
        return {"ok": False, "update": {}, "error": "MTS could not update the session form-fill status."}


async def import_sqlite_seed_if_requested():
    """Optional one-time JSON import for Mongo exports; skipped once SQLite has data."""
    import_path = (os.getenv("SQLITE_IMPORT_PATH") or "").strip()
    if not import_path:
        return

    seed_path = Path(import_path).expanduser()
    if not seed_path.is_file():
        logger.warning("[MIGRATION] SQLITE_IMPORT_PATH does not exist: %s", seed_path)
        return

    if await db.has_any_data():
        logger.info("[MIGRATION] SQLite already has data; skipping import from %s", seed_path)
        return

    with seed_path.open("r", encoding="utf-8") as f:
        seed = json.load(f)

    settings = seed.get("settings")
    if isinstance(settings, dict):
        settings_doc = SQLiteCollection.clone(settings)
        settings_doc["_id"] = "app_settings"
        await db.settings.replace_one({"_id": "app_settings"}, settings_doc, upsert=True)

    active_session = seed.get("active_session") or seed.get("session")
    if isinstance(active_session, dict):
        session_doc = SQLiteCollection.clone(active_session)
        session_doc["_id"] = "active_session"
        await db.sessions.replace_one({"_id": "active_session"}, session_doc, upsert=True)

    history = seed.get("history") or []
    if isinstance(history, list):
        for record in history:
            if isinstance(record, dict):
                await db.history.insert_one(record)

    logger.info("[MIGRATION] Imported SQLite seed data from %s", seed_path)


# ══════════════════════════════════════════════════════════════════
# APP SETUP
# ══════════════════════════════════════════════════════════════════
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _shadow_runtime
    _shadow_runtime = ShadowComparisonRuntime(_runtime_shadow_provider_factory)
    _shadow_runtime.start()
    await import_sqlite_seed_if_requested()
    logger.info("[STARTUP] SQLite ready")
    _log_startup_runtime_diagnostics()

    # Ensure default settings exist
    existing = await db.settings.find_one({"_id": "app_settings"})
    if not existing:
        initial_settings = {
            key: value
            for key, value in DEFAULT_SETTINGS.items()
            if key not in DEFAULT_MANAGED_SETTINGS_KEYS
        }
        await db.settings.insert_one({"_id": "app_settings", **initial_settings})
        logger.info("[STARTUP] Created default settings")
    else:
        # Migrate: backfill any missing fields from defaults
        updates = {}
        unsets = {}
        legacy_gemini_api_key = _get_stored_gemini_api_key(existing)
        if legacy_gemini_api_key and not str(existing.get(GEMINI_API_KEY_SETTING) or "").strip():
            updates[GEMINI_API_KEY_SETTING] = legacy_gemini_api_key
        for legacy_key in LEGACY_GEMINI_API_KEY_SETTINGS:
            if legacy_key in existing:
                unsets[legacy_key] = ""
        for key, val in DEFAULT_SETTINGS.items():
            if key in DEFAULT_MANAGED_SETTINGS_KEYS:
                continue
            if key in updates:
                continue
            if key not in existing:
                updates[key] = val
        for key in DEFAULT_MANAGED_SETTINGS_KEYS:
            if key in existing and not existing.get(_managed_custom_flag(key)):
                unsets[key] = ""
                unsets[_managed_custom_flag(key)] = ""
                logger.info(
                    "[SAM] Cache invalidated for %s: saved SQLite value had no customization marker and will follow active defaults.",
                    key,
                )
        if updates or unsets:
            await db.settings.update_one({"_id": "app_settings"}, {"$set": updates, "$unset": unsets})
            logger.info(f"[STARTUP] Migrated settings: {list(updates.keys())}")
        for key in ("shows", "donors_new", "donors_existing", "donors_increase", "discord_templates", "discord_screenshots"):
            if key in existing and existing.get(_managed_custom_flag(key)):
                logger.info(
                    "[CONTENT] %s served from SQLite customized settings (%s item(s)); defaults source is %s (%s item(s))",
                    key,
                    _content_count(existing.get(key)),
                    (_content_source_status.get(key) or {}).get("source") or "builtin",
                    (_content_source_status.get(key) or {}).get("count") or 0,
                )
                logger.info("[SAM] Active %s source: SQLite customized settings (%s item(s))", key, _content_count(existing.get(key)))
            elif key in existing:
                logger.info(
                    "[CONTENT] %s saved value has no customization marker and will follow %s defaults (%s item(s))",
                    key,
                    (_content_source_status.get(key) or {}).get("source") or "builtin",
                    (_content_source_status.get(key) or {}).get("count") or 0,
                )
                logger.info("[SAM] Active %s source: defaults after cache invalidation", key)
    
    # Schedule background remote content refresh and sheet verification
    import asyncio
    asyncio.create_task(_background_remote_content_task())

    logger.info(f"[STARTUP] Mock Testing Suite v{APP_VERSION}")
    logger.info("[STARTUP] server health ready")
    yield
    if _shadow_runtime is not None:
        _shadow_runtime.shutdown(wait=True)
        _shadow_runtime = None
    _gemini_executor.shutdown(wait=False, cancel_futures=True)
    db.close()
    logger.info("[SHUTDOWN] Server stopped")


app = FastAPI(title="Mock Testing Suite", version=APP_VERSION, lifespan=lifespan)
api_router = APIRouter(prefix="/api")

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get(
        "CORS_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,file://",
    ).split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_packaged_app_token(request: Request, call_next):
    # Only enforce admin token when configured and request is an API call
    try:
        path = (request.url.path or "")
    except Exception:
        path = ""

    def _requires_admin_auth(p: str) -> bool:
        p_clean = p.rstrip("/")
        # paths starting with /api/admin/
        if p_clean == "/api/admin" or p_clean.startswith("/api/admin/"):
            return True
        # paths starting with /api/shared/admin/
        if p_clean == "/api/shared/admin" or p_clean.startswith("/api/shared/admin/"):
            return True
        # /api/sam/setup/reset
        if p_clean == "/api/sam/setup/reset" or p_clean.startswith("/api/sam/setup/reset/"):
            return True
        # explicit admin verification/diagnostic routes
        if p_clean == "/api/runtime/verify-token" or p_clean.startswith("/api/runtime/verify-token/"):
            return True
        if p_clean == "/api/driver-diagnostics" or p_clean.startswith("/api/driver-diagnostics/"):
            return True
        return False

    if (
        _admin_token_configured()
        and path.startswith("/api")
        and _requires_admin_auth(path)
        and request.method.upper() not in {"OPTIONS"}
    ):
        logger.warning("[AUTH] Admin token required for packaged request: %s %s", request.method.upper(), path)
        try:
            _require_admin_token(request)
        except HTTPException as exc:
            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    return await call_next(request)


# Lightweight health endpoint used by Electron to verify backend readiness.
@api_router.get("/health")
async def health_check():
    return {"ok": True, "status": "ready", "version": APP_VERSION}


# ══════════════════════════════════════════════════════════════════
# SETTINGS ROUTES
# ══════════════════════════════════════════════════════════════════
@api_router.get("/settings")
async def get_settings():
    doc = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0})
    return sanitize_settings(doc)


@api_router.put("/settings")
async def save_settings(payload: dict, request: Request):
    if any(k in payload for k in ADMIN_CONTROLLED_SETTINGS_KEYS):
        _require_admin_token(request)
    update_ops = normalize_settings_payload(payload)
    updates = update_ops.get("$set", {})
    unsets = update_ops.get("$unset", {})
    if not updates and not unsets:
        return {"ok": True}
    await db.settings.update_one(
        {"_id": "app_settings"},
        {"$set": updates, "$unset": unsets},
        upsert=True
    )
    return {"ok": True}


@api_router.get("/admin/settings")
async def get_admin_settings(request: Request):
    _require_admin_token(request)
    doc = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0})
    return sanitize_settings(doc)


@api_router.put("/admin/settings")
async def save_admin_settings(payload: dict, request: Request):
    _require_admin_token(request)
    return await save_settings(payload, request)


@api_router.post("/settings/restore-defaults")
async def restore_settings_defaults(request: Request):
    existing = await db.settings.find_one({"_id": "app_settings"}) or {}
    db.backup("before-restore-defaults")
    restored = {
        key: value
        for key, value in DEFAULT_SETTINGS.items()
        if key not in DEFAULT_MANAGED_SETTINGS_KEYS
    }

    for key in PRESERVED_SETTINGS_KEYS_ON_RESTORE:
        if key in existing:
            restored[key] = existing[key]

    await db.settings.replace_one(
        {"_id": "app_settings"},
        {"_id": "app_settings", **restored},
        upsert=True,
    )
    return {"ok": True, "settings": sanitize_settings(restored)}


@api_router.post("/settings/reset-section")
async def reset_settings_section(payload: dict, request: Request):
    section = str((payload or {}).get("section") or "").strip()
    resettable_sections = {
        "discord_templates",
        "discord_screenshots",
        "callers",
        "shows",
        "call_types",
        "sup_reasons",
        "call_coaching",
        "sup_coaching",
        "call_fails",
        "sup_fails",
    }
    if section not in resettable_sections:
        raise HTTPException(status_code=400, detail="Unsupported settings section")

    if section == "callers":
        updates = {}
        unsets = {
            "donors_new": "",
            "donors_existing": "",
            "donors_increase": "",
            _managed_custom_flag("donors_new"): "",
            _managed_custom_flag("donors_existing"): "",
            _managed_custom_flag("donors_increase"): "",
        }
    else:
        updates = {}
        unsets = {section: "", _managed_custom_flag(section): ""}

    await db.settings.update_one({"_id": "app_settings"}, {"$set": updates, "$unset": unsets}, upsert=True)

    doc = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0})
    return {"ok": True, "section": section, "settings": sanitize_settings(doc)}


_managed_content_refresh_lock = threading.Lock()
_managed_content_refresh_last_success = 0.0


def _refresh_managed_content_sections(section_keys):
    global DISCORD_TEMPLATES
    global EXTERNAL_CONTENT
    global _managed_content_refresh_last_success

    runtime_config = _load_backend_runtime_config()
    sheet_id = _resolve_content_sheet_id(runtime_config or {})
    if not sheet_id:
        return False

    refreshed = False
    with _managed_content_refresh_lock:
        for content_key in section_keys:
            tab_name = CONTENT_SHEET_TAB_MAP.get(content_key)
            parser = CONTENT_SHEET_PARSERS.get(content_key)
            if not tab_name or not parser:
                continue
            try:
                csv_text = _fetch_google_sheet_tab_csv(sheet_id, tab_name)
                parsed = parser(csv_text)
            except Exception as exc:
                logger.info("[CONTENT] Managed refresh delayed for %s: %s", content_key, exc)
                continue
            primary_value = parsed.get(content_key)
            if not primary_value:
                continue
            for key, value in parsed.items():
                if value:
                    EXTERNAL_CONTENT[key] = value
                    _set_content_source(key, "google", value, ok=True, detail="manual_refresh")
                    _content_source_status[key]["background_status"] = "completed"
                    _content_source_status[key]["background_loading"] = False
            if content_key == "discord_templates":
                DISCORD_TEMPLATES = parsed["discord_templates"]
                DEFAULT_SETTINGS["discord_templates"] = DISCORD_TEMPLATES
            elif content_key == "approved_headsets":
                _headset_cache["groups"] = parsed.get("approved_headsets") or []
                _headset_cache["denied"] = parsed.get("denied_headsets") or []
                _headset_cache["last_fetch"] = time.time()
            refreshed = True
        if refreshed:
            _managed_content_refresh_last_success = time.time()
    return refreshed


@api_router.get("/settings/defaults")
async def get_defaults(refresh: bool = False):
    if refresh:
        await asyncio.to_thread(
            _refresh_managed_content_sections,
            ("discord_templates", "approved_headsets"),
        )
    discord_source = _content_source_status.get("discord_templates") or {}
    logger.info(
        "[DISCORD DEFAULTS] Serving templates source=%s count=%s",
        discord_source.get("source") or "unknown",
        discord_source.get("count") or 0,
    )
    return {
        "call_types": CALL_TYPES,
        "sup_reasons": SUP_REASONS,
        "shows": SHOWS,
        "donors_new": NEW_DONORS,
        "donors_existing": EXISTING_MEMBERS,
        "donors_increase": INCREASE_SUSTAINING,
        "discord_templates": DISCORD_TEMPLATES,
        "discord_screenshots": DISCORD_SCREENSHOTS,
        "call_coaching": CALL_COACHING,
        "call_fails": CALL_FAILS,
        "sup_coaching": SUP_COACHING,
        "sup_fails": SUP_FAILS,
        "payment": DEFAULT_PAYMENT,
        "tech_issues": TECH_ISSUES,
        "auto_fail_reasons": AUTO_FAIL_REASONS,
        "_content_sources": _content_source_status,
        "approved_headsets": _headset_cache.get("groups") or EXTERNAL_CONTENT.get("approved_headsets") or [],
    }


HELP_DOC_REFRESH_TTL_SECONDS = 60
_help_doc_cache = {
    "help_markdown": None,
    "faq_markdown": None,
    "last_fetch": 0.0,
}


def _refresh_help_and_faq_markdown():
    """Refresh help_markdown and faq_markdown from the configured Google Docs
    on a TTL so admins can update either doc without restarting the app.
    Falls back to the last good content (or the built-in defaults) on failure."""
    import time

    now = time.time()
    cached_help = _help_doc_cache["help_markdown"]
    cached_faq = _help_doc_cache["faq_markdown"]
    if (
        cached_help is not None
        and cached_faq is not None
        and (now - _help_doc_cache["last_fetch"]) < HELP_DOC_REFRESH_TTL_SECONDS
    ):
        return cached_help, cached_faq

    help_text = cached_help if cached_help else HELP_DOC_MARKDOWN
    faq_text = cached_faq if cached_faq else FAQ_DOC_MARKDOWN

    try:
        runtime_config = _load_backend_runtime_config()
        overrides = _load_help_faq_google_doc_overrides(runtime_config) or {}
    except Exception as exc:
        logger.warning("[HELP] Live Google Doc refresh failed: %s. Using last good content.", exc)
        overrides = {}

    fresh_help = (overrides.get("help_markdown") or "").strip()
    if fresh_help:
        help_text = fresh_help

    fresh_faq = (overrides.get("faq_markdown") or "").strip()
    if fresh_faq:
        faq_text = fresh_faq

    _help_doc_cache["help_markdown"] = help_text
    _help_doc_cache["faq_markdown"] = faq_text
    _help_doc_cache["last_fetch"] = now
    return help_text, faq_text


@api_router.get("/help/content")
async def get_help_content():
    import asyncio

    help_text, faq_text = await asyncio.to_thread(_refresh_help_and_faq_markdown)
    return {
        **HELP_CONTENT,
        "help_markdown": help_text,
        "faq_markdown": faq_text,
        "tutorial_videos": {
            "mts": EXTERNAL_CONTENT.get("mts_tutorial_videos") or [],
            "sam": EXTERNAL_CONTENT.get("sam_tutorial_videos") or [],
        },
        "tutorial_video_source": {
            "mts": (_content_source_status.get("mts_tutorial_videos") or {}).get("source") or "local_csv",
            "sam": (_content_source_status.get("sam_tutorial_videos") or {}).get("source") or "local_csv",
        },
    }


@api_router.post("/settings/complete-setup")
async def complete_setup(payload: dict, request: Request):
    update_data = {
        "setup_complete": True,
        "tester_name": payload.get("tester_name", ""),
        "display_name": payload.get("display_name", ""),
    }
    if "form_url" in payload:
        update_data["form_url"] = payload["form_url"]
    if "cert_sheet_url" in payload:
        update_data["cert_sheet_url"] = payload["cert_sheet_url"]
    if "ticker_speed" in payload:
        ticker_speed = str(payload.get("ticker_speed") or "normal").strip().lower()
        update_data["ticker_speed"] = ticker_speed if ticker_speed in {"slow", "normal", "fast"} else "normal"
    if "welcome_voice" in payload:
        update_data["welcome_voice"] = _normalize_welcome_voice(payload.get("welcome_voice"))
    if "sound_volume" in payload:
        update_data["sound_volume"] = _normalize_sound_volume(payload.get("sound_volume"), payload.get("enable_sounds", True))
        update_data["enable_sounds"] = update_data["sound_volume"] != "off"
    await db.settings.update_one({"_id": "app_settings"}, {"$set": update_data}, upsert=True)
    return {"ok": True}


# ══════════════════════════════════════════════════════════════════
# SESSION ROUTES
# ══════════════════════════════════════════════════════════════════
@api_router.get("/session/current")
async def get_current_session():
    await asyncio.to_thread(_reconcile_remote_newbie_requests_into_local_state)
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if doc:
        return {"session": doc, "has_active": bool(doc.get("candidate_name"))}
    return {"session": None, "has_active": False}


@api_router.get("/session/attempt-state")
async def get_session_attempt_state():
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if not doc:
        return {"ok": False, "error": "No active session", "attemptState": None}

    candidate_name = " ".join(str(doc.get("candidate_name") or "").lower().split())
    history = await db.history.find({}, {"_id": 0}).to_list(5000)
    candidate_history = [
        row for row in history
        if " ".join(str(row.get("candidate_name") or row.get("candidate") or "").lower().split()) == candidate_name
    ]
    attempt_state = calculate_candidate_attempt_state(candidate_history, active_session=doc)
    active_counts, _ = _candidate_attempt_disposition(doc)
    patch = {"attempt_state": attempt_state}
    if active_counts:
        if attempt_state["terminal"]:
            patch.update({
                "final_attempt": True,
                "supervisor_retry_required": False,
                "final_status": "FAIL-Final Attempt",
            })
        elif attempt_state["retry_allowed"]:
            patch.update({
                "supervisor_retry_required": True,
                "next_attempt_number": attempt_state["current_attempt"],
                "final_attempt": attempt_state["final_attempt"],
                "final_status": "Incomplete",
            })
    await db.sessions.update_one({"_id": "active_session"}, {"$set": patch}, upsert=False)
    return {
        "ok": True,
        "attemptState": attempt_state,
        "retryAllowed": bool(attempt_state["retry_allowed"] and not attempt_state["terminal"]),
        "retryIsFinalAttempt": bool(attempt_state["final_attempt"] and not attempt_state["terminal"]),
        "terminal": attempt_state["terminal"],
        "sessionPatch": patch,
    }


@api_router.get("/shared/candidates/lookup")
async def lookup_shared_candidate(name: str = ""):
    await asyncio.to_thread(_reconcile_remote_newbie_requests_into_local_state)
    result = await asyncio.to_thread(_lookup_shared_candidate_sessions, name)
    _schedule_shadow_domains("candidate_tracking")
    return result


@api_router.get("/shared/pending-sup-transfers")
async def get_shared_pending_sup_transfers():
    result = await asyncio.to_thread(_get_shared_pending_sup_transfers)
    _schedule_shadow_domains("supervisor_transfers")
    return result


RESIDENTIAL_USAGE_MARKERS = (
    "residential",
    "fixed line",
    "fixed-line",
    "fixed_line",
    "cable",
    "fiber",
    "fibre",
    "dsl",
    "isp",
)

RISK_USAGE_MARKERS = (
    "vpn",
    "proxy",
    "hosting",
    "datacenter",
    "data center",
    "tor",
    "residential proxy",
)


class IpIntelligenceProvider:
    name = "provider"
    requires_key = False
    env_key = ""
    enabled_env = ""
    default_enabled = True
    capability = "vpn_proxy_detector"
    reputation_capable = True

    def enabled(self):
        env_val = os.getenv(self.enabled_env or "")
        if env_val is None or env_val == "":
            try:
                config = _load_backend_runtime_config()
                env_val = config.get(self.enabled_env) or config.get((self.enabled_env or "").lower())
            except Exception:
                pass
        enabled_value = str(env_val if env_val is not None and env_val != "" else self.default_enabled).strip().lower()
        if enabled_value in {"0", "false", "no", "off", "disabled"}:
            return False, "disabled"
        if self.requires_key and not self.api_key():
            return False, "missing_api_key"
        return True, ""

    def api_key(self):
        val = os.getenv(self.env_key or "")
        if val:
            return val.strip()
        try:
            config = _load_backend_runtime_config()
            val = config.get(self.env_key) or config.get((self.env_key or "").lower())
            if val:
                return str(val).strip()
        except Exception:
            pass
        return ""

    async def lookup(self, ip_value):
        raise NotImplementedError


def _provider_capability_value(provider_or_capability, reputation_capable=True):
    if isinstance(provider_or_capability, str) and provider_or_capability in {"vpn_proxy_detector", "metadata_only"}:
        return provider_or_capability
    if hasattr(provider_or_capability, "capability"):
        return getattr(provider_or_capability, "capability") or ("vpn_proxy_detector" if reputation_capable else "metadata_only")
    return "vpn_proxy_detector" if reputation_capable else "metadata_only"


def _empty_ip_provider_result(provider, status="unavailable", notes="", reputation_capable=True, capability=None):
    resolved_capability = capability or _provider_capability_value(capability, reputation_capable)
    return {
        "provider": provider,
        "status": status,
        "vpnProxy": "Unknown",
        "lastSeen": "",
        "isp": "",
        "asn": "",
        "usageType": "",
        "country": "",
        "region": "",
        "city": "",
        "connectionType": "",
        "confidence": "Unknown",
        "notes": notes,
        "reputationCapable": reputation_capable,
        "capability": resolved_capability,
        "flags": {
            "vpn": False,
            "proxy": False,
            "hosting": False,
            "datacenter": False,
            "tor": False,
            "residential_proxy": False,
            "active": False,
            "historical": False,
            "residential": False,
        },
    }


def _ip_safe_bool(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def _contains_any(value, markers):
    text = str(value or "").strip().lower()
    return any(marker in text for marker in markers)


def _parse_ip_last_seen(value):
    if not value:
        return None
    text = str(value).strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%d-%m-%Y %H:%M:%S", "%d-%m-%Y"):
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _last_seen_older_than(value, hours):
    parsed = _parse_ip_last_seen(value)
    if not parsed:
        return False
    return datetime.now(timezone.utc) - parsed > timedelta(hours=hours)


def _normalize_ip_provider_result(result):
    flags = result.get("flags") or {}
    capability = result.get("capability") or ("vpn_proxy_detector" if result.get("reputationCapable", True) else "metadata_only")
    detector_capable = capability == "vpn_proxy_detector" and bool(result.get("reputationCapable", capability == "vpn_proxy_detector"))
    usage_type = result.get("usageType") or ""
    connection = result.get("connectionType") or ""
    isp = result.get("isp") or ""
    note_text = result.get("notes") or ""
    combined = " ".join([str(usage_type), str(connection), str(isp), str(note_text)])
    risk_from_usage = _contains_any(combined, RISK_USAGE_MARKERS)
    residential = bool(flags.get("residential")) or _contains_any(" ".join([str(usage_type), str(connection), str(isp)]), RESIDENTIAL_USAGE_MARKERS)
    risk_flags = {
        "vpn": bool(flags.get("vpn")),
        "proxy": bool(flags.get("proxy")),
        "hosting": bool(flags.get("hosting")),
        "datacenter": bool(flags.get("datacenter")),
        "tor": bool(flags.get("tor")),
        "residential_proxy": bool(flags.get("residential_proxy")),
    }
    if risk_from_usage:
        lowered = combined.lower()
        risk_flags["vpn"] = risk_flags["vpn"] or "vpn" in lowered
        risk_flags["proxy"] = risk_flags["proxy"] or "proxy" in lowered
        risk_flags["hosting"] = risk_flags["hosting"] or "hosting" in lowered
        risk_flags["datacenter"] = risk_flags["datacenter"] or "datacenter" in lowered or "data center" in lowered
        risk_flags["tor"] = risk_flags["tor"] or "tor" in lowered
    if not detector_capable:
        risk_flags = {
            "vpn": False,
            "proxy": False,
            "hosting": False,
            "datacenter": False,
            "tor": False,
            "residential_proxy": False,
        }
    has_risk = any(risk_flags.values())
    normalized_flags = {
        **flags,
        **risk_flags,
        "active": bool(flags.get("active")),
        "historical": bool(flags.get("historical")),
        "residential": residential,
    }
    vpn_proxy_value = result.get("vpnProxy") or ("Yes" if has_risk else "No")
    if not detector_capable:
        vpn_proxy_value = "Unknown"
    return {
        **_empty_ip_provider_result(result.get("provider") or "provider"),
        **result,
        "status": result.get("status") or "ok",
        "vpnProxy": vpn_proxy_value,
        "confidence": result.get("confidence") or ("High" if has_risk else "Medium"),
        "reputationCapable": detector_capable,
        "capability": capability,
        "flags": normalized_flags,
    }


class IP2LocationProvider(IpIntelligenceProvider):
    name = "IP2Location / IP2Proxy"
    requires_key = True
    env_key = "IP2PROXY_API_KEY"
    enabled_env = "IP2PROXY_ENABLED"
    capability = "vpn_proxy_detector"

    async def lookup(self, ip_value):
        params = {"key": self.api_key(), "ip": ip_value, "package": os.getenv("IP2PROXY_PACKAGE", "PX11")}
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get("https://api.ip2proxy.com/", params=params)
            response.raise_for_status()
            data = response.json()
        if str(data.get("response") or "").upper() == "ERROR":
            raise RuntimeError(str(data.get("message") or "IP2Proxy returned an error."))
        proxy_value = str(data.get("is_proxy") or data.get("proxy") or "").strip().upper()
        usage_type = str(data.get("usage_type") or "").strip()
        last_seen = str(data.get("last_seen") or "").strip()
        is_proxy = proxy_value in {"1", "YES", "Y", "TRUE"}
        historical_residential = is_proxy and _last_seen_older_than(last_seen, 48) and _contains_any(usage_type, RESIDENTIAL_USAGE_MARKERS)
        return _normalize_ip_provider_result({
            "provider": self.name,
            "status": "ok",
            "vpnProxy": "Yes" if is_proxy else "No",
            "lastSeen": last_seen,
            "isp": data.get("isp") or "",
            "asn": str(data.get("asn") or data.get("as") or ""),
            "usageType": usage_type,
            "country": data.get("country_name") or data.get("countryCode") or data.get("country") or "",
            "region": data.get("region_name") or data.get("region") or "",
            "city": data.get("city_name") or data.get("city") or "",
            "connectionType": data.get("proxy_type") or "",
            "confidence": "Medium" if historical_residential else ("High" if is_proxy else "Medium"),
            "notes": "Historical residential proxy signal." if historical_residential else "",
            "reputationCapable": True,
            "capability": self.capability,
            "flags": {
                "vpn": is_proxy and not historical_residential,
                "proxy": is_proxy,
                "hosting": _contains_any(usage_type, ("hosting", "datacenter", "data center")),
                "datacenter": _contains_any(usage_type, ("datacenter", "data center")),
                "residential_proxy": historical_residential,
                "active": is_proxy and not historical_residential,
                "historical": historical_residential,
                "residential": _contains_any(usage_type, RESIDENTIAL_USAGE_MARKERS),
            },
        })


class IPinfoProvider(IpIntelligenceProvider):
    name = "IPinfo.io"
    requires_key = True
    env_key = "IPINFO_TOKEN"
    enabled_env = "IPINFO_ENABLED"
    capability = "vpn_proxy_detector"

    async def lookup(self, ip_value):
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(f"https://ipinfo.io/{quote(ip_value)}/json", params={"token": self.api_key()})
            response.raise_for_status()
            data = response.json()
        privacy = data.get("privacy") or {}
        has_privacy_fields = any(key in privacy for key in ("vpn", "proxy", "hosting", "tor"))
        company = data.get("company") or {}
        asn = data.get("asn") or {}
        flags = {
            "vpn": _ip_safe_bool(privacy.get("vpn")),
            "proxy": _ip_safe_bool(privacy.get("proxy")),
            "hosting": _ip_safe_bool(privacy.get("hosting")),
            "datacenter": False,
            "tor": _ip_safe_bool(privacy.get("tor")),
            "active": any(_ip_safe_bool(privacy.get(key)) for key in ("vpn", "proxy", "hosting", "tor")),
        }
        capability = self.capability if has_privacy_fields else "metadata_only"
        return _normalize_ip_provider_result({
            "provider": self.name,
            "status": "ok" if has_privacy_fields else "metadata",
            "isp": data.get("org") or company.get("name") or "",
            "asn": asn.get("asn") or "",
            "usageType": company.get("type") or asn.get("type") or "",
            "country": data.get("country") or "",
            "region": data.get("region") or "",
            "city": data.get("city") or "",
            "connectionType": "privacy" if flags["active"] else "",
            "confidence": "High" if flags["active"] else "Medium",
            "notes": "" if has_privacy_fields else "Metadata only. IPinfo privacy fields were not available in this response.",
            "reputationCapable": has_privacy_fields,
            "capability": capability,
            "flags": flags,
        })


class IPQualityScoreProvider(IpIntelligenceProvider):
    name = "IPQualityScore"
    requires_key = True
    env_key = "IPQUALITYSCORE_KEY"
    enabled_env = "IPQUALITYSCORE_ENABLED"
    capability = "vpn_proxy_detector"

    async def lookup(self, ip_value):
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(
                f"https://ipqualityscore.com/api/json/ip/{quote(self.api_key())}/{quote(ip_value)}",
                params={"strictness": os.getenv("IPQUALITYSCORE_STRICTNESS", "1"), "allow_public_access_points": "true"},
            )
            response.raise_for_status()
            data = response.json()
        is_vpn = _ip_safe_bool(data.get("vpn"))
        is_proxy = _ip_safe_bool(data.get("proxy") or data.get("active_vpn") or data.get("active_proxy"))
        is_tor = _ip_safe_bool(data.get("tor"))
        is_hosting = _ip_safe_bool(data.get("hosting") or data.get("data_center"))
        is_risk = is_vpn or is_proxy or is_tor or is_hosting
        return _normalize_ip_provider_result({
            "provider": self.name,
            "status": "ok",
            "vpnProxy": "Yes" if is_risk else "No",
            "isp": data.get("ISP") or data.get("organization") or "",
            "asn": str(data.get("ASN") or ""),
            "usageType": data.get("connection_type") or "",
            "country": data.get("country") or data.get("country_code") or "",
            "region": data.get("region") or "",
            "city": data.get("city") or "",
            "connectionType": data.get("connection_type") or "",
            "confidence": "High" if is_risk else "Medium",
            "reputationCapable": True,
            "capability": self.capability,
            "flags": {
                "vpn": is_vpn,
                "proxy": is_proxy,
                "hosting": is_hosting,
                "datacenter": is_hosting,
                "tor": is_tor,
                "active": is_risk,
                "residential_proxy": _ip_safe_bool(data.get("active_proxy")) and not is_hosting,
            },
        })


class AbuseIpDbProvider(IpIntelligenceProvider):
    name = "AbuseIPDB"
    requires_key = True
    env_key = "ABUSEIPDB_API_KEY"
    enabled_env = "ABUSEIPDB_ENABLED"
    capability = "vpn_proxy_detector"

    async def lookup(self, ip_value):
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(
                "https://api.abuseipdb.com/api/v2/check",
                params={"ipAddress": ip_value, "maxAgeInDays": os.getenv("ABUSEIPDB_MAX_AGE_DAYS", "30"), "verbose": "true"},
                headers={"Key": self.api_key(), "Accept": "application/json"},
            )
            response.raise_for_status()
            data = (response.json() or {}).get("data") or {}
        usage_type = str(data.get("usageType") or "")
        domain = str(data.get("domain") or "")
        risk_usage = _contains_any(" ".join([usage_type, domain]), RISK_USAGE_MARKERS)
        active = risk_usage and not _contains_any(usage_type, RESIDENTIAL_USAGE_MARKERS)
        return _normalize_ip_provider_result({
            "provider": self.name,
            "status": "ok",
            "vpnProxy": "Yes" if active else "No",
            "lastSeen": data.get("lastReportedAt") or "",
            "isp": data.get("isp") or "",
            "usageType": usage_type,
            "country": data.get("countryName") or data.get("countryCode") or "",
            "confidence": "Medium" if active else "Informational",
            "notes": f"Abuse confidence score: {data.get('abuseConfidenceScore', 0)}",
            "reputationCapable": True,
            "capability": self.capability,
            "flags": {
                "vpn": "vpn" in usage_type.lower(),
                "proxy": "proxy" in usage_type.lower(),
                "hosting": _contains_any(usage_type, ("hosting", "datacenter", "data center")),
                "datacenter": _contains_any(usage_type, ("datacenter", "data center")),
                "tor": "tor" in usage_type.lower(),
                "active": active,
                "residential": _contains_any(usage_type, RESIDENTIAL_USAGE_MARKERS),
                "historical": bool(data.get("lastReportedAt")) and _last_seen_older_than(data.get("lastReportedAt"), 48),
            },
        })


class ProxyCheckProvider(IpIntelligenceProvider):
    name = "proxycheck.io"
    env_key = "PROXYCHECK_IO_KEY"
    enabled_env = "PROXYCHECK_IO_ENABLED"
    capability = "vpn_proxy_detector"

    async def lookup(self, ip_value):
        params = {
            "vpn": "1",
            "asn": "1",
            "node": "1",
            "risk": "1",
            "port": "1",
        }
        if self.api_key():
            params["key"] = self.api_key()
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(f"https://proxycheck.io/v2/{quote(ip_value)}", params=params)
            response.raise_for_status()
            data = response.json()
        ip_data = data.get(ip_value) or data.get(str(ip_value)) or {}
        proxy_value = str(ip_data.get("proxy") or "").lower()
        proxy_type = str(ip_data.get("type") or "")
        is_risk = proxy_value in {"yes", "true", "1"} or _contains_any(proxy_type, RISK_USAGE_MARKERS)
        return _normalize_ip_provider_result({
            "provider": self.name,
            "status": "ok",
            "vpnProxy": "Yes" if is_risk else "No",
            "isp": ip_data.get("provider") or "",
            "asn": str(ip_data.get("asn") or ""),
            "usageType": proxy_type,
            "country": ip_data.get("country") or ip_data.get("isocode") or "",
            "region": ip_data.get("region") or "",
            "city": ip_data.get("city") or "",
            "connectionType": proxy_type,
            "confidence": str(ip_data.get("risk") or ("High" if is_risk else "Medium")),
            "reputationCapable": True,
            "capability": self.capability,
            "flags": {
                "vpn": "vpn" in proxy_type.lower(),
                "proxy": is_risk,
                "hosting": _contains_any(proxy_type, ("hosting", "datacenter", "data center")),
                "datacenter": _contains_any(proxy_type, ("datacenter", "data center")),
                "tor": "tor" in proxy_type.lower(),
                "active": is_risk,
            },
        })


class IPHubProvider(IpIntelligenceProvider):
    name = "IPHub"
    requires_key = True
    env_key = "IPHUB_API_KEY"
    enabled_env = "IPHUB_ENABLED"
    capability = "vpn_proxy_detector"

    async def lookup(self, ip_value):
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(f"https://v2.api.iphub.info/ip/{quote(ip_value)}", headers={"X-Key": self.api_key()})
            response.raise_for_status()
            data = response.json()
        block_value = str(data.get("block") or "").strip()
        is_risk = block_value == "1"
        isp = data.get("isp") or ""
        usage_type = data.get("type") or ("hosting/proxy" if is_risk else "")
        return _normalize_ip_provider_result({
            "provider": self.name,
            "status": "ok",
            "vpnProxy": "Yes" if is_risk else "No",
            "isp": isp,
            "asn": str(data.get("asn") or ""),
            "usageType": usage_type,
            "country": data.get("countryName") or data.get("countryCode") or "",
            "confidence": "High" if is_risk else "Medium",
            "notes": f"IPHub block={block_value or 'unknown'}",
            "reputationCapable": True,
            "capability": self.capability,
            "flags": {
                "proxy": is_risk,
                "hosting": is_risk,
                "datacenter": is_risk,
                "active": is_risk,
                "residential": block_value == "0" and _contains_any(isp, RESIDENTIAL_USAGE_MARKERS),
            },
        })


class ScamalyticsProvider(IpIntelligenceProvider):
    name = "Scamalytics"
    enabled_env = "SCAMALYTICS_ENABLED"
    capability = "vpn_proxy_detector"

    def enabled(self):
        env_val = os.getenv(self.enabled_env or "")
        if env_val is None or env_val == "":
            try:
                config = _load_backend_runtime_config()
                env_val = config.get(self.enabled_env) or config.get((self.enabled_env or "").lower())
            except Exception:
                pass
        enabled_value = str(env_val if env_val is not None and env_val != "" else self.default_enabled).strip().lower()
        if enabled_value in {"0", "false", "no", "off", "disabled"}:
            return False, "disabled"
        if not (self.username() and self.api_key()):
            return False, "missing_api_key"
        return True, ""

    def username(self):
        val = os.getenv("SCAMALYTICS_USERNAME")
        if val:
            return val.strip()
        try:
            config = _load_backend_runtime_config()
            val = config.get("SCAMALYTICS_USERNAME") or config.get("scamalytics_username")
            if val:
                return str(val).strip()
        except Exception:
            pass
        return ""

    def api_key(self):
        val = os.getenv("SCAMALYTICS_API_KEY")
        if val:
            return val.strip()
        try:
            config = _load_backend_runtime_config()
            val = config.get("SCAMALYTICS_API_KEY") or config.get("scamalytics_api_key")
            if val:
                return str(val).strip()
        except Exception:
            pass
        return ""

    async def lookup(self, ip_value):
        params = {"key": self.api_key(), "ip": ip_value}
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(f"https://api11.scamalytics.com/{quote(self.username())}/", params=params)
            response.raise_for_status()
            data = response.json()
        score_raw = data.get("score") or data.get("ip_score") or data.get("risk_score") or 0
        try:
            score = float(score_raw)
        except (TypeError, ValueError):
            score = 0.0
        risk = str(data.get("risk") or data.get("risk_level") or "").strip().lower()
        usage_type = " ".join(str(data.get(key) or "") for key in ("ip_city", "ip_state_name", "ip_country_name", "isp_name"))
        is_risk = score >= 75 or risk in {"high", "very high", "fraud", "proxy", "vpn"}
        return _normalize_ip_provider_result({
            "provider": self.name,
            "status": "ok",
            "vpnProxy": "Yes" if is_risk else "No",
            "isp": data.get("isp_name") or "",
            "asn": str(data.get("asn") or ""),
            "usageType": usage_type,
            "country": data.get("ip_country_name") or data.get("ip_country_code") or "",
            "region": data.get("ip_state_name") or "",
            "city": data.get("ip_city") or "",
            "confidence": "High" if is_risk else "Medium",
            "notes": f"Scamalytics score={score_raw}",
            "reputationCapable": True,
            "capability": self.capability,
            "flags": {
                "proxy": is_risk,
                "vpn": "vpn" in risk,
                "hosting": _contains_any(usage_type, ("hosting", "datacenter", "data center")),
                "datacenter": _contains_any(usage_type, ("datacenter", "data center")),
                "active": is_risk,
            },
        })


class IpApiCoProvider(IpIntelligenceProvider):
    name = "ipapi.co network metadata"
    enabled_env = "IPAPI_CO_ENABLED"
    reputation_capable = False
    capability = "metadata_only"

    async def lookup(self, ip_value):
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(f"https://ipapi.co/{quote(ip_value)}/json/")
            response.raise_for_status()
            data = response.json()
        usage_text = " ".join(str(data.get(key) or "") for key in ("org", "asn", "network"))
        return _normalize_ip_provider_result({
            "provider": self.name,
            "status": "metadata",
            "vpnProxy": "Unknown",
            "isp": data.get("org") or "",
            "asn": str(data.get("asn") or ""),
            "usageType": "Network metadata only",
            "country": data.get("country_name") or data.get("country") or "",
            "region": data.get("region") or "",
            "city": data.get("city") or "",
            "connectionType": data.get("network") or "",
            "confidence": "Informational",
            "notes": "Metadata only. This provider does not verify VPN/proxy reputation.",
            "reputationCapable": False,
            "capability": self.capability,
            "flags": {
                "hosting": _contains_any(usage_text, ("hosting", "datacenter", "data center")),
                "datacenter": _contains_any(usage_text, ("datacenter", "data center")),
                "residential": _contains_any(usage_text, RESIDENTIAL_USAGE_MARKERS),
            },
        })


class GetIpIntelProvider(IpIntelligenceProvider):
    name = "GetIPIntel"
    enabled_env = "GETIPINTEL_ENABLED"
    default_enabled = True
    capability = "vpn_proxy_detector"

    async def lookup(self, ip_value):
        email = (os.getenv("GETIPINTEL_EMAIL") or "").strip()
        if not email:
            try:
                config = _load_backend_runtime_config()
                email = (config.get("GETIPINTEL_EMAIL") or config.get("getipintel_email") or "").strip()
            except Exception:
                pass
        if not email:
            raise RuntimeError("GetIPIntel is not configured (missing contact email)")
            
        params = {
            "ip": ip_value,
            "contact": email,
            "format": "json",
            "flags": "m",
        }
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get("https://check.getipintel.net/check.php", params=params)
            response.raise_for_status()
            data = response.json()
            
        status = str(data.get("status") or "").lower()
        if status != "success":
            raise RuntimeError(f"GetIPIntel API returned non-success status: {status}")
            
        score_raw = data.get("result") or "0"
        try:
            score = float(score_raw)
        except (TypeError, ValueError):
            score = 0.0
            
        if score < 0:
            raise RuntimeError(f"GetIPIntel API returned error code: {score}")
            
        is_risk = score >= 0.99
        return _normalize_ip_provider_result({
            "provider": self.name,
            "status": "ok",
            "vpnProxy": "Yes" if is_risk else "No",
            "isp": "",
            "asn": "",
            "usageType": "VPN/Proxy reputation score",
            "country": "",
            "confidence": "High" if is_risk else "Medium",
            "notes": f"GetIPIntel score={score_raw}",
            "reputationCapable": True,
            "capability": self.capability,
            "flags": {
                "proxy": is_risk,
                "vpn": is_risk,
                "active": is_risk,
            },
        })


class VpnApiIoProvider(IpIntelligenceProvider):
    """vpnapi.io free-tier VPN/proxy detection. Requires VPNAPI_IO_KEY (free tier available)."""
    name = "vpnapi.io"
    requires_key = True
    env_key = "VPNAPI_IO_KEY"
    enabled_env = "VPNAPI_IO_ENABLED"
    capability = "vpn_proxy_detector"

    async def lookup(self, ip_value):
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(
                f"https://vpnapi.io/api/{quote(ip_value)}",
                params={"key": self.api_key()},
            )
            response.raise_for_status()
            data = response.json()
        security = data.get("security") or {}
        location = data.get("location") or {}
        network = data.get("network") or {}
        is_vpn = bool(security.get("vpn"))
        is_proxy = bool(security.get("proxy"))
        is_tor = bool(security.get("tor"))
        is_relay = bool(security.get("relay"))
        is_risk = is_vpn or is_proxy or is_tor or is_relay
        return _normalize_ip_provider_result({
            "provider": self.name,
            "status": "ok",
            "vpnProxy": "Yes" if is_risk else "No",
            "isp": network.get("autonomous_system_organization") or str(network.get("autonomous_system_number") or ""),
            "asn": str(network.get("autonomous_system_number") or ""),
            "usageType": ", ".join(k for k, v in security.items() if v) or "residential/unknown",
            "country": location.get("country") or location.get("country_code") or "",
            "region": location.get("region") or "",
            "city": location.get("city") or "",
            "confidence": "High" if is_risk else "Medium",
            "notes": f"vpnapi.io vpn={is_vpn} proxy={is_proxy} tor={is_tor} relay={is_relay}",
            "reputationCapable": True,
            "capability": self.capability,
            "flags": {
                "vpn": is_vpn or is_relay,
                "proxy": is_proxy,
                "tor": is_tor,
                "active": is_risk,
                "residential": not is_risk,
            },
        })


class IpApiComProvider(IpIntelligenceProvider):
    """ip-api.com free endpoint. No key required. Proxy and hosting flags on free tier."""
    name = "ip-api.com"
    requires_key = False
    enabled_env = "IPAPI_COM_ENABLED"
    capability = "vpn_proxy_detector"
    reputation_capable = True

    async def lookup(self, ip_value):
        fields = "status,message,country,regionName,city,isp,org,as,proxy,hosting,query"
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(
                f"http://ip-api.com/json/{quote(ip_value)}",
                params={"fields": fields},
            )
            response.raise_for_status()
            data = response.json()
        if data.get("status") != "success":
            raise ValueError(
                f"ip-api.com status={data.get('status')}: {data.get('message', 'unknown error')}"
            )
        is_proxy = bool(data.get("proxy"))
        is_hosting = bool(data.get("hosting"))
        is_risk = is_proxy or is_hosting
        isp = data.get("isp") or data.get("org") or ""
        org = data.get("org") or ""
        asn_raw = data.get("as") or ""
        return _normalize_ip_provider_result({
            "provider": self.name,
            "status": "ok",
            "vpnProxy": "Yes" if is_risk else "No",
            "isp": isp,
            "asn": asn_raw,
            "usageType": "proxy/hosting" if is_risk else "residential/ISP",
            "country": data.get("country") or "",
            "region": data.get("regionName") or "",
            "city": data.get("city") or "",
            "confidence": "High" if is_risk else "Medium",
            "notes": f"ip-api.com proxy={is_proxy} hosting={is_hosting} org={org[:60]}",
            "reputationCapable": True,
            "capability": self.capability,
            "flags": {
                "proxy": is_proxy,
                "hosting": is_hosting,
                "datacenter": is_hosting,
                "active": is_risk,
                "residential": _contains_any(isp + " " + org, RESIDENTIAL_USAGE_MARKERS) and not is_risk,
            },
        })


class IpWhoIsProvider(IpIntelligenceProvider):
    """ipwho.is free metadata provider. No key required. Metadata-only capability."""
    name = "ipwho.is"
    requires_key = False
    enabled_env = "IPWHOIS_ENABLED"
    reputation_capable = False
    capability = "metadata_only"

    async def lookup(self, ip_value):
        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.get(f"https://ipwho.is/{quote(ip_value)}")
            response.raise_for_status()
            data = response.json()
        if not data.get("success"):
            raise ValueError(f"ipwho.is error: {data.get('message', 'unknown error')}")
        connection = data.get("connection") or {}
        isp = connection.get("isp") or connection.get("org") or ""
        asn_raw = str(connection.get("asn") or "")
        org = connection.get("org") or ""
        type_raw = connection.get("type") or ""
        usage_text = " ".join(filter(None, [isp, org, type_raw]))
        return _normalize_ip_provider_result({
            "provider": self.name,
            "status": "metadata",
            "vpnProxy": "Unknown",
            "isp": isp,
            "asn": asn_raw,
            "usageType": type_raw or "Network metadata only",
            "country": data.get("country") or "",
            "region": data.get("region") or "",
            "city": data.get("city") or "",
            "confidence": "Informational",
            "notes": "Metadata only. ipwho.is does not verify VPN/proxy reputation.",
            "reputationCapable": False,
            "capability": self.capability,
            "flags": {
                "hosting": _contains_any(usage_text, ("hosting", "datacenter", "data center")),
                "datacenter": _contains_any(usage_text, ("datacenter", "data center")),
                "residential": _contains_any(usage_text, RESIDENTIAL_USAGE_MARKERS),
            },
        })


def _configured_ip_intelligence_providers():
    return [
        IP2LocationProvider(),
        IPinfoProvider(),
        IPQualityScoreProvider(),
        AbuseIpDbProvider(),
        ProxyCheckProvider(),
        IPHubProvider(),
        ScamalyticsProvider(),
        GetIpIntelProvider(),
        VpnApiIoProvider(),
        IpApiCoProvider(),
        IpWhoIsProvider(),
    ]


def _ip_result_has_risk(result):
    flags = result.get("flags") or {}
    return any(bool(flags.get(key)) for key in ("vpn", "proxy", "hosting", "datacenter", "tor", "residential_proxy"))


def _ip_result_active_risk(result):
    flags = result.get("flags") or {}
    return bool(flags.get("active")) and any(bool(flags.get(key)) for key in ("vpn", "proxy", "hosting", "datacenter", "tor"))


def _ip_result_hosting(result):
    flags = result.get("flags") or {}
    return bool(flags.get("hosting") or flags.get("datacenter"))


def _ip_result_strong_current_risk(result):
    flags = result.get("flags") or {}
    if not bool(flags.get("active")) or _ip_result_stale_risk(result):
        return False
    if str(result.get("confidence") or "").strip().lower() != "high":
        return False
    if any(bool(flags.get(key)) for key in ("vpn", "hosting", "datacenter", "tor")):
        return True
    network_text = " ".join(str(result.get(key) or "") for key in ("usageType", "connectionType"))
    return _contains_any(network_text, ("vpn", "hosting", "datacenter", "data center", "tor"))


def _ip_result_historical_residential_proxy(result):
    flags = result.get("flags") or {}
    return bool(flags.get("proxy") or flags.get("residential_proxy")) and bool(flags.get("historical")) and bool(flags.get("residential"))


def _ip_result_stale_risk(result):
    flags = result.get("flags") or {}
    if not _ip_result_has_risk(result):
        return False
    return bool(flags.get("historical")) or _last_seen_older_than(result.get("lastSeen"), 48)


def _provider_results_disagree(results):
    risk_states = {bool(_ip_result_has_risk(result)) for result in results if result.get("status") == "ok" and result.get("capability") == "vpn_proxy_detector" and result.get("reputationCapable", True)}
    return len(risk_states) > 1


def _consensus_ip_intelligence(results, skipped_count=0):
    successful = [result for result in results if result.get("status") in {"ok", "metadata"}]
    detector_successful = [result for result in successful if result.get("status") == "ok" and result.get("capability") == "vpn_proxy_detector" and result.get("reputationCapable", True)]
    metadata_successful = [result for result in successful if result.get("capability") == "metadata_only" or not result.get("reputationCapable", True)]
    if not detector_successful:
        summary = "No VPN/proxy reputation provider available. Manual verification required."
        if metadata_successful:
            summary = "Only network metadata is available. No VPN/proxy reputation provider available. Manual verification required."
        return {
            "verdict": "UNABLE TO VERIFY",
            "level": "gray",
            "summary": summary,
            "fallbackUsed": True,
        }

    detector_warning = ""

    historical_residential = [result for result in detector_successful if _ip_result_historical_residential_proxy(result)]
    stale_risk = [result for result in detector_successful if _ip_result_stale_risk(result)]
    current_risk_results = [result for result in detector_successful if _ip_result_has_risk(result) and not _ip_result_stale_risk(result)]
    total_risk_count = len(current_risk_results)
    total_any_risk_count = total_risk_count + len(stale_risk)
    hosting_confirmed = any(_ip_result_hosting(result) for result in current_risk_results)
    active_vpn_confirmed = any((result.get("flags") or {}).get("vpn") and (result.get("flags") or {}).get("active") for result in current_risk_results)
    residential_conflict = any((result.get("flags") or {}).get("residential") for result in detector_successful) and total_any_risk_count > 0
    disagreement = _provider_results_disagree(detector_successful)

    if historical_residential and total_any_risk_count == len(historical_residential):
        return {
            "verdict": "REVIEW",
            "level": "yellow",
            "summary": "One provider detected historical proxy activity. The connection currently appears residential. Do not fail based on this result alone.",
            "fallbackUsed": False,
            "warning": detector_warning,
        }

    if stale_risk and total_risk_count < 2:
        return {
            "verdict": "REVIEW",
            "level": "yellow",
            "summary": "One provider reported a stale or historical VPN/proxy signal. Manual review is required before making a decision.",
            "fallbackUsed": False,
            "warning": detector_warning,
        }

    single_active_hosting_signal = total_risk_count == 1 and active_vpn_confirmed and hosting_confirmed
    single_strong_current_signal = total_risk_count == 1 and any(_ip_result_strong_current_risk(result) for result in current_risk_results)
    if total_risk_count >= 2 or single_active_hosting_signal or single_strong_current_signal:
        return {
            "verdict": "VPN / PROXY LIKELY",
            "level": "red",
            "summary": "VPN/proxy detector signals indicate this IP is likely VPN/proxy/datacenter. Candidate should be reviewed before continuing.",
            "fallbackUsed": False,
            "warning": detector_warning,
        }

    if total_risk_count == 1 or residential_conflict:
        summary = "One provider detected VPN/proxy/hosting risk. Manual review is recommended."
        if historical_residential:
            summary = "One provider detected historical proxy activity, but the connection appears to be a residential ISP. Manual review is recommended."
        return {"verdict": "REVIEW", "level": "yellow", "summary": summary, "fallbackUsed": False, "warning": ""}

    if disagreement:
        return {"verdict": "MIXED SIGNAL — VERIFY MANUALLY", "level": "yellow", "summary": "Providers returned conflicting results. At least one detected VPN/proxy risk and at least one did not. Manual verification is required before making a decision.", "fallbackUsed": False, "warning": ""}

    # When fewer than 2 detectors responded, downgrade CLEAR to a cautious verdict.
    if len(detector_successful) < 2:
        return {
            "verdict": "CLEAR — LIMITED CHECK",
            "level": "yellow",
            "summary": "No VPN or proxy signals detected, but only one provider responded. Verify manually if this result is important.",
            "fallbackUsed": False,
            "warning": "",
        }
    return {
        "verdict": "CLEAR",
        "level": "green",
        "summary": "No providers detected VPN, proxy, hosting, or datacenter usage.",
        "fallbackUsed": False,
        "warning": "",
    }


def _ip_intelligence_summary_confidence(consensus, detector_count, metadata_count):
    verdict = str((consensus or {}).get("verdict") or "").upper()
    if detector_count <= 0:
        return "Unknown"
    if verdict == "VPN / PROXY LIKELY":
        return "High" if detector_count >= 2 else "Medium"
    if verdict.startswith("CLEAR"):
        return "High" if detector_count >= 2 else "Medium"
    if verdict == "REVIEW" or "MIXED" in verdict:
        return "Medium" if detector_count >= 2 else "Low"
    return "Low" if metadata_count else "Unknown"


async def _run_ip_intelligence_lookup(ip_value):
    try:
        parsed_ip = ipaddress.ip_address(str(ip_value or "").strip())
    except ValueError:
        return {"ok": False, "error": "Enter a valid IPv4 or IPv6 address."}

    normalized_ip = str(parsed_ip)
    provider_results = []
    skipped = []
    for provider in _configured_ip_intelligence_providers():
        enabled, reason = provider.enabled()
        if not enabled:
            skipped.append({"provider": provider.name, "reason": reason})
            reason_key = str(reason or "").strip().lower().replace(" ", "_")
            provider_results.append(_empty_ip_provider_result(
                provider.name,
                "not configured" if reason_key == "missing_api_key" else reason or "not configured",
                "Provider is not configured." if reason_key == "missing_api_key" else "Provider is disabled.",
                provider.reputation_capable,
                provider.capability,
            ))
            continue
        started = time.perf_counter()
        try:
            result = await provider.lookup(normalized_ip)
            duration_ms = int((time.perf_counter() - started) * 1000)
            logger.info("[IP-INTEL] provider=%s duration_ms=%s success=true failure=", provider.name, duration_ms)
            provider_results.append({**result, "durationMs": duration_ms})
        except httpx.TimeoutException:
            duration_ms = int((time.perf_counter() - started) * 1000)
            logger.warning("[IP-INTEL] provider=%s duration_ms=%s success=false failure=TimeoutException", provider.name, duration_ms)
            provider_results.append(_empty_ip_provider_result(provider.name, "timeout", "Provider lookup timed out.", provider.reputation_capable, provider.capability))
        except Exception as exc:
            duration_ms = int((time.perf_counter() - started) * 1000)
            logger.warning("[IP-INTEL] provider=%s duration_ms=%s success=false failure=%s", provider.name, duration_ms, exc.__class__.__name__)
            provider_results.append(_empty_ip_provider_result(provider.name, "failed", "Provider lookup failed.", provider.reputation_capable, provider.capability))

    consensus = _consensus_ip_intelligence(provider_results, skipped_count=len(skipped))
    last_seen_values = [str(result.get("lastSeen") or "").strip() for result in provider_results if str(result.get("lastSeen") or "").strip()]
    detector_provider_count = sum(
        1
        for result in provider_results
        if result.get("status") == "ok"
        and result.get("capability") == "vpn_proxy_detector"
        and result.get("reputationCapable", True)
    )
    metadata_provider_count = sum(
        1
        for result in provider_results
        if result.get("status") in {"ok", "metadata"}
        and (result.get("capability") == "metadata_only" or not result.get("reputationCapable", True))
    )
    return {
        "ok": True,
        "ip": normalized_ip,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "lastSeen": last_seen_values[0] if last_seen_values else "",
        "verdict": consensus["verdict"],
        "level": consensus["level"],
        "summary": consensus["summary"],
        "warning": consensus.get("warning", ""),
        "providerResults": provider_results,
        "providersSkipped": skipped,
        "detectorProviderCount": detector_provider_count,
        "metadataProviderCount": metadata_provider_count,
        "confidence": _ip_intelligence_summary_confidence(consensus, detector_provider_count, metadata_provider_count),
        "fallbackUsed": consensus["fallbackUsed"],
        "autoFail": False,
    }


@api_router.post("/ip-intelligence/check")
async def check_candidate_ip_intelligence(payload: dict):
    return await _run_ip_intelligence_lookup((payload or {}).get("ip") or "")


@api_router.get("/shared/admin/candidates")
async def get_shared_admin_candidates(request: Request):
    _require_admin_token(request)
    result = await asyncio.to_thread(_shared_admin_candidate_snapshot)
    _schedule_shadow_domains("candidate_tracking", "authoritative_candidate_status")
    return result


@api_router.get("/shared/admin/snapshot")
async def get_shared_admin_snapshot(request: Request):
    _require_admin_token(request)
    result = await asyncio.to_thread(_shared_admin_snapshot)
    _schedule_shadow_domains(
        "candidate_tracking", "authoritative_candidate_status",
        "supervisor_transfers", "pending_requests", "recent_activity",
    )
    return result


@api_router.post("/shared/admin/candidates/action")
async def post_shared_admin_candidate_action(payload: dict, request: Request):
    _require_admin_token(request)
    auth_payload = payload or {}
    auth_result, _ = await asyncio.to_thread(
        get_dual_write_manager().execute_dual_write,
        domain="candidate_sessions",
        mutation_type="action",
        authoritative_payload=auth_payload,
        authoritative_write_fn=lambda: _shared_admin_candidate_action(auth_payload),
        actor=str(request.headers.get("x-sam-user") or "admin"),
    )
    return auth_result


@api_router.get("/shared/admin/pending-requests")
async def get_shared_admin_pending_requests(request: Request):
    _require_admin_token(request)
    result = await asyncio.to_thread(_shared_pending_request_snapshot)
    _schedule_shadow_domains(
        "pending_requests", "recent_activity", "newbie_shift_requests",
        "candidate_corrections",
    )
    return result


@api_router.post("/shared/admin/pending-requests/action")
async def post_shared_admin_pending_request_action(payload: dict, request: Request):
    _require_admin_token(request)
    auth_payload = payload or {}
    category = str(auth_payload.get("category") or "").strip().lower()
    target_domain = (
        "newbie_shift_requests" if "newbie" in category
        else "candidate_corrections" if "correction" in category
        else "pending_requests"
    )
    auth_result, _ = await asyncio.to_thread(
        get_dual_write_manager().execute_dual_write,
        domain=target_domain,
        mutation_type="action",
        authoritative_payload=auth_payload,
        authoritative_write_fn=lambda: _shared_pending_request_action(auth_payload),
        actor=str(request.headers.get("x-sam-user") or "admin"),
    )
    return auth_result


@api_router.get("/sam/setup/status")
async def get_sam_setup_status():
    settings_doc = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0}) or {}
    status = await asyncio.to_thread(_sam_setup_status)
    return {
        **status,
        "setupComplete": bool(settings_doc.get("sam_setup_complete")),
        "userName": settings_doc.get("sam_user_name") or "",
        "role": settings_doc.get("sam_user_role") or "",
        "userEmail": settings_doc.get("sam_auth_email") or "",
        "authUid": settings_doc.get("sam_auth_uid") or "",
        "authProvider": settings_doc.get("sam_auth_provider") or "legacy",
    }


@api_router.post("/sam/setup/complete")
async def post_sam_setup_complete(payload: dict):
    result = await asyncio.to_thread(_complete_sam_setup, payload or {})
    if not result.get("ok"):
        return result
    try:
        await db.settings.update_one(
            {"_id": "app_settings"},
            {"$set": {
                "sam_setup_complete": True,
                "sam_user_name": result.get("name") or "",
                "sam_user_role": result.get("role") or "",
            }},
            upsert=True,
        )
    except Exception as exc:
        logger.warning("[SAM-SETUP] status=persistence_failed error_type=%s", type(exc).__name__)
        return _sam_setup_error("setup_persistence_failed")
    return result


@api_router.post("/sam/setup/reset")
async def post_sam_setup_reset(request: Request):
    _require_admin_token(request)
    await db.settings.update_one(
        {"_id": "app_settings"},
        {"$set": {"sam_setup_complete": False, "sam_user_name": "", "sam_user_role": ""}},
        upsert=True,
    )
    return {"ok": True}


def _supabase_anon_rpc(rpc_name: str, body: dict = None, auth_jwt: str = None):
    runtime_config = _load_backend_runtime_config() or {}
    url = str(runtime_config.get("supabase_url") or "").rstrip("/")
    key = str(runtime_config.get("supabase_anon_key") or "").strip()
    if not url or not key:
        return {"ok": False, "error": "Supabase configuration is not available."}
    rpc_url = f"{url}/rest/v1/rpc/{rpc_name}"
    req_body = json.dumps(body or {}, separators=(",", ":")).encode("utf-8")
    bearer = f"Bearer {auth_jwt.strip()}" if (auth_jwt and auth_jwt.strip()) else f"Bearer {key}"
    req = urllib.request.Request(
        rpc_url,
        data=req_body,
        headers={
            "apikey": key,
            "Authorization": bearer,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Content-Profile": "mts_sam",
            "Accept-Profile": "mts_sam",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            return json.loads(resp.read().decode("utf-8-sig"))
    except urllib.error.HTTPError as exc:
        try:
            err_text = exc.read().decode("utf-8-sig")
            err_json = json.loads(err_text)
            return {"ok": False, "error": err_json.get("message") or err_json.get("error") or err_text}
        except Exception:
            return {"ok": False, "error": f"HTTP {exc.code}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _call_supabase_edge_function(function_name: str, body: dict = None, auth_jwt: str = None) -> dict:
    runtime_config = _load_backend_runtime_config() or {}
    url = str(runtime_config.get("supabase_url") or "").rstrip("/")
    key = str(runtime_config.get("supabase_anon_key") or "").strip()
    if not url or not key:
        return {"ok": False, "error": "Supabase configuration is not available."}
    if not auth_jwt or not auth_jwt.strip():
        return {"ok": False, "error": "Caller authentication token is required."}
    fn_url = f"{url}/functions/v1/{function_name}"
    req_body = json.dumps(body or {}, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(
        fn_url,
        data=req_body,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {auth_jwt.strip()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15.0) as resp:
            return json.loads(resp.read().decode("utf-8-sig"))
    except urllib.error.HTTPError as exc:
        try:
            err_text = exc.read().decode("utf-8-sig")
            err_json = json.loads(err_text)
            return {"ok": False, "status_code": exc.code, "error": err_json.get("error") or err_json.get("message") or err_text, **err_json}
        except Exception:
            return {"ok": False, "status_code": exc.code, "error": f"HTTP {exc.code}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@api_router.get("/sam/auth/config")
async def get_sam_auth_config():
    config = _load_backend_runtime_config() or {}
    return {
        "ok": True,
        "supabase_url": config.get("supabase_url", ""),
        "supabase_anon_key": config.get("supabase_anon_key", ""),
    }


@api_router.post("/sam/auth/verify")
async def post_sam_auth_verify(payload: dict, request: Request):
    auth_uid = str((payload or {}).get("auth_uid") or "").strip()
    auth_header = request.headers.get("Authorization", "").strip()
    auth_jwt = auth_header[7:].strip() if auth_header.startswith("Bearer ") else ""
    if not auth_jwt and (payload or {}).get("access_token"):
        auth_jwt = str(payload.get("access_token")).strip()
    if not auth_uid and not auth_jwt:
        return {"ok": False, "errorCode": "missing_auth_identity", "error": "Authentication identity is required."}
    result = await asyncio.to_thread(_supabase_anon_rpc, "verify_sam_authorization", {"p_auth_uid": auth_uid} if auth_uid else {}, auth_jwt)
    return result


@api_router.post("/sam/auth/complete")
async def post_sam_auth_complete(payload: dict):
    name = str((payload or {}).get("name") or "").strip()
    role = str((payload or {}).get("role") or "").strip()
    auth_uid = str((payload or {}).get("auth_uid") or "").strip()
    email = str((payload or {}).get("email") or "").strip()
    if not name or not role:
        return {"ok": False, "error": "Name and role are required."}
    try:
        await db.settings.update_one(
            {"_id": "app_settings"},
            {"$set": {
                "sam_setup_complete": True,
                "sam_user_name": name,
                "sam_user_role": role,
                "sam_auth_email": email,
                "sam_auth_uid": auth_uid,
                "sam_auth_provider": "supabase",
            }},
            upsert=True,
        )
    except Exception as exc:
        logger.warning("[SAM-AUTH] status=persistence_failed error_type=%s", type(exc).__name__)
        return {"ok": False, "error": "Failed to save local session."}
    return {"ok": True, "name": name, "role": role}


@api_router.post("/sam/admin/users/list")
async def post_sam_admin_users_list(payload: dict, request: Request):
    auth_header = request.headers.get("Authorization", "").strip()
    auth_jwt = auth_header[7:].strip() if auth_header.startswith("Bearer ") else ""
    if not auth_jwt and (payload or {}).get("access_token"):
        auth_jwt = str(payload.get("access_token")).strip()
    caller_auth_uid = str((payload or {}).get("caller_auth_uid") or "").strip()
    if not auth_jwt and not caller_auth_uid:
        return {"ok": False, "error": "Unauthorized"}
    rpc_body = {"p_caller_auth_uid": caller_auth_uid} if caller_auth_uid else {}
    result = await asyncio.to_thread(_supabase_anon_rpc, "get_sam_user_management_list", rpc_body, auth_jwt)
    return result


@api_router.post("/sam/admin/users/set-active")
async def post_sam_admin_users_set_active(payload: dict, request: Request):
    auth_header = request.headers.get("Authorization", "").strip()
    auth_jwt = auth_header[7:].strip() if auth_header.startswith("Bearer ") else ""
    if not auth_jwt and (payload or {}).get("access_token"):
        auth_jwt = str(payload.get("access_token")).strip()
    caller_auth_uid = str((payload or {}).get("caller_auth_uid") or "").strip()
    target_user_id = str((payload or {}).get("target_user_id") or "").strip()
    active = bool((payload or {}).get("active"))
    if not target_user_id:
        return {"ok": False, "error": "Target user ID is required."}
    if not auth_jwt and not caller_auth_uid:
        return {"ok": False, "error": "Caller authentication is required."}
    rpc_body = {
        "p_target_user_id": target_user_id,
        "p_active": active,
    }
    if caller_auth_uid:
        rpc_body["p_caller_auth_uid"] = caller_auth_uid
    result = await asyncio.to_thread(_supabase_anon_rpc, "set_sam_user_active", rpc_body, auth_jwt)
    return result


@api_router.post("/sam/admin/users/update")
async def post_sam_admin_users_update(payload: dict, request: Request):
    auth_header = request.headers.get("Authorization", "").strip()
    auth_jwt = auth_header[7:].strip() if auth_header.startswith("Bearer ") else ""
    if not auth_jwt and (payload or {}).get("access_token"):
        auth_jwt = str(payload.get("access_token")).strip()
    caller_auth_uid = str((payload or {}).get("caller_auth_uid") or "").strip()
    target_user_id = str((payload or {}).get("target_user_id") or "").strip()
    if not target_user_id:
        return {"ok": False, "error": "Target user ID is required."}
    if not auth_jwt and not caller_auth_uid:
        return {"ok": False, "error": "Caller authentication is required."}

    rpc_body = {
        "p_target_user_id": target_user_id,
    }
    if "email" in (payload or {}):
        rpc_body["p_email"] = str(payload.get("email") or "").strip()
    if "role" in (payload or {}):
        rpc_body["p_role"] = str(payload.get("role") or "").strip()
    if "active" in (payload or {}):
        rpc_body["p_active"] = bool(payload.get("active"))
    if caller_auth_uid:
        rpc_body["p_caller_auth_uid"] = caller_auth_uid

    result = await asyncio.to_thread(_supabase_anon_rpc, "update_sam_user", rpc_body, auth_jwt)
    return result


@api_router.post("/sam/admin/users/enroll")
async def post_sam_admin_users_enroll(payload: dict, request: Request):
    auth_header = request.headers.get("Authorization", "").strip()
    auth_jwt = auth_header[7:].strip() if auth_header.startswith("Bearer ") else ""
    if not auth_jwt and (payload or {}).get("access_token"):
        auth_jwt = str(payload.get("access_token")).strip()
    caller_auth_uid = str((payload or {}).get("caller_auth_uid") or "").strip()
    target_user_id = str((payload or {}).get("target_user_id") or "").strip()
    if not target_user_id:
        return {"ok": False, "error": "Target user ID is required."}
    if not auth_jwt:
        return {"ok": False, "error": "Caller authentication token is required."}

    req_body = {
        "target_user_id": target_user_id,
    }
    if caller_auth_uid:
        req_body["caller_auth_uid"] = caller_auth_uid

    result = await asyncio.to_thread(_call_supabase_edge_function, "sam-admin-enroll-user", req_body, auth_jwt)
    return result


@api_router.post("/sam/admin/users/send-reset")
async def post_sam_admin_users_send_reset(payload: dict, request: Request):
    email = str((payload or {}).get("email") or "").strip().lower()
    if not email:
        return {"ok": False, "error": "User email address is required."}
    runtime_config = _load_backend_runtime_config() or {}
    url = str(runtime_config.get("supabase_url") or "").rstrip("/")
    key = str(runtime_config.get("supabase_anon_key") or "").strip()
    if not url or not key:
        return {"ok": False, "error": "Supabase configuration is not available."}

    recover_url = f"{url}/auth/v1/recover?redirect_to=smartalertmanager://reset-password"
    req_body = json.dumps({"email": email}).encode("utf-8")
    req = urllib.request.Request(
        recover_url,
        data=req_body,
        headers={
            "apikey": key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            return {"ok": True, "message": "Password reset instructions sent."}
    except urllib.error.HTTPError as exc:
        try:
            err_text = exc.read().decode("utf-8-sig")
            err_json = json.loads(err_text)
            return {"ok": False, "error": err_json.get("msg") or err_json.get("message") or err_text}
        except Exception:
            return {"ok": False, "error": f"HTTP {exc.code}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@api_router.get("/admin/verify-shared-session-sheets")
async def verify_shared_session_sheets(request: Request):
    _require_admin_token(request)
    return await asyncio.to_thread(_verify_master_shared_sheets)


@api_router.get("/admin/verify-shared-sheets")
async def verify_shared_sheets(request: Request):
    _require_admin_token(request)
    return await asyncio.to_thread(_verify_master_shared_sheets)


@api_router.get("/admin/google-sheet-permission-check")
async def google_sheet_permission_check(request: Request):
    used_local_fallback = False
    try:
        _require_admin_token(request)
    except HTTPException as exc:
        if _can_use_local_diagnostic_auth_fallback(request):
            used_local_fallback = True
            logger.warning(
                "[SHEETS-DIAG] Using local development auth fallback for Google Sheet diagnostics. client=%s",
                getattr(request.client, "host", "") if request.client else "",
            )
        else:
            logger.exception("[SHEETS-DIAG] Permission check request rejected before diagnostics.")
            return JSONResponse(
                status_code=exc.status_code,
                content={
                    "ok": False,
                    "failedOperation": "authorize_admin_endpoint",
                    "errorType": exc.__class__.__name__,
                    "errorMessage": str(exc.detail),
                    "error": str(exc.detail),
                    "spreadsheetId": "",
                    "serviceAccountEmail": "",
                    "appAdminAuth": {
                        "ok": False,
                        "usedLocalDevelopmentFallback": False,
                        "errorMessage": str(exc.detail),
                    },
                    "googleSheetsPermission": {
                        "checked": False,
                        "ok": False,
                        "errorMessage": "Google Sheets diagnostics were not run because app admin authorization failed.",
                    },
                    "permissionNeeded": "A valid admin runtime token is required to run Google Sheet diagnostics.",
                    "operations": [
                        {
                            "operation": "authorize_admin_endpoint",
                            "ok": False,
                            "errorType": exc.__class__.__name__,
                            "errorMessage": str(exc.detail),
                        }
                    ],
                },
            )
    try:
        result = _run_google_sheet_permission_check()
        result["appAdminAuth"] = {
            "ok": True,
            "usedLocalDevelopmentFallback": used_local_fallback,
            "errorMessage": "",
        }
        result["googleSheetsPermission"] = {
            "checked": True,
            "ok": bool(result.get("ok")),
            "failedOperation": result.get("failedOperation") or "",
            "errorType": result.get("errorType") or "",
            "errorMessage": result.get("errorMessage") or "",
        }
        return result
    except Exception as exc:
        logger.exception("[SHEETS-DIAG] Unhandled permission check failure.")
        return {
            "ok": False,
            "failedOperation": "unhandled_diagnostic_error",
            "errorType": exc.__class__.__name__,
            "errorMessage": str(exc),
            "error": str(exc),
            "spreadsheetId": "",
            "serviceAccountEmail": "",
            "appAdminAuth": {
                "ok": True,
                "usedLocalDevelopmentFallback": used_local_fallback,
                "errorMessage": "",
            },
            "googleSheetsPermission": {
                "checked": False,
                "ok": False,
                "errorMessage": str(exc),
            },
            "permissionNeeded": "Check backend logs for the full traceback.",
            "operations": [
                {
                    "operation": "unhandled_diagnostic_error",
                    "ok": False,
                    "errorType": exc.__class__.__name__,
                    "errorMessage": str(exc),
                }
            ],
        }


async def _sync_finished_session_headset_review(session):
    source_session_id = _candidate_session_identity(session)
    if not source_session_id:
        return {
            "ok": False,
            "reason": "parent_session_unavailable",
            "error": "Headset review parent session could not be verified.",
        }
    return await asyncio.to_thread(_append_headset_review_log, {
        "review_id": session.get("headset_review_id"),
        "source_session_id": source_session_id,
        "candidate_name": session.get("candidate_name"),
        "tester_name": session.get("tester_name"),
        "headset_model": session.get("headset_brand"),
        "note": session.get("headset_review_note") or "",
    })


def _headset_review_sync_updates(session, headset_review):
    if headset_review and headset_review.get("ok"):
        return {
            "headset_review_id": headset_review.get("review_id") or session.get("headset_review_id") or "",
            "headset_review_sync_status": "synced",
            "headset_review_status": headset_review.get("status") or (
                "approved" if headset_review.get("reason") == "approved_headset" else ""
            ),
            "headset_review_last_synced_at": datetime.now(timezone.utc).isoformat(),
        }
    return {"headset_review_sync_status": "failed", "headset_review_status": "pending_retry"}


def _update_saved_history_fields(history_id, updates):
    history_id = str(history_id or "").strip()
    if not history_id:
        return False
    rows = db.history.store.fetchall("SELECT id, data FROM history_documents ORDER BY id DESC", ())
    matches = []
    for row in rows:
        record = SQLiteCollection.decode(row["data"])
        if str(record.get("history_id") or "").strip() == history_id:
            matches.append((row, record))
    if len(matches) != 1:
        return False
    row, record = matches[0]
    record.update(SQLiteCollection.clone(updates))
    db.history.store.execute(
        "UPDATE history_documents SET data = ?, timestamp = ? WHERE id = ?",
        (
            SQLiteCollection.encode(record),
            str(record.get("timestamp_iso") or record.get("timestamp") or ""),
            row["id"],
        ),
    )
    return True


@api_router.post("/session/start")
async def start_session(payload: dict, request: Request, background_tasks: BackgroundTasks):
    session = empty_session()
    session.update(payload)
    session["session_id"] = str(session.get("session_id") or uuid.uuid4())
    session["history_id"] = _candidate_session_identity(session) or session["session_id"]
    if str(session.get("newbie_shift_request_type") or "").strip().lower() == NEWBIE_REQUEST_RESCHEDULE:
        if not str(session.get("newbie_shift_request_id") or "").strip():
            session["newbie_shift_request_id"] = f"newbie-{session['session_id']}-{uuid.uuid4().hex}"
        session = _apply_newbie_reschedule_attempt(session)
    session["last_saved"] = datetime.now(timezone.utc).strftime("%I:%M %p")
    await db.sessions.replace_one({"_id": "active_session"}, {"_id": "active_session", **session}, upsert=True)
    if _shared_truthy(session.get("headset_review_requested")):
        session["headset_review_sync_status"] = "pending"
        await db.sessions.update_one({"_id": "active_session"}, {"$set": {"headset_review_sync_status": "pending"}}, upsert=False)
    return {"ok": True, "session": session, "headsetReview": None, "warning": ""}


@api_router.put("/session/update")
async def update_session(payload: dict, request: Request):
    existing = await db.sessions.find_one({"_id": "active_session"})
    if not existing:
        return {"ok": False, "error": "No active session", "session": None}
        
    if "coaching_summary" in payload or "fail_summary" in payload:
        logger.info(
            "[SUMMARY LOG] source=edited, fields=%d, payload_size=%d",
            len(payload),
            len(str(payload)),
        )
        
    combined = {**existing, **payload}
    if str(combined.get("newbie_shift_request_type") or "").strip().lower() == NEWBIE_REQUEST_RESCHEDULE:
        combined = _apply_newbie_reschedule_attempt(combined)
        for field in NEWBIE_RESCHEDULE_ATTEMPT_FIELDS:
            if field in combined:
                payload[field] = combined.get(field)
    payload["last_saved"] = datetime.now(timezone.utc).strftime("%I:%M %p")
    await db.sessions.update_one({"_id": "active_session"}, {"$set": payload}, upsert=False)
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    should_submit_reschedule = (
        str(doc.get("newbie_shift_request_type") or "").strip().lower() == NEWBIE_REQUEST_RESCHEDULE
        and str(doc.get("newbie_shift_request_status") or "").strip().lower() == NEWBIE_REQUEST_PENDING
        and bool(str(doc.get("newbie_shift_request_id") or "").strip())
        and bool(str(doc.get("newbie_shift_rescheduled_at") or "").strip())
        and any(key in payload for key in ("newbie_shift_rescheduled_at", "newbie_shift_scheduled_at", "newbie_shift_data"))
    )
    if should_submit_reschedule:
        request_result = await asyncio.to_thread(_sync_newbie_shift_request_only, doc)
        if not request_result.get("ok"):
            return {
                "ok": False,
                "session": doc,
                "requestSaved": False,
                "errorCode": request_result.get("errorCode") or "remote_unavailable",
                "error": request_result.get("error") or "The reschedule request could not be submitted. Retry Save/Submit.",
            }
        confirmed_at = datetime.now(timezone.utc).isoformat()
        confirmation = {
            "newbie_shift_request_confirmed_at": confirmed_at,
            "newbie_shift_request_submission_fingerprint": request_result.get("fingerprint") or _newbie_request_submission_fingerprint(doc),
        }
        await db.sessions.update_one({"_id": "active_session"}, {"$set": confirmation}, upsert=False)
        doc.update(confirmation)
        return {
            "ok": True,
            "session": doc,
            "requestSaved": True,
            "requestState": "already_pending" if request_result.get("alreadyPending") else "submitted",
        }
    return {"ok": True, "session": doc}


@api_router.post("/session/call")
async def save_call(payload: dict, request: Request):
    key = f"call_{payload.get('call_num', 1)}"
    await db.sessions.update_one({"_id": "active_session"}, {"$set": {key: payload, "current_call_draft": None, "current_call_num": None}})
    session = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    return {"ok": True, "session": session}


@api_router.post("/session/sup")
async def save_sup(payload: dict, request: Request):
    key = f"sup_transfer_{payload.get('transfer_num', 1)}"
    update = {key: payload, "current_sup_transfer_draft": None, "current_sup_transfer_num": None}
    if str(payload.get("result") or "").strip().lower() == "pass":
        update.update({
            "newbie_shift_data": None,
            "newbie_shift_scheduled_at": "",
            "newbie_shift_timezone": "",
            "newbie_shift_calendar_created": False,
            "newbie_shift_request_id": "",
            "newbie_shift_request_type": NEWBIE_REQUEST_INITIAL,
            "newbie_shift_request_status": "",
            "newbie_shift_requested_by": "",
            "newbie_shift_request_reason": "",
            "newbie_shift_request_details": "",
            "newbie_shift_request_created_at": "",
            "newbie_shift_original_scheduled_at": "",
            "newbie_shift_rescheduled_at": "",
            "newbie_shift_prompt": None,
            "supervisor_retry_required": False,
            "next_attempt_number": None,
            "fail_summary": "N/A",
        })
    await db.sessions.update_one({"_id": "active_session"}, {"$set": update})
    session = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    return {"ok": True, "session": session}


@api_router.post("/session/finish")
async def finish_session_simple(request: Request):
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if not doc:
        return {"ok": False, "error": "No active session"}
    final_status = compute_final_status(doc)
    timestamp_fields = _format_local_history_timestamp(datetime.now(timezone.utc))
    record = {
        **doc,
        **timestamp_fields,
        "candidate": doc.get("candidate_name", "Unknown"),
        "tester_name": doc.get("tester_name", ""),
        "final_status": final_status,
        "status": final_status,
        "history_id": doc.get("history_id") or doc.get("resume_source_history_id") or str(uuid.uuid4()),
    }
    saved_record, action = await _upsert_history_record(record, doc)
    shared_result = _sync_shared_candidate_tracking(saved_record)
    headset_review = None
    if _shared_truthy(saved_record.get("headset_review_requested")):
        if shared_result.get("ok"):
            headset_review = await _sync_finished_session_headset_review(saved_record)
        else:
            headset_review = {
                "ok": False,
                "reason": "parent_session_unavailable",
                "error": "Headset review parent session could not be verified.",
            }
        review_updates = _headset_review_sync_updates(saved_record, headset_review)
        saved_record.update(review_updates)
        _update_saved_history_fields(saved_record.get("history_id"), review_updates)
    db.backup("after-finish-session")
    await db.sessions.delete_one({"_id": "active_session"})
    warnings = []
    if not shared_result.get("ok"):
        warnings.append("Session saved locally, but shared Google Sheet update failed.")
    elif headset_review and not headset_review.get("ok"):
        warnings.append("Session saved, but the headset review could not be submitted. Retry it from History.")
    return {
        "ok": True,
        "action": action,
        "record": {k: v for k, v in saved_record.items() if k != "_id"},
        "sharedTracking": shared_result,
        "headsetReview": headset_review,
        "warning": " ".join(warnings),
    }


@api_router.post("/session/discard")
async def discard_session(request: Request):
    await db.sessions.delete_one({"_id": "active_session"})
    return {"ok": True}


# ══════════════════════════════════════════════════════════════════
# HISTORY ROUTES
# ══════════════════════════════════════════════════════════════════
@api_router.get("/history")
async def get_history():
    docs = _recent_history_docs(await db.history.find({}, {"_id": 0}).sort("timestamp", -1).to_list(500))
    for index, doc in enumerate(docs):
        doc = _session_with_workflow_defaults(doc)
        normalized_status = normalize_history_status(doc)
        doc["status"] = normalized_status
        if normalized_status != "NC/NS":
            doc["final_status"] = normalized_status
        doc["history_id"] = doc.get("history_id") or _history_identity(doc)
        docs[index] = doc
    _schedule_shadow_domains("history", "candidate_sessions")
    return docs


@api_router.post("/history/reconcile")
async def reconcile_history():
    started_at = time.perf_counter()
    newbie_result, correction_result, candidate_result = await asyncio.gather(
        asyncio.to_thread(
            _safe_history_reconciliation,
            _reconcile_remote_newbie_requests_into_local_state,
            "newbie_shift_history_entry_unavailable",
            True,
        ),
        asyncio.to_thread(
            _safe_history_reconciliation,
            _reconcile_remote_corrections_into_local_history,
            "correction_history_entry_unavailable",
        ),
        asyncio.to_thread(
            _safe_history_reconciliation,
            _reconcile_remote_candidate_information_into_local_history,
            "candidate_information_history_entry_unavailable",
        ),
    )
    docs = await get_history()
    stats = await get_history_stats()
    warnings = [
        result.get("error_code")
        for result in (newbie_result, correction_result, candidate_result)
        if result.get("error_code")
    ]
    return {
        "ok": any(result.get("ok") for result in (newbie_result, correction_result, candidate_result)),
        "history": docs,
        "stats": stats,
        "warnings": warnings,
        "reconciliation": {
            "newbieRequests": newbie_result,
            "corrections": correction_result,
            "candidateInformation": candidate_result,
        },
        "duration_ms": round((time.perf_counter() - started_at) * 1000, 1),
    }


@api_router.get("/history/stats")
async def get_history_stats():
    docs = _recent_history_docs(await db.history.find({}, {"_id": 0}).to_list(5000))
    total = len(docs)
    normalized_statuses = [normalize_history_status(doc) for doc in docs]
    passes = sum(1 for status in normalized_statuses if status in {"Pass", "RESUMED-PASS"})
    fails = sum(1 for status in normalized_statuses if status in {"Fail", "FAIL-Final Attempt"})
    ncns = sum(1 for status in normalized_statuses if status == "NC/NS")
    incomplete = sum(1 for status in normalized_statuses if status == "Incomplete")
    pass_rate = round((passes / total * 100) if total > 0 else 0, 1)
    result = {"total": total, "passes": passes, "fails": fails, "ncns": ncns, "incomplete": incomplete, "pass_rate": pass_rate}
    _schedule_shadow_domains("history")
    return result


@api_router.delete("/history")
async def clear_history(request: Request):
    _require_admin_token(request)
    db.backup("before-clear-history")
    await db.history.delete_many({})
    return {"ok": True}


@api_router.delete("/history/session/{history_id:path}")
async def delete_history_session(history_id: str, request: Request):
    db.backup("before-delete-history-session")
    deleted_record, cleanup = await _delete_history_record_by_identifier(history_id)
    if not deleted_record:
        raise HTTPException(status_code=404, detail="History session not found.")
    return {
        "ok": True,
        "deleted_history_id": deleted_record.get("history_id") or _history_identity(deleted_record),
        "cleanup": cleanup,
    }


@api_router.post("/history/session/{history_id:path}/deletion-request")
async def request_history_session_deletion(history_id: str, request: Request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    reason = str((payload or {}).get("reason") or "").strip()
    if len(reason) < 10:
        raise HTTPException(status_code=400, detail="Provide a deletion reason of at least 10 characters.")
    db.backup("before-delete-history-session-request")
    rows = db.history.store.fetchall("SELECT id, data FROM history_documents ORDER BY id DESC")
    target = None
    for row in rows:
        existing = SQLiteCollection.decode(row["data"])
        if _history_record_matches_identifier(existing, history_id):
            target = existing
            break
    if not target:
        raise HTTPException(status_code=404, detail="History session not found.")

    session_id = str(target.get("history_id") or _history_identity(target))
    request_id = str(target.get("deletion_request_id") or f"delete-{session_id}").strip()
    target = _session_with_workflow_defaults({
        **target,
        "deletion_request_id": request_id,
        "deletion_request_status": DELETION_REQUEST_PENDING,
        "deletion_request_created_at": target.get("deletion_request_created_at") or datetime.now(timezone.utc).isoformat(),
        "deletion_request_reason": reason,
    })

    shared_result = {"ok": False, "error": "Shared candidate deletion request sync unavailable."}
    context = _shared_sheet_context()
    if context.get("ok") and context.get("appsScriptClient"):
        try:
            row_values = _candidate_deletion_request_row(target, request_id)
            request_payload = dict(zip(SHARED_CANDIDATE_DELETION_REQUEST_HEADERS, row_values))
            request_payload["source_session_id"] = request_payload.pop("session_id", "")
            request_payload["request_type"] = "candidate_deletion"
            result = context["appsScriptClient"].post("upsertPendingRequest", {"request": request_payload})
            shared_result = {"ok": True, "request_id": request_id, "request_type": "candidate_deletion", "status": request_payload.get("status") or DELETION_REQUEST_PENDING, "action": result, "warning": "", "error_code": "", "message": ""}
        except Exception as exc:
            logger.warning("[SHARED] Apps Script candidate deletion request sync failed: %s", exc)
            shared_result = {"ok": False, "error": _candidate_tracking_temporary_unavailable_message(), "error_code": "apps_script_candidate_deletion_request_unavailable", "message": ""}
    elif context.get("ok"):
        try:
            sheets_api = context["service"].spreadsheets()
            row_values = _candidate_deletion_request_row(target, request_id)
            action = _shared_update_or_append_row(
                sheets_api,
                context["sheet_id"],
                SHARED_CANDIDATE_DELETION_REQUESTS_TAB,
                SHARED_CANDIDATE_DELETION_REQUEST_HEADERS,
                "request_id",
                request_id,
                row_values,
            )
            shared_result = {"ok": True, "action": action}
        except Exception as exc:
            logger.warning("[SHARED] Candidate deletion request sync failed: %s", exc)
            shared_result = {"ok": False, "error": _google_sheet_error_message(exc), "setup": _shared_tracking_required_setup()}
    else:
        shared_result = {"ok": False, "error": context.get("error"), "setup": context.get("setup")}

    deleted_record, cleanup = await _delete_history_record_by_identifier(history_id)
    return {
        "ok": True,
        "request_id": request_id,
        "status": DELETION_REQUEST_PENDING,
        "deleted_history_id": (deleted_record or target).get("history_id") or session_id,
        "cleanup": cleanup,
        "sharedRequest": shared_result,
        "message": "Removed from local history. Candidate-list deletion request is pending SAM review.",
    }


@api_router.post("/history/session/{history_id:path}/form-status")
async def update_history_session_form_status(history_id: str, request: Request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    requested_status = (payload or {}).get("form_fill_status")
    if requested_status not in FORM_FILL_STATUSES:
        raise HTTPException(
            status_code=400,
            detail={"error_code": "invalid_form_status", "message": f"Form status must be one of: {sorted(FORM_FILL_STATUSES)}"},
        )
    rows = db.history.store.fetchall("SELECT id, data FROM history_documents ORDER BY id DESC")
    target_row = None
    target = None
    for row in rows:
        existing = SQLiteCollection.decode(row["data"])
        if _history_record_matches_identifier(existing, history_id):
            target_row, target = row, existing
            break
    if not target:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "history_not_found", "message": "History session not found."},
        )
    now = datetime.now(timezone.utc).isoformat()
    update = {
        "form_fill_status": requested_status,
        "form_filled_at": now if requested_status == FORM_FILL_FILLED else "",
        "form_fill_error_summary": "",
    }
    target.update(update)
    db.history.store.execute(
        "UPDATE history_documents SET data = ?, timestamp = ? WHERE id = ?",
        (
            SQLiteCollection.encode(target),
            str(target.get("timestamp_iso") or target.get("timestamp") or ""),
            target_row["id"],
        ),
    )
    sheets_result = _sync_shared_candidate_tracking(target)
    return {
        "ok": True,
        "form_fill_status": requested_status,
        "form_filled_at": update["form_filled_at"],
        "sheets_result": sheets_result,
    }


@api_router.post("/history/session/{history_id:path}/correction-request")
async def request_history_session_correction(history_id: str, request: Request):
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    reason = str((payload or {}).get("reason") or "").strip()
    if len(reason) < 10:
        raise HTTPException(status_code=400, detail={"error_code": "correction_validation_failed", "message": "Provide a correction reason of at least 10 characters."})
    rows = db.history.store.fetchall("SELECT id, data FROM history_documents ORDER BY id DESC")
    target_row = None
    target = None
    for row in rows:
        existing = SQLiteCollection.decode(row["data"])
        if _history_record_matches_identifier(existing, history_id):
            target_row, target = row, existing
            break
    if not target:
        raise HTTPException(status_code=404, detail={"error_code": "correction_target_not_found", "message": "History session not found."})
    source_session_id = str(target.get("history_id") or target.get("session_id") or _history_identity(target)).strip()
    if not source_session_id:
        raise HTTPException(status_code=400, detail={"error_code": "correction_validation_failed", "message": "This session does not have a stable identifier."})
    requested_values = (payload or {}).get("changes") or {}
    if isinstance(requested_values, list):
        requested_values = {str(item.get("field") or ""): item.get("requested_value") for item in requested_values if isinstance(item, dict)}
    if not isinstance(requested_values, dict):
        raise HTTPException(status_code=400, detail={"error_code": "correction_validation_failed", "message": "Correction changes are invalid."})
    raw_changes = []
    headset = _candidate_headset_values(target)
    for field, requested in requested_values.items():
        field = str(field or "").strip().lower()
        if field not in CORRECTION_ALLOWED_FIELDS:
            raise HTTPException(status_code=400, detail={"error_code": "correction_unsupported_field", "message": "Only candidate name, headset brand, and headset model can be corrected."})
        if field == "candidate_name":
            previous = target.get("candidate") or target.get("candidate_name")
        elif field == "headset_brand":
            previous = headset["brand"]
        else:
            previous = headset["model"] if headset["separate"] else headset["label"]
        raw_changes.append({"field": field, "previous_value": previous or "", "requested_value": requested or ""})
    try:
        changes = _normalize_correction_changes(raw_changes)
    except ValueError as exc:
        code = str(exc)
        message = "At least one value must be changed." if code == "correction_no_changes" else "The correction request is invalid."
        raise HTTPException(status_code=400, detail={"error_code": code, "message": message})
    fingerprint_source = json.dumps({"session": source_session_id, "changes": changes}, sort_keys=True, separators=(",", ":"))
    fingerprint = hashlib.sha256(fingerprint_source.encode("utf-8")).hexdigest()
    if target.get("candidate_correction_pending") and target.get("candidate_correction_fingerprint") == fingerprint:
        raise HTTPException(status_code=409, detail={"error_code": "correction_already_pending", "message": "This correction request is already pending SAM review."})
    request_id = f"correction-{source_session_id}-{fingerprint[:12]}"
    now_iso = datetime.now(timezone.utc).isoformat()
    request_row = {
        "request_id": request_id, "request_type": CORRECTION_REQUEST_TYPE,
        "source_session_id": source_session_id, "candidate_id": target.get("candidate_id") or source_session_id,
        "candidate_name": target.get("candidate") or target.get("candidate_name") or "",
        "tester_name": target.get("tester_name") or "", "reason": reason,
        "changes_json": json.dumps(changes, separators=(",", ":")),
        "created_at": now_iso, "submitted_at": now_iso, "status": "pending", "admin_decision_at": "",
        "admin_decision_by": "", "denial_reason": "", "updated_at": now_iso,
    }
    context = _shared_sheet_context()
    if not context.get("ok"):
        raise HTTPException(status_code=503, detail={"error_code": "correction_transport_unavailable", "message": _candidate_tracking_temporary_unavailable_message()})
    try:
        if context.get("appsScriptClient"):
            context["appsScriptClient"].post("upsertPendingRequest", {"request": request_row})
        else:
            _shared_update_or_append_row(
                context["service"].spreadsheets(), context["sheet_id"],
                SHARED_CANDIDATE_CORRECTION_REQUESTS_TAB, SHARED_CANDIDATE_CORRECTION_REQUEST_HEADERS,
                "request_id", request_id, _shared_row_values(request_row, SHARED_CANDIDATE_CORRECTION_REQUEST_HEADERS),
            )
    except Exception as exc:
        logger.warning("[CORRECTIONS] Submission failed error_type=%s", type(exc).__name__)
        message = str(exc).lower()
        if "already been resolved" in message or "status has changed" in message:
            raise HTTPException(status_code=409, detail={"error_code": "correction_already_resolved", "message": "This correction request has already been resolved."})
        raise HTTPException(status_code=503, detail={"error_code": "correction_transport_unavailable", "message": "The correction request could not be submitted right now."})
    next_target = {
        **target, "candidate_correction_request_id": request_id, "candidate_correction_status": "pending",
        "candidate_correction_pending": True, "candidate_correction_changes": changes,
        "candidate_correction_reason": reason, "candidate_correction_created_at": now_iso,
        "candidate_correction_fingerprint": fingerprint, "candidate_correction_denial_reason": "",
    }
    db.history.store.execute(
        "UPDATE history_documents SET data = ?, timestamp = ? WHERE id = ?",
        (SQLiteCollection.encode(next_target), str(next_target.get("timestamp_iso") or next_target.get("timestamp") or ""), target_row["id"]),
    )
    return {"ok": True, "request_id": request_id, "request_type": CORRECTION_REQUEST_TYPE, "status": "pending", "changes": changes}

# ══════════════════════════════════════════════════════════════════
# TICKER / NOTIFICATIONS (fetches from admin-configured Google Sheet, falls back to cache/defaults)
# ══════════════════════════════════════════════════════════════════
NOTIFICATION_CACHE_TTL_SECONDS = 25
NOTIFICATION_REMOTE_FETCH_TIMEOUT_SECONDS = 15

_ticker_cache = {"messages": None, "last_fetch": 0, "using_fallback": False}
_headset_cache = {"groups": None, "denied": None, "last_fetch": 0}
_notification_cache = {"groups": None, "last_fetch": 0, "url": ""}

_default_managed_notifications = [
    {
        "Enabled": True,
        "ID": "default-welcome",
        "Type": "ticker",
        "Title": "Welcome",
        "Message": f"Welcome to Mock Testing Suite v{APP_VERSION}",
        "ShowTicker": True,
        "ShowPopup": False,
        "ShowBanner": False,
        "Persistent": True,
        "StartDate": "",
        "StartTime": "",
        "EndDate": "",
        "EndTime": "",
        "ActionText": "",
        "ActionURL": "",
        "CreatedAt": "2026-06-10T00:00:00Z",
        "UpdatedAt": "2026-06-10T00:00:00Z",
    },
    {
        "Enabled": True,
        "ID": "default-tip",
        "Type": "ticker",
        "Title": "Tip",
        "Message": "Tip: Use the Discord Post button to quickly copy common messages",
        "ShowTicker": True,
        "ShowPopup": False,
        "ShowBanner": False,
        "Persistent": True,
        "StartDate": "",
        "StartTime": "",
        "EndDate": "",
        "EndTime": "",
        "ActionText": "",
        "ActionURL": "",
        "CreatedAt": "2026-06-10T00:00:00Z",
        "UpdatedAt": "2026-06-10T00:00:00Z",
    },
    {
        "Enabled": True,
        "ID": "default-help",
        "Type": "ticker",
        "Title": "Help",
        "Message": "Need help? Check the Help tab for step-by-step setup guides",
        "ShowTicker": True,
        "ShowPopup": False,
        "ShowBanner": False,
        "Persistent": True,
        "StartDate": "",
        "StartTime": "",
        "EndDate": "",
        "EndTime": "",
        "ActionText": "",
        "ActionURL": "",
        "CreatedAt": "2026-06-10T00:00:00Z",
        "UpdatedAt": "2026-06-10T00:00:00Z",
    }
]

_notification_defaults = {
    "tickerMessages": [
        {
            "id": "default-welcome",
            "type": "ticker",
            "title": "Welcome",
            "message": f"Welcome to Mock Testing Suite v{APP_VERSION}.",
            "showTicker": True,
            "showPopup": False,
            "showBanner": False,
            "persistent": True,
            "startTime": "",
            "endTime": "",
            "actionText": "",
            "actionURL": "",
        },
        {
            "id": "default-basics",
            "type": "ticker",
            "title": "Basics",
            "message": "Complete The Basics before beginning call review.",
            "showTicker": True,
            "showPopup": False,
            "showBanner": False,
            "persistent": True,
            "startTime": "",
            "endTime": "",
            "actionText": "",
            "actionURL": "",
        },
        {
            "id": "default-headset",
            "type": "ticker",
            "title": "Headset",
            "message": "Review headset requirements before certification begins.",
            "showTicker": True,
            "showPopup": False,
            "showBanner": False,
            "persistent": True,
            "startTime": "",
            "endTime": "",
            "actionText": "",
            "actionURL": "",
        },
        {
            "id": "default-discord",
            "type": "ticker",
            "title": "Discord",
            "message": "Use Discord copy templates when posting session updates.",
            "showTicker": True,
            "showPopup": False,
            "showBanner": False,
            "persistent": True,
            "startTime": "",
            "endTime": "",
            "actionText": "",
            "actionURL": "",
        },
        {
            "id": "default-vpn",
            "type": "ticker",
            "title": "VPN",
            "message": "Confirm VPN/proxy checks manually when automated coverage is limited.",
            "showTicker": True,
            "showPopup": False,
            "showBanner": False,
            "persistent": True,
            "startTime": "",
            "endTime": "",
            "actionText": "",
            "actionURL": "",
        },
        {
            "id": "default-readiness",
            "type": "ticker",
            "title": "Readiness",
            "message": "Remember to review final readiness before submitting results.",
            "showTicker": True,
            "showPopup": False,
            "showBanner": False,
            "persistent": True,
            "startTime": "",
            "endTime": "",
            "actionText": "",
            "actionURL": "",
        },
        {
            "id": "default-fallback",
            "type": "ticker",
            "title": "Offline",
            "message": "If Google Sheets is unavailable, continue using local fallback guidance.",
            "showTicker": True,
            "showPopup": False,
            "showBanner": False,
            "persistent": True,
            "startTime": "",
            "endTime": "",
            "actionText": "",
            "actionURL": "",
        },
        {
            "id": "default-tip",
            "type": "ticker",
            "title": "Tip",
            "message": "Tip: Use the Discord Post button to quickly copy common messages.",
            "showTicker": True,
            "showPopup": False,
            "showBanner": False,
            "persistent": True,
            "startTime": "",
            "endTime": "",
            "actionText": "",
            "actionURL": "",
        },
    ],
    "banners": [],
    "popups": [],
}
DEFAULT_NOTIFICATION_TIMEZONE = "America/New_York"
NOTIFICATION_SHEET_COLUMNS = [
    "Enabled",
    "ID",
    "Type",
    "Title",
    "Message",
    "ShowTicker",
    "ShowPopup",
    "ShowBanner",
    "Persistent",
    "StartDate",
    "StartTime",
    "EndDate",
    "EndTime",
    "ActionText",
    "ActionURL",
    "CreatedAt",
    "UpdatedAt",
]


def _normalize_notification_bool(value):
    return _shared_truthy(value)


def _normalize_notification_bool_with_default(value, default=False):
    if value is None:
        return bool(default)
    if isinstance(value, str) and not value.strip():
        return bool(default)
    if _shared_truthy(value):
        return True
    if _shared_falsey(value):
        return False
    return bool(default)


def _normalize_notification_text(value):
    return str(value or "").strip()


def _normalize_notification_header(value):
    return re.sub(r"[^a-z0-9]+", "", _normalize_notification_text(value).lower())


def _normalize_notification_row(row):
    normalized = {}
    for key, value in (row or {}).items():
        normalized[_normalize_notification_header(key)] = value
    return normalized


def _notification_cell(row, *aliases):
    normalized = _normalize_notification_row(row)
    for alias in aliases:
        value = normalized.get(_normalize_notification_header(alias))
        if value is not None:
            return value
    return None


def _notification_row_values(row, headers):
    return [
        row[index] if index < len(row) else ""
        for index in range(len(headers))
    ]


def _normalize_notification_date(value, end_of_day=False):
    text = _normalize_notification_text(value)
    if not text:
        return None

    parsed = None
    if "T" in text and ("Z" in text or "+" in text):
        try:
            iso_str = text.replace("Z", "+00:00")
            dt = datetime.fromisoformat(iso_str)
            tz = _get_notification_zone()
            if tz and dt.tzinfo:
                dt = dt.astimezone(tz)
            parsed = datetime(dt.year, dt.month, dt.day)
        except Exception:
            try:
                clean_date = text.split("T")[0]
                parsed = datetime.strptime(clean_date, "%Y-%m-%d")
            except ValueError:
                parsed = None
    elif "T" in text:
        try:
            clean_date = text.split("T")[0]
            parsed = datetime.strptime(clean_date, "%Y-%m-%d")
        except ValueError:
            parsed = None
    elif re.match(r"^\d{4}-\d{2}-\d{2}$", text):
        try:
            parsed = datetime.strptime(text, "%Y-%m-%d")
        except ValueError:
            parsed = None
    else:
        for fmt in ("%m/%d/%Y", "%Y/%m/%d", "%m-%d-%Y"):
            try:
                parsed = datetime.strptime(text, fmt)
                break
            except ValueError:
                continue

    if not parsed:
        return None

    if end_of_day:
        return parsed.replace(hour=23, minute=59, second=59, microsecond=999999)
    return parsed.replace(hour=0, minute=0, second=0, microsecond=0)


def _normalize_notification_time(value):
    raw_str = _normalize_notification_text(value).strip()
    if not raw_str:
        return None

    # Handle ISO datetime strings like "1899-12-30T20:45:00.000Z" (from Google Sheets / Apps Script)
    if "T" in raw_str and ("Z" in raw_str or "+" in raw_str):
        try:
            iso_str = raw_str.replace("Z", "+00:00")
            dt = datetime.fromisoformat(iso_str)
            tz = _get_notification_zone()
            if tz and dt.tzinfo:
                dt = dt.astimezone(tz)
            return dt.hour, dt.minute, dt.second
        except Exception:
            pass

    iso_match = re.search(r"T(\d{1,2}):(\d{2})(?::(\d{2}))?", raw_str)
    if iso_match:
        h = int(iso_match.group(1))
        m = int(iso_match.group(2))
        s = int(iso_match.group(3)) if iso_match.group(3) else 0
        if h <= 23 and m <= 59 and s <= 59:
            return h, m, s

    text = raw_str.upper().replace(".", "").strip()

    for fmt in ("%I:%M %p", "%I:%M:%S %p", "%I:%M%p", "%I:%M:%S%p", "%H:%M", "%H:%M:%S", "%I%p"):
        try:
            parsed = datetime.strptime(text, fmt)
            return parsed.hour, parsed.minute, parsed.second
        except ValueError:
            continue

    # Support compact formats like "534AM" -> 5:34 AM, "0534AM", "534"
    match_compact = re.match(r"^(\d{1,2})(\d{2})\s*(AM|PM)$", text)
    if match_compact:
        try:
            parsed = datetime.strptime(f"{match_compact.group(1)}:{match_compact.group(2)} {match_compact.group(3)}", "%I:%M %p")
            return parsed.hour, parsed.minute, parsed.second
        except ValueError:
            pass

    return None


def _canonicalize_notification_date_str(value):
    dt = _normalize_notification_date(value)
    if dt:
        return dt.strftime("%Y-%m-%d")
    text = _normalize_notification_text(value)
    if not text:
        return ""
    if "T" in text and re.match(r"^\d{4}-\d{2}-\d{2}", text):
        return text.split("T")[0]
    return text


def _canonicalize_notification_time_str(value):
    t = _normalize_notification_time(value)
    if t:
        h, m, _ = t
        period = "PM" if h >= 12 else "AM"
        h12 = h % 12 or 12
        return f"{h12}:{m:02d} {period}"
    return _normalize_notification_text(value)


@lru_cache(maxsize=1)
def _get_notification_zone():
    try:
        return ZoneInfo(DEFAULT_NOTIFICATION_TIMEZONE)
    except Exception as exc:
        logger.warning(
            "[NOTIFICATIONS] Time zone '%s' is unavailable (%s). Falling back to naive local-time notification handling.",
            DEFAULT_NOTIFICATION_TIMEZONE,
            exc,
        )
        return None


def _notification_now_local():
    tz = _get_notification_zone()
    if tz is not None:
        return datetime.now(tz)
    return datetime.now()


def _combine_notification_datetime(date_value, time_value, default_time=None):
    parsed_date = _normalize_notification_date(date_value)
    if not parsed_date:
        return None

    parsed_time = _normalize_notification_time(time_value) or default_time
    if not parsed_time:
        return None

    tz = _get_notification_zone()
    return datetime(
        parsed_date.year,
        parsed_date.month,
        parsed_date.day,
        parsed_time[0],
        parsed_time[1],
        parsed_time[2],
        tzinfo=tz,
    )


def _extract_google_sheet_gid(value):
    text = str(value or "").strip()
    if not text:
        return ""

    match = re.search(r"(?:[?#&]gid=)(\d+)", text)
    if match:
        return match.group(1)
    return ""


def _slugify_notification_id_seed(value):
    slug = re.sub(r"[^a-z0-9]+", "-", _normalize_notification_text(value).lower()).strip("-")
    return slug[:48]


def _ensure_notification_id(item):
    existing = _normalize_notification_text((item or {}).get("ID"))
    if existing:
        return existing

    title_seed = _slugify_notification_id_seed((item or {}).get("Title") or (item or {}).get("Message") or "notification")
    date_seed = _normalize_notification_text((item or {}).get("StartDate")) or _notification_now_local().strftime("%Y-%m-%d")
    return f"{title_seed or 'notification'}-{date_seed}"


def _notification_now_iso():
    return datetime.now(timezone.utc).isoformat()


def _normalize_notification_manager_item(item):
    item = item or {}
    created_at = _normalize_notification_text(item.get("CreatedAt")) or _notification_now_iso()
    updated_at = _normalize_notification_text(item.get("UpdatedAt")) or _notification_now_iso()
    normalized_type = _normalize_notification_text(item.get("Type")).lower() or "info"
    legacy_ticker_type = normalized_type == "ticker"
    if legacy_ticker_type:
        normalized_type = "info"

    raw_start_date = item.get("StartDate")
    raw_start_time = item.get("StartTime")
    raw_end_date = item.get("EndDate")
    raw_end_time = item.get("EndTime")

    start_date = _canonicalize_notification_date_str(raw_start_date)
    start_time = _canonicalize_notification_time_str(raw_start_time) if _normalize_notification_text(raw_start_time) else ""
    end_date = _canonicalize_notification_date_str(raw_end_date)

    if not end_date:
        end_time = _canonicalize_notification_time_str(raw_end_time) if _normalize_notification_text(raw_end_time) else ""
        if end_time in {"12:00 AM", "12:00:00 AM", "0:00 AM"}:
            end_time = ""
    else:
        end_time = _canonicalize_notification_time_str(raw_end_time) if _normalize_notification_text(raw_end_time) else ""

    normalized = {
        "Enabled": _normalize_notification_bool_with_default(item.get("Enabled"), False),
        "ID": _normalize_notification_text(item.get("ID")),
        "Type": normalized_type,
        "Title": _normalize_notification_text(item.get("Title")),
        "Message": _normalize_notification_text(item.get("Message")),
        "ShowTicker": legacy_ticker_type or _normalize_notification_bool_with_default(item.get("ShowTicker"), False),
        "ShowPopup": _normalize_notification_bool_with_default(item.get("ShowPopup"), False),
        "ShowBanner": _normalize_notification_bool_with_default(item.get("ShowBanner"), False),
        "Persistent": _normalize_notification_bool_with_default(item.get("Persistent"), False),
        "StartDate": start_date,
        "StartTime": start_time,
        "EndDate": end_date,
        "EndTime": end_time,
        "ActionText": _normalize_notification_text(item.get("ActionText")),
        "ActionURL": _normalize_notification_text(item.get("ActionURL")),
        "CreatedAt": created_at,
        "UpdatedAt": updated_at,
    }
    normalized["ID"] = _ensure_notification_id(normalized)
    if not normalized["ActionURL"]:
        normalized["ActionText"] = ""
    return normalized


def _notification_item_from_row(row, fallback_index=1):
    row_data = {
        "Enabled": _notification_cell(row, "enabled"),
        "ID": _notification_cell(row, "id"),
        "Type": _notification_cell(row, "type", "category"),
        "Title": _notification_cell(row, "title"),
        "Message": _notification_cell(row, "message"),
        "ShowPopup": _notification_cell(row, "show popup", "showpopup", "popup"),
        "ShowTicker": _notification_cell(row, "show ticker", "showticker", "ticker"),
        "ShowBanner": _notification_cell(row, "show banner", "showbanner", "banner"),
        "Persistent": _notification_cell(row, "persistent"),
        "StartDate": _notification_cell(row, "start date", "startdate"),
        "StartTime": _notification_cell(row, "start time", "starttime"),
        "EndDate": _notification_cell(row, "end date", "enddate"),
        "EndTime": _notification_cell(row, "end time", "endtime"),
        "ActionText": _notification_cell(row, "action text", "actiontext"),
        "ActionURL": _notification_cell(row, "action url", "actionurl"),
        "CreatedAt": _notification_cell(row, "created at", "createdat"),
        "UpdatedAt": _notification_cell(row, "updated at", "updatedat"),
    }
    dismissible_value = _notification_cell(row, "dismissible")
    if row_data["Persistent"] is None and dismissible_value is not None:
        row_data["Persistent"] = "FALSE" if _normalize_notification_bool_with_default(dismissible_value, False) else "TRUE"

    # Google Sheets exports can include large blank regions; skip rows with no usable content.
    if not any(_normalize_notification_text(value) for value in row_data.values()):
        return None

    item = _normalize_notification_manager_item(row_data)
    if item["Type"] not in {"info", "warning", "urgent"}:
        item["Type"] = "info"
    return item


def _parse_notification_items(csv_text):
    reader = csv.DictReader(io.StringIO(csv_text or ""))
    items = []
    for index, row in enumerate(reader, start=1):
        if not isinstance(row, dict):
            continue
        item = _notification_item_from_row(row, fallback_index=index)
        if item is None:
            continue
        items.append(item)
    return items


def _group_notification_manager_items(items):
    groups = {"tickerMessages": [], "banners": [], "popups": []}

    for item in items or []:
        if not item.get("Enabled"):
            continue
        if item.get("Type") not in {"info", "warning", "urgent"}:
            continue
        if not _normalize_notification_text(item.get("Message")):
            continue

        start_date = _combine_notification_datetime(
            item.get("StartDate"),
            item.get("StartTime"),
            (0, 0, 0),
        ) if _normalize_notification_text(item.get("StartDate")) else None
        end_date = _combine_notification_datetime(
            item.get("EndDate"),
            item.get("EndTime"),
            (0, 0, 0),
        ) if _normalize_notification_text(item.get("EndDate")) else None

        if item.get("StartDate") and not start_date:
            continue
        if item.get("EndDate") and not end_date:
            continue
        if start_date and end_date and start_date > end_date:
            continue
        if not _notification_is_active(start_date, end_date):
            continue

        payload = {
            "id": item["ID"],
            "type": item["Type"],
            "title": item["Title"],
            "message": item["Message"],
            "showPopup": item["ShowPopup"],
            "showBanner": item["ShowBanner"],
            "persistent": item["Persistent"],
            "startTime": item["StartTime"],
            "endTime": item["EndTime"],
            "actionText": item["ActionText"] if item["ActionURL"] else "",
            "actionURL": item["ActionURL"],
        }

        if item.get("ShowTicker"):
            groups["tickerMessages"].append(payload)
        if payload["showBanner"]:
            groups["banners"].append(payload)
        if payload["showPopup"]:
            groups["popups"].append(payload)

    return groups


def _column_letter(column_number):
    if column_number < 1:
        raise ValueError("column_number must be >= 1")

    result = ""
    while column_number:
        column_number, remainder = divmod(column_number - 1, 26)
        result = chr(65 + remainder) + result
    return result


def _quote_sheet_title_for_a1(title):
    text = str(title or "").replace("'", "''")
    return f"'{text}'"


def _serialize_notification_sheet_row(item):
    normalized = _normalize_notification_manager_item(item)
    values = []
    for column in NOTIFICATION_SHEET_COLUMNS:
        value = normalized.get(column, "")
        if isinstance(value, bool):
            values.append("TRUE" if value else "FALSE")
        else:
            values.append(str(value or ""))
    return values


def _validate_notification_manager_item(item):
    normalized = _normalize_notification_manager_item(item)
    errors = []
    allowed_types = {"info", "warning", "urgent"}

    if normalized["Type"] not in allowed_types:
        errors.append("Type must be info, warning, or urgent.")
    if not normalized["Message"]:
        errors.append("Message is required.")
    if normalized["ActionText"] and not normalized["ActionURL"]:
        errors.append("Action URL is required when Action Text is filled.")

    start_date = None
    if normalized["StartDate"]:
        if not normalized["StartTime"]:
            errors.append("Enter a start time.")
        else:
            start_date = _combine_notification_datetime(
                normalized["StartDate"],
                normalized["StartTime"],
            )
            if not start_date:
                errors.append("Starts At must use a valid Eastern date and time.")

    end_date = None
    has_end_date = bool(normalized["EndDate"])
    has_end_time = bool(normalized["EndTime"])

    if has_end_date and not has_end_time:
        errors.append("Enter an expiration time or choose No Expiration.")
    elif not has_end_date and has_end_time:
        errors.append("Enter an expiration date or choose No Expiration.")
    elif has_end_date and has_end_time:
        end_date = _combine_notification_datetime(
            normalized["EndDate"],
            normalized["EndTime"],
        )
        if not end_date:
            errors.append("Expires At must use a valid Eastern date and time.")

    if start_date and end_date and end_date <= start_date:
        errors.append("Expires At must be after Starts At.")

    return {
        "item": normalized,
        "errors": errors,
    }


def _get_admin_notification_sheet_config():
    runtime_config = _load_backend_runtime_config()
    configured_value = _normalize_notification_text(runtime_config.get("notification_sheet_url"))
    configured_url = configured_value or DEFAULT_NOTIFICATION_SHEET_URL
    source = "runtime_config" if configured_value else "built-in default"
    return {
        "url": configured_url,
        "export_url": _resolve_notification_sheet_url(configured_url),
        "sheet_id": _extract_google_sheet_id(configured_url),
        "gid": _extract_google_sheet_gid(configured_url) or "0",
        "source": source,
        "configured": bool(configured_value),
        "using_default": not bool(configured_value),
    }


def _resolve_notification_service_account_file():
    resources_root = (os.getenv("APP_RESOURCES_PATH") or "").strip()
    resource_config_dir = Path(resources_root) / "backend" / "config" if resources_root else None
    candidates = [
        os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE"),
        os.getenv("GOOGLE_APPLICATION_CREDENTIALS"),
        str(resource_config_dir / "google-service-account.json") if resource_config_dir else "",
        str(resource_config_dir / "service-account.json") if resource_config_dir else "",
        str(Path(sys.executable).resolve().parent / "config" / "google-service-account.json") if getattr(sys, "frozen", False) else "",
        str(Path(sys.executable).resolve().parent / "config" / "service-account.json") if getattr(sys, "frozen", False) else "",
        str(ROOT_DIR / "config" / "google-service-account.json"),
        str(ROOT_DIR / "config" / "service-account.json"),
    ]
    for candidate in candidates:
        path_text = str(candidate or "").strip()
        if not path_text:
            continue
        path = Path(path_text).expanduser()
        if path.is_file():
            return path
    return None


def _read_service_account_client_email(path):
    if not path:
        return ""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f) or {}
        return str(data.get("client_email") or "").strip()
    except Exception as exc:
        logger.warning("[SHEETS] Unable to read service account client_email from %s: %s", path, exc)
        return ""


def _service_account_file_diagnostics():
    resources_root = (os.getenv("APP_RESOURCES_PATH") or "").strip()
    packaged_candidates = []
    if resources_root:
        resource_config_dir = Path(resources_root) / "backend" / "config"
        packaged_candidates.extend([
            resource_config_dir / "google-service-account.json",
            resource_config_dir / "service-account.json",
        ])
    if getattr(sys, "frozen", False):
        exe_config_dir = Path(sys.executable).resolve().parent / "config"
        packaged_candidates.extend([
            exe_config_dir / "google-service-account.json",
            exe_config_dir / "service-account.json",
        ])
    packaged_candidates.extend([
        ROOT_DIR.parent / "production-ready" / "Mock Testing Suite 1.0.1" / "win-unpacked" / "resources" / "backend" / "config" / "google-service-account.json",
        ROOT_DIR.parent / "production-ready" / "ADMIN ONLY - MTS Notification Manager 1.0.1" / "notification-manager-win-unpacked" / "resources" / "backend" / "config" / "google-service-account.json",
    ])

    dev_candidates = [
        ROOT_DIR / "config" / "google-service-account.json",
        ROOT_DIR / "config" / "service-account.json",
    ]

    def first_existing(candidates):
        for candidate in candidates:
            if candidate and Path(candidate).is_file():
                return Path(candidate)
        return None

    active_path = _resolve_notification_service_account_file()
    packaged_path = first_existing(packaged_candidates)
    dev_path = first_existing(dev_candidates)
    packaged_files = [
        {
            "path": str(Path(candidate)),
            "exists": Path(candidate).is_file(),
            "clientEmail": _read_service_account_client_email(Path(candidate)) if Path(candidate).is_file() else "",
        }
        for candidate in packaged_candidates
    ]
    packaged_email = _read_service_account_client_email(packaged_path)
    dev_email = _read_service_account_client_email(dev_path)
    active_email = _read_service_account_client_email(active_path)
    same_email = bool(packaged_email and dev_email and packaged_email == dev_email)
    same_path = bool(packaged_path and dev_path and packaged_path.resolve() == dev_path.resolve())

    return {
        "activePath": str(active_path or ""),
        "activeClientEmail": active_email,
        "packagedPath": str(packaged_path or ""),
        "packagedClientEmail": packaged_email,
        "packagedFiles": packaged_files,
        "devPath": str(dev_path or ""),
        "devClientEmail": dev_email,
        "packagedAndDevSamePath": same_path,
        "packagedAndDevSameClientEmail": same_email,
        "appResourcesPath": resources_root,
        "frozen": bool(getattr(sys, "frozen", False)),
    }


def _public_service_account_file_diagnostics(info):
    info = info or {}
    return {
        "activeFile": _safe_file_label(info.get("activePath")),
        "activeCredentialsFound": bool(info.get("activePath")),
        "activeClientEmailConfigured": bool(info.get("activeClientEmail")),
        "packagedFile": _safe_file_label(info.get("packagedPath")),
        "packagedCredentialsFound": bool(info.get("packagedPath")),
        "packagedClientEmailConfigured": bool(info.get("packagedClientEmail")),
        "devFile": _safe_file_label(info.get("devPath")),
        "devCredentialsFound": bool(info.get("devPath")),
        "devClientEmailConfigured": bool(info.get("devClientEmail")),
        "packagedFiles": [
            {
                "file": _safe_file_label((candidate or {}).get("path")),
                "exists": bool((candidate or {}).get("exists")),
                "clientEmailConfigured": bool((candidate or {}).get("clientEmail")),
            }
            for candidate in (info.get("packagedFiles") or [])
        ],
        "packagedAndDevSamePath": bool(info.get("packagedAndDevSamePath")),
        "packagedAndDevSameClientEmail": bool(info.get("packagedAndDevSameClientEmail")),
        "appResourcesPathConfigured": bool(info.get("appResourcesPath")),
        "frozen": bool(info.get("frozen")),
    }


def _get_notification_sheet_write_status():
    config = _get_admin_notification_sheet_config()
    creds_path = _resolve_notification_service_account_file()
    if not config["sheet_id"]:
        return {
            "ready": False,
            "error": "The runtime notification sheet URL is missing or invalid, so the backend cannot determine which Google Sheet to write to.",
        }
    if not creds_path:
        resources_root = (os.getenv("APP_RESOURCES_PATH") or "").strip()
        packaged_hint = (
            f" In packaged mode it should be bundled at {Path(resources_root) / 'backend' / 'config' / 'google-service-account.json'}."
            if resources_root
            else ""
        )
        return {
            "ready": False,
            "error": (
                "Direct Google Sheets write is not configured. Missing Google service account JSON. "
                "Set GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_APPLICATION_CREDENTIALS, or place the key at "
                "backend/config/google-service-account.json."
                f"{packaged_hint}"
            ),
        }
    client_email = _read_service_account_client_email(creds_path)
    logger.info("[SHEETS] Active Google service account file=%s client_email_configured=%s", _safe_file_label(creds_path), bool(client_email))
    return {"ready": True, "credentials_path": str(creds_path), "client_email": client_email}


def _get_notification_sheet_service():
    status = _get_notification_sheet_write_status()
    if not status.get("ready"):
        return {"ok": False, "error": status.get("error") or "Notification sheet credentials are not configured."}

    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except Exception as exc:
        return {"ok": False, "error": f"Google Sheets dependencies are unavailable: {exc}"}

    try:
        scopes = ["https://www.googleapis.com/auth/spreadsheets"]
        creds = service_account.Credentials.from_service_account_file(
            status["credentials_path"],
            scopes=scopes,
        )
        service = build("sheets", "v4", credentials=creds, cache_discovery=False)
        return {"ok": True, "service": service, "client_email": status.get("client_email") or ""}
    except Exception as exc:
        return {"ok": False, "error": f"Unable to initialize Google Sheets service account credentials: {exc}"}


def _google_sheet_error_message(exc):
    try:
        from googleapiclient.errors import HttpError
        if isinstance(exc, HttpError):
            content = exc.content.decode("utf-8", errors="replace") if getattr(exc, "content", None) else ""
            return content or str(exc)
    except Exception:
        pass
    return str(exc)


def _google_sheet_quota_or_temporary_error(exc):
    text = _google_sheet_error_message(exc).lower()
    return any(
        marker in text
        for marker in (
            "429",
            "quota",
            "rate_limit",
            "rate limit",
            "too many requests",
            "resource exhausted",
        )
    )


def _candidate_tracking_temporary_unavailable_message():
    return "Candidate Tracking is temporarily unavailable. SAM will retry automatically."


def _pending_requests_temporary_unavailable_message():
    return (
        "Pending Requests are temporarily unavailable. SAM will retry automatically. "
        "Please wait a moment and select Refresh if needed."
    )


def _headset_review_temporary_unavailable_message():
    return "Headset Review is temporarily unavailable. SAM will retry automatically."


def _google_sheet_error_type(exc):
    if exc is None:
        return ""
    return exc.__class__.__name__


def _sheet_permission_needed(operation):
    if str(operation or "").startswith("read_"):
        return "Viewer access to the target spreadsheet, plus Google Sheets API access for the project."
    return "Editor access to the target spreadsheet for the active service account, plus Google Sheets API access for the project."


def _run_google_sheet_permission_check():
    from services.apps_script_api import create_apps_script_sheet_service
    apps_script_res = create_apps_script_sheet_service(ROOT_DIR)
    if apps_script_res.get("ok"):
        client = apps_script_res["client"]
        apps_script_status = apps_script_res["status"]
        ping_ok = False
        ping_error = ""
        try:
            client.ping()
            ping_ok = True
        except Exception as e:
            ping_error = str(e)
            
        result = {
            "ok": ping_ok,
            "failedOperation": "" if ping_ok else "apps_script_ping",
            "errorType": "" if ping_ok else "AppsScriptError",
            "errorMessage": "" if ping_ok else ping_error,
            "error": "" if ping_ok else ping_error,
            "spreadsheetId": _shared_tracking_sheet_id() or "",
            "activeSpreadsheetId": _shared_tracking_sheet_id() or "",
            "serviceAccountEmail": "apps-script-api-endpoint",
            "activeServiceAccountEmail": "apps-script-api-endpoint",
            "credentialFiles": {},
            "appsScriptApi": {
                "enabled": True,
                "status": "ready" if ping_ok else "error",
                "message": "Apps Script API is online." if ping_ok else f"Apps Script ping failed: {ping_error}",
                "file": _safe_file_label(apps_script_status.get("path") or ""),
            },
            "masterMtsContentCandidateSheetConfig": {
                "spreadsheetId": _shared_tracking_sheet_id() or "",
                "purpose": "Master MTS content, shared candidate tracking, Gemini prompt overrides, and update metadata.",
            },
            "notificationSheetConfig": {
                "spreadsheetId": _shared_tracking_sheet_id() or "",
                "gid": "0",
                "configured": True,
                "usingDefault": False,
                "purpose": "SAM notification rows/ticker/banner/popup only.",
            },
            "operations": [
                {
                    "operation": "apps_script_ping",
                    "ok": ping_ok,
                    "errorMessage": ping_error,
                }
            ],
            "permissionNeeded": "",
        }
        return result

    runtime_config = {}
    notification_config = {}
    master_sheet_id = ""
    credential_info = {}
    result = {
        "ok": False,
        "failedOperation": "",
        "errorType": "",
        "errorMessage": "",
        "error": "",
        "spreadsheetId": "",
        "serviceAccountEmail": "",
        "activeServiceAccountEmail": "",
        "activeSpreadsheetId": "",
        "credentialFiles": {},
        "masterMtsContentCandidateSheetConfig": {
            "spreadsheetId": "",
            "sourceKeys": [
                "admin_content_sheet_id",
                "admin_content_sheet_url",
                "content_sheet_id",
                "content_sheet_url",
                "built-in default",
            ],
            "purpose": "Master MTS content, shared candidate tracking, Gemini prompt overrides, and update metadata.",
        },
        "notificationSheetConfig": {
            "spreadsheetId": "",
            "gid": "0",
            "configured": False,
            "usingDefault": False,
            "purpose": "SAM notification rows/ticker/banner/popup only.",
        },
        "operations": [],
        "permissionNeeded": "",
    }

    def apply_context():
        result["spreadsheetId"] = master_sheet_id or result.get("spreadsheetId") or ""
        result["activeSpreadsheetId"] = result["spreadsheetId"]
        service_email_configured = bool((credential_info or {}).get("activeClientEmail") or result.get("serviceAccountEmail"))
        result["serviceAccountEmail"] = "configured" if service_email_configured else ""
        result["serviceAccountEmailConfigured"] = service_email_configured
        result["activeServiceAccountEmail"] = result["serviceAccountEmail"]
        result["activeServiceAccountEmailConfigured"] = service_email_configured
        result["credentialFiles"] = _public_service_account_file_diagnostics(credential_info)
        result["masterMtsContentCandidateSheetConfig"]["spreadsheetId"] = result["spreadsheetId"]
        if notification_config:
            result["notificationSheetConfig"].update({
                "spreadsheetId": notification_config.get("sheet_id") or "",
                "gid": notification_config.get("gid") or "0",
                "configured": bool(notification_config.get("configured")),
                "usingDefault": bool(notification_config.get("using_default")),
            })

    def is_permission_error(exc):
        text = _google_sheet_error_message(exc).lower()
        return (
            "403" in text
            or "permission_denied" in text
            or "the caller does not have permission" in text
            or "permission" in text
        )

    def record_success(operation, **extra):
        result["operations"].append({"operation": operation, "ok": True, **extra})

    def record_failure(operation, exc, *, permission_needed=None):
        apply_context()
        message = _google_sheet_error_message(exc)
        error_type = _google_sheet_error_type(exc)
        reason = _shared_permission_hint(exc)
        clear_message = "Service account lacks Editor access to this spreadsheet." if is_permission_error(exc) else message
        result["operations"].append({
            "operation": operation,
            "ok": False,
            "errorType": error_type,
            "errorMessage": clear_message,
            "googleErrorMessage": message,
            "reason": reason,
        })
        result.update({
            "ok": False,
            "failedOperation": operation,
            "errorType": error_type,
            "errorMessage": clear_message,
            "error": clear_message,
            "reason": reason,
            "permissionNeeded": permission_needed or _sheet_permission_needed(operation),
        })
        logger.exception(
            "[SHEETS-DIAG] Operation failed. operation=%s spreadsheet_id=%s service_account_configured=%s reason=%s error=%s",
            operation,
            _mask_config_value(result.get("spreadsheetId")),
            bool(result.get("serviceAccountEmail")),
            reason,
            message,
        )

    try:
        runtime_config = _load_backend_runtime_config()
        notification_config = _get_admin_notification_sheet_config()
        master_sheet_id = _resolve_content_sheet_id(runtime_config or {})
        credential_info = _service_account_file_diagnostics()
        apply_context()
    except Exception as exc:
        record_failure("load_configuration", exc, permission_needed="Readable backend runtime config and service account config paths.")
        return result

    logger.info(
        "[SHEETS-DIAG] Starting permission check. master_spreadsheet_id=%s notification_spreadsheet_id=%s service_account_configured=%s",
        _mask_config_value(master_sheet_id),
        _mask_config_value(notification_config.get("sheet_id")),
        bool((credential_info or {}).get("activeClientEmail")),
    )

    if not master_sheet_id:
        message = "No master MTS content/candidate spreadsheet ID is configured."
        result["operations"].append({"operation": "resolve_master_spreadsheet_id", "ok": False, "errorType": "ConfigurationError", "errorMessage": message})
        result.update({
            "failedOperation": "resolve_master_spreadsheet_id",
            "errorType": "ConfigurationError",
            "errorMessage": message,
            "error": message,
            "permissionNeeded": "Configure admin_content_sheet_id/admin_content_sheet_url, or content_sheet_id/content_sheet_url.",
        })
        return result
    if not credential_info.get("activePath"):
        message = "No active google-service-account.json was found."
        result["operations"].append({"operation": "load_credentials", "ok": False, "errorType": "ConfigurationError", "errorMessage": message})
        result.update({
            "failedOperation": "load_credentials",
            "errorType": "ConfigurationError",
            "errorMessage": message,
            "error": message,
            "permissionNeeded": "Place the service account JSON where the dev or packaged app resolves it, or set GOOGLE_SERVICE_ACCOUNT_FILE.",
        })
        return result

    service_result = {}
    try:
        service_result = _get_shared_tracking_sheet_service()
        if not service_result.get("ok"):
            message = service_result.get("error") or "Unable to initialize Google Sheets service account credentials."
            result["operations"].append({"operation": "load_credentials", "ok": False, "errorType": "GoogleSheetsInitializationError", "errorMessage": message})
            result.update({
                "failedOperation": "load_credentials",
                "errorType": "GoogleSheetsInitializationError",
                "errorMessage": message,
                "error": message,
                "permissionNeeded": "Valid service account JSON with Google Sheets API enabled.",
            })
            return result
        service_email_configured = bool(service_result.get("serviceAccountEmail") or result.get("serviceAccountEmailConfigured"))
        result["serviceAccountEmail"] = "configured" if service_email_configured else ""
        result["serviceAccountEmailConfigured"] = service_email_configured
        result["activeServiceAccountEmail"] = result["serviceAccountEmail"]
        result["activeServiceAccountEmailConfigured"] = service_email_configured
        record_success("load_credentials", credentialsConfigured=service_email_configured)
    except Exception as exc:
        record_failure("load_credentials", exc, permission_needed="Valid service account JSON with Google Sheets API enabled.")
        return result

    sheets_api = None
    try:
        sheets_api = service_result["service"].spreadsheets()
        record_success("open_spreadsheet", spreadsheetId=master_sheet_id)
    except Exception as exc:
        record_failure("open_spreadsheet", exc)
        return result

    test_tab_title = "_mts_permission_check"
    test_headers = [["diagnostic", "checked_at"]]
    metadata = None
    tabs = {}

    try:
        logger.info("[SHEETS-DIAG] Operation=read_spreadsheet_metadata spreadsheet_id=%s", _mask_config_value(master_sheet_id))
        metadata = sheets_api.get(spreadsheetId=master_sheet_id).execute()
        record_success("read_spreadsheet_metadata", title=((metadata.get("properties") or {}).get("title") or ""))
    except Exception as exc:
        record_failure("read_spreadsheet_metadata", exc)
        return result

    try:
        logger.info("[SHEETS-DIAG] Operation=list_tabs spreadsheet_id=%s", _mask_config_value(master_sheet_id))
        tabs = {
            ((sheet.get("properties") or {}).get("title") or ""): sheet
            for sheet in metadata.get("sheets", [])
        }
        record_success("list_tabs", tabs=sorted(tabs.keys()))
    except Exception as exc:
        record_failure("list_tabs", exc)
        return result

    try:
        if test_tab_title not in tabs:
            logger.info("[SHEETS-DIAG] Operation=create_or_verify_test_tab spreadsheet_id=%s tab=%s", _mask_config_value(master_sheet_id), test_tab_title)
            sheets_api.batchUpdate(
                spreadsheetId=master_sheet_id,
                body={"requests": [{"addSheet": {"properties": {"title": test_tab_title}}}]},
            ).execute()
            record_success("create_or_verify_test_tab", tab=test_tab_title, created=True)
        else:
            record_success("create_or_verify_test_tab", tab=test_tab_title, created=False)
    except Exception as exc:
        record_failure("create_or_verify_test_tab", exc)
        return result

    quoted_test_tab = _quote_sheet_title_for_a1(test_tab_title)
    try:
        logger.info("[SHEETS-DIAG] Operation=read_test_tab spreadsheet_id=%s tab=%s", _mask_config_value(master_sheet_id), test_tab_title)
        sheets_api.values().get(
            spreadsheetId=master_sheet_id,
            range=f"{quoted_test_tab}!A1:B2",
        ).execute()
        record_success("read_test_tab", tab=test_tab_title)
    except Exception as exc:
        record_failure("read_test_tab", exc)
        return result

    try:
        logger.info("[SHEETS-DIAG] Operation=write_test_cell spreadsheet_id=%s tab=%s", _mask_config_value(master_sheet_id), test_tab_title)
        sheets_api.values().update(
            spreadsheetId=master_sheet_id,
            range=f"{quoted_test_tab}!A1:B1",
            valueInputOption="USER_ENTERED",
            body={"values": test_headers},
        ).execute()
        record_success("write_test_cell", tab=test_tab_title, range="A1:B1")
    except Exception as exc:
        record_failure("write_test_cell", exc)
        return result

    try:
        logger.info("[SHEETS-DIAG] Operation=append_test_row spreadsheet_id=%s tab=%s", _mask_config_value(master_sheet_id), test_tab_title)
        sheets_api.values().append(
            spreadsheetId=master_sheet_id,
            range=f"{quoted_test_tab}!A2",
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": [["append-check", datetime.now(timezone.utc).isoformat()]]},
        ).execute()
        record_success("append_test_row", tab=test_tab_title, range="A2")
    except Exception as exc:
        record_failure("append_test_row", exc)
        return result

    result.update({
        "ok": True,
        "failedOperation": "",
        "errorType": "",
        "errorMessage": "",
        "error": "",
        "permissionNeeded": "Current active service account has the read/write access required for the tested master sheet operations.",
    })
    logger.info(
        "[SHEETS-DIAG] Permission check passed. master_spreadsheet_id=%s service_account_configured=%s",
        _mask_config_value(master_sheet_id),
        bool(result["activeServiceAccountEmail"]),
    )
    return result


def _load_legacy_notification_items_from_google_sheets_api():
    config = _get_admin_notification_sheet_config()
    service_result = _get_notification_sheet_service()
    if not service_result.get("ok"):
        return service_result

    try:
        logger.info(
            "[NOTIFICATIONS] Reading Google Sheet via authenticated API: sheet=%s gid=%s",
            _mask_config_value(config.get("sheet_id")),
            config.get("gid") or "0",
        )
        sheets_api = service_result["service"].spreadsheets()
        metadata = sheets_api.get(spreadsheetId=config["sheet_id"]).execute()
        sheets = metadata.get("sheets", [])
        target_gid = str(config["gid"] or "0")
        target_sheet = next(
            (
                sheet for sheet in sheets
                if str((sheet.get("properties") or {}).get("sheetId")) == target_gid
            ),
            None,
        )
        if target_sheet is None and sheets:
            target_sheet = sheets[0]
        if target_sheet is None:
            return {"ok": False, "error": "The configured spreadsheet does not contain any worksheets."}

        sheet_title = (target_sheet.get("properties") or {}).get("title") or "Sheet1"
        logger.info("[NOTIFICATIONS] Using Google Sheet tab '%s' for notifications/ticker", sheet_title)
        quoted_title = _quote_sheet_title_for_a1(sheet_title)
        last_column = _column_letter(len(NOTIFICATION_SHEET_COLUMNS))
        raw_values = sheets_api.values().get(
            spreadsheetId=config["sheet_id"],
            range=f"{quoted_title}!A:{last_column}",
        ).execute().get("values", [])

        if not raw_values:
            return {"ok": True, "items": [], "sheetTitle": sheet_title}

        headers = [str(value or "").strip() for value in raw_values[0]]
        items = []
        for index, row in enumerate(raw_values[1:], start=1):
            row_dict = {
                headers[col_index]: (row[col_index] if col_index < len(row) else "")
                for col_index in range(len(headers))
                if headers[col_index]
            }
            item = _notification_item_from_row(row_dict, fallback_index=index)
            if item is not None:
                items.append(item)

        logger.info("[NOTIFICATIONS] Parsed %s valid notification rows from tab '%s'", len(items), sheet_title)
        return {"ok": True, "items": items, "sheetTitle": sheet_title}
    except Exception as exc:
        logger.warning("[NOTIFICATIONS] Authenticated Google Sheets read failed: %s", exc)
        return {"ok": False, "error": f"Authenticated Google Sheets read failed: {exc}"}


def _ensure_sam_notifications_sheet(sheets_api, sheet_id):
    metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
    tabs = {
        ((sheet.get("properties") or {}).get("title") or ""): sheet
        for sheet in metadata.get("sheets", [])
    }
    status = _verify_sam_notifications_tab(sheets_api, sheet_id, tabs)
    refreshed = sheets_api.get(spreadsheetId=sheet_id).execute()
    for sheet in refreshed.get("sheets", []):
        props = sheet.get("properties") or {}
        if props.get("title") == SAM_NOTIFICATIONS_TAB:
            status["sheetId"] = props.get("sheetId")
            break
    return status


def _read_sam_notification_items(sheets_api, sheet_id):
    status = _ensure_sam_notifications_sheet(sheets_api, sheet_id)
    if not status.get("ok"):
        return status
    items = []
    rows = _shared_read_rows(sheets_api, sheet_id, SAM_NOTIFICATIONS_TAB, NOTIFICATION_SHEET_COLUMNS)
    for index, row in enumerate(rows, start=1):
        item = _notification_item_from_row(row, fallback_index=index)
        if item is not None:
            items.append(item)
    return {"ok": True, "items": items, "sheetTitle": SAM_NOTIFICATIONS_TAB, "sheetId": sheet_id, "source": "master"}


def _read_sam_notification_items_via_apps_script(client, sheet_id=""):
    rows = _apps_script_rows(client, "getTickerMessages")
    items = []
    for index, row in enumerate(rows, start=1):
        item = _notification_item_from_row(row, fallback_index=index)
        if item is not None:
            items.append(item)
    return {"ok": True, "items": items, "sheetTitle": SAM_NOTIFICATIONS_TAB, "sheetId": sheet_id, "source": "master"}


def _migrate_legacy_notifications_to_master(sheets_api, sheet_id):
    existing_rows = _shared_read_rows(sheets_api, sheet_id, SAM_NOTIFICATIONS_TAB, NOTIFICATION_SHEET_COLUMNS)
    existing_ids = {
        _normalize_notification_text(row.get("ID"))
        for row in existing_rows
        if _normalize_notification_text(row.get("ID"))
    }
    legacy = _load_legacy_notification_items_from_google_sheets_api()
    if not legacy.get("ok"):
        return {"ok": False, "migrated": 0, "error": legacy.get("error") or ""}
    rows_to_append = []
    for item in legacy.get("items") or []:
        item_id = _normalize_notification_text(item.get("ID")) or _ensure_notification_id(item)
        if not item_id or item_id in existing_ids:
            continue
        existing_ids.add(item_id)
        rows_to_append.append(_serialize_notification_sheet_row({**item, "ID": item_id}))
    if rows_to_append:
        quoted = _quote_sheet_title_for_a1(SAM_NOTIFICATIONS_TAB)
        sheets_api.values().append(
            spreadsheetId=sheet_id,
            range=f"{quoted}!A2",
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": rows_to_append},
        ).execute()
    return {"ok": True, "migrated": len(rows_to_append)}


def _notification_read_sheet_context():
    preferred_role = (
        (os.getenv("APPS_SCRIPT_API_ROLE") or "").strip().lower()
    )
    if preferred_role not in {"mts", "sam"}:
        preferred_role = "sam" if (os.getenv("MTS_NOTIFICATION_MANAGER") or "").strip() == "1" else "mts"

    from services.apps_script_api import create_apps_script_sheet_service, load_apps_script_api_config

    # 1. Load config status of preferred role
    _, status = load_apps_script_api_config(ROOT_DIR, expected_role=preferred_role)
    cfg_status = status.get("status")

    resolved_role = preferred_role

    # 2. Check if we need cross-role fallback
    # Fallback is allowed ONLY if preferred configuration is genuinely absent (missing) or disabled.
    if cfg_status in {"missing", "disabled"}:
        fallback_role = "mts" if preferred_role == "sam" else "sam"
        _, fb_status = load_apps_script_api_config(ROOT_DIR, expected_role=fallback_role)
        if fb_status.get("status") == "ready":
            resolved_role = fallback_role
            status = fb_status
            cfg_status = "ready"

    # Try initializing the client for the resolved role
    if cfg_status == "ready":
        try:
            apps_script_result = create_apps_script_sheet_service(ROOT_DIR, expected_role=resolved_role)
            if apps_script_result.get("ok") and apps_script_result.get("client"):
                return {
                    "ok": True,
                    "service": None,
                    "appsScriptClient": apps_script_result["client"],
                    "sheet_id": "",
                    "transport": "apps_script",
                    "resolved_role": resolved_role,
                    "role_status": status,
                }
        except Exception as exc:
            logger.warning("[NOTIFICATIONS] Failed to initialize Apps Script client: %s", exc)

    elif cfg_status not in {"missing", "disabled"}:
        # Configuration is present but mismatched or invalid. Fallback is NOT allowed.
        return {
            "ok": False,
            "error": status.get("message") or f"Apps Script config for role '{resolved_role}' is invalid.",
            "errorCode": status.get("status") or "config_invalid",
            "transport": "apps_script",
            "resolved_role": resolved_role,
            "role_status": status,
        }

    # 3. Direct Google Sheets API fallback (if in development mode and no Apps Script is available)
    if _is_development_mode():
        service_result = _get_shared_tracking_sheet_service()
        if service_result.get("ok") and service_result.get("service"):
            return {
                "ok": True,
                "service": service_result["service"],
                "appsScriptClient": None,
                "sheet_id": service_result["sheet_id"],
                "transport": "direct_sheets_development",
                "resolved_role": preferred_role,
            }

    return {
        "ok": False,
        "errorCode": "setup_configuration_unavailable",
        "error": "Apps Script config is not ready and direct Sheets fallback is unavailable.",
        "resolved_role": preferred_role,
    }


def _load_notification_items_from_google_sheets_api():
    context = _notification_read_sheet_context()

    if not context.get("ok"):
        error_code = context.get("errorCode")
        if error_code in {"role_mismatch", "invalid", "config_invalid"}:
            return {
                "ok": False,
                "error": context.get("error") or "Apps Script configuration error.",
                "errorCode": error_code,
                "items": [],
            }

        legacy = _load_legacy_notification_items_from_google_sheets_api()
        if legacy.get("ok"):
            legacy["source"] = "legacy_fallback"
            logger.warning("[NOTIFICATIONS] Active source=LEGACY fallback sheet.")
        return legacy

    try:
        if context.get("appsScriptClient"):
            try:
                read_result = _read_sam_notification_items_via_apps_script(context["appsScriptClient"], context.get("sheet_id") or "")
                logger.info("[NOTIFICATIONS] Active source=APPS_SCRIPT tab=%s rows=%d", SAM_NOTIFICATIONS_TAB, len(read_result.get("items") or []))
                return read_result
            except Exception as exc:
                err_msg = str(exc)
                err_code = "read_failed"
                from services.apps_script_api import AppsScriptApiError
                if isinstance(exc, AppsScriptApiError):
                    if "Unauthorized" in err_msg or "Forbidden" in err_msg or "401" in err_msg or "403" in err_msg:
                        err_code = "unauthorized"
                    else:
                        err_code = "action_failure"
                elif "timeout" in err_msg.lower() or "time out" in err_msg.lower():
                    err_code = "timeout"
                elif "connect" in err_msg.lower() or "unreachable" in err_msg.lower() or "host" in err_msg.lower():
                    err_code = "remote_unavailable"
                elif isinstance(exc, (ValueError, TypeError, AttributeError, KeyError)) or "returned no rows array" in err_msg:
                    err_code = "malformed_response"

                logger.warning("[NOTIFICATIONS] Authenticated read failed (no fallback allowed): %s", exc)
                return {
                    "ok": False,
                    "error": f"Authenticated Apps Script read failed: {exc}",
                    "errorCode": err_code,
                    "items": [],
                }
        else:
            sheets_api = context["service"].spreadsheets()
            read_result = _read_sam_notification_items(sheets_api, context["sheet_id"])
            if read_result.get("ok") and not read_result.get("items"):
                migration = _migrate_legacy_notifications_to_master(sheets_api, context["sheet_id"])
                if migration.get("migrated"):
                    logger.info("[NOTIFICATIONS] Migrated %d row(s) into master %s tab.", migration["migrated"], SAM_NOTIFICATIONS_TAB)
                    read_result = _read_sam_notification_items(sheets_api, context["sheet_id"])
            if read_result.get("ok"):
                logger.info("[NOTIFICATIONS] Active source=MASTER tab=%s rows=%d", SAM_NOTIFICATIONS_TAB, len(read_result.get("items") or []))
            return read_result
    except Exception as exc:
        logger.warning("[NOTIFICATIONS] Direct Sheets read failed: %s", exc)
        return {
            "ok": False,
            "error": f"Direct Sheets read failed: {exc}",
            "errorCode": "direct_sheets_failed",
            "items": [],
        }



def _clear_notification_caches():
    _notification_cache["groups"] = None
    _notification_cache["last_fetch"] = 0
    _notification_cache["url"] = ""
    _ticker_cache["messages"] = None
    _ticker_cache["last_fetch"] = 0
    _ticker_cache["using_fallback"] = False


def _save_notification_to_google_sheet(item):
    validated = _validate_notification_manager_item(item)
    normalized = validated["item"]
    if validated["errors"]:
        return {"ok": False, "error": " ".join(validated["errors"])}

    context = _sam_master_sheet_context()
    if not context.get("ok"):
        return {"ok": False, "error": context.get("error") or "SAM master Google Sheet is not configured."}

    apps_script_client = context.get("appsScriptClient")
    if apps_script_client:
        try:
            action = "updateNotification" if normalized.get("ID") else "addNotification"
            result = apps_script_client.post(action, {"item": normalized})
            _clear_notification_caches()
            return {
                "ok": True,
                "action": result.get("action") if isinstance(result, dict) and result.get("action") else "updated",
                "item": normalized,
                "sheetTitle": SAM_NOTIFICATIONS_TAB,
                "sheetId": context.get("sheet_id") or "",
                "source": "apps-script",
                **(result if isinstance(result, dict) else {}),
            }
        except Exception as exc:
            logger.exception("[NOTIFICATIONS] Apps Script notification write failed: %s", exc)
            return {"ok": False, "error": f"Apps Script notification write failed: {exc}"}

    sheet_id = context["sheet_id"]
    service = context["service"]
    client_email = context.get("serviceAccountEmail") or _get_service_account_email() or "unknown"

    try:
        from googleapiclient.errors import HttpError
    except Exception as exc:
        return {"ok": False, "error": f"Google Sheets dependencies are unavailable: {exc}"}

    current_operation = "initialize"
    try:
        sheets_api = service.spreadsheets()

        current_operation = "ensure_master_notification_tab"
        logger.info(
            "[NOTIFICATIONS] Operation=ensure_master_notification_tab spreadsheet_id=%s tab=%s service_account_configured=%s",
            _mask_config_value(sheet_id),
            SAM_NOTIFICATIONS_TAB,
            bool(client_email),
        )
        tab_status = _ensure_sam_notifications_sheet(sheets_api, sheet_id)
        if not tab_status.get("ok"):
            return {"ok": False, "error": tab_status.get("error") or "Unable to verify sam-notifications tab."}

        sheet_title = SAM_NOTIFICATIONS_TAB
        quoted_title = _quote_sheet_title_for_a1(sheet_title)
        last_column = _column_letter(len(NOTIFICATION_SHEET_COLUMNS))
        header_range = f"{quoted_title}!A1:{last_column}1"
        current_operation = "read_header"
        header_response = sheets_api.values().get(
            spreadsheetId=sheet_id,
            range=header_range,
        ).execute()
        header_values = (header_response.get("values") or [[]])[0]
        expected_header = NOTIFICATION_SHEET_COLUMNS
        header_has_data = any(_normalize_notification_text(value) for value in header_values)

        if header_has_data and header_values[: len(expected_header)] != expected_header:
            return {
                "ok": False,
                "error": (
                    "The configured notification sheet has an unexpected header row. "
                    f"Expected: {', '.join(expected_header)}"
                ),
            }

        if not header_has_data:
            current_operation = "header_write"
            logger.info("[NOTIFICATIONS] Operation=header_write spreadsheet_id=%s tab=%s", _mask_config_value(sheet_id), sheet_title)
            sheets_api.values().update(
                spreadsheetId=sheet_id,
                range=header_range,
                valueInputOption="USER_ENTERED",
                body={"values": [expected_header]},
            ).execute()

        data_range = f"{quoted_title}!A2:{last_column}"
        current_operation = "read_rows"
        logger.info("[NOTIFICATIONS] Operation=read_rows spreadsheet_id=%s tab=%s", _mask_config_value(sheet_id), sheet_title)
        existing_rows = sheets_api.values().get(
            spreadsheetId=sheet_id,
            range=data_range,
        ).execute().get("values", [])

        row_values = _serialize_notification_sheet_row({
            **normalized,
            "UpdatedAt": _notification_now_iso(),
        })
        target_row_number = None
        target_id = normalized["ID"]
        for row_index, row in enumerate(existing_rows, start=2):
            existing_id = _normalize_notification_text(row[1] if len(row) > 1 else "")
            if existing_id and existing_id == target_id:
                target_row_number = row_index
                break

        if target_row_number is not None:
            current_operation = "update"
            logger.info("[NOTIFICATIONS] Operation=update spreadsheet_id=%s tab=%s row=%s", _mask_config_value(sheet_id), sheet_title, target_row_number)
            sheets_api.values().update(
                spreadsheetId=sheet_id,
                range=f"{quoted_title}!A{target_row_number}:{last_column}{target_row_number}",
                valueInputOption="USER_ENTERED",
                body={"values": [row_values]},
            ).execute()
            action = "updated"
        else:
            current_operation = "append"
            logger.info("[NOTIFICATIONS] Operation=append spreadsheet_id=%s tab=%s", _mask_config_value(sheet_id), sheet_title)
            sheets_api.values().append(
                spreadsheetId=sheet_id,
                range=f"{quoted_title}!A2",
                valueInputOption="USER_ENTERED",
                insertDataOption="INSERT_ROWS",
                body={"values": [row_values]},
            ).execute()
            action = "appended"

        _clear_notification_caches()
        return {
            "ok": True,
            "action": action,
            "item": _normalize_notification_manager_item({
                **normalized,
                "UpdatedAt": row_values[-1],
            }),
            "sheetTitle": sheet_title,
            "sheetId": sheet_id,
            "source": "master",
        }
    except HttpError as exc:
        message = _google_sheet_error_message(exc)
        if "PERMISSION_DENIED" in message or "The caller does not have permission" in message:
            return {
                "ok": False,
                "failedOperation": current_operation,
                "serviceAccountEmail": client_email,
                "sheetId": sheet_id,
                "error": (
                    "Google Sheets rejected the write request. Confirm the service account JSON is valid, "
                    "the Google Sheets API is enabled, and the spreadsheet is shared with the service account email. "
                    f"Failed operation: {current_operation}. Google error: {message}"
                ),
            }
        return {"ok": False, "failedOperation": current_operation, "sheetId": sheet_id, "error": f"Google Sheets write failed during {current_operation}: {message}"}
    except Exception as exc:
        logger.exception("[NOTIFICATIONS] Failed to write notification to Google Sheets: %s", exc)
        return {"ok": False, "failedOperation": current_operation, "sheetId": sheet_id, "error": f"Google Sheets write failed during {current_operation}: {exc}"}


def _delete_notification_from_google_sheet(notification_id):
    target_id = _normalize_notification_text(notification_id)
    if not target_id:
        return {"ok": False, "error": "Notification ID is required."}

    context = _sam_master_sheet_context()
    if not context.get("ok"):
        return {"ok": False, "error": context.get("error") or "SAM master Google Sheet is not configured."}

    apps_script_client = context.get("appsScriptClient")
    if apps_script_client:
        try:
            result = apps_script_client.post("deleteNotification", {"id": target_id})
            _clear_notification_caches()
            return {
                "ok": True,
                "action": "deleted",
                "id": target_id,
                "sheetTitle": SAM_NOTIFICATIONS_TAB,
                "sheetId": context.get("sheet_id") or "",
                "source": "apps-script",
                **(result if isinstance(result, dict) else {}),
            }
        except Exception as exc:
            logger.exception("[NOTIFICATIONS] Apps Script notification delete failed: %s", exc)
            return {"ok": False, "error": f"Apps Script notification delete failed: {exc}"}

    sheet_id = context["sheet_id"]
    service = context["service"]

    try:
        sheets_api = service.spreadsheets()
        tab_status = _ensure_sam_notifications_sheet(sheets_api, sheet_id)
        if not tab_status.get("ok"):
            return {"ok": False, "error": tab_status.get("error") or "Unable to verify sam-notifications tab."}

        sheet_title = SAM_NOTIFICATIONS_TAB
        sheet_gid = tab_status.get("sheetId")
        quoted_title = _quote_sheet_title_for_a1(sheet_title)
        last_column = _column_letter(len(NOTIFICATION_SHEET_COLUMNS))
        raw_values = sheets_api.values().get(
            spreadsheetId=sheet_id,
            range=f"{quoted_title}!A2:{last_column}",
        ).execute().get("values", [])

        target_row_number = None
        for row_index, row in enumerate(raw_values, start=2):
            existing_id = _normalize_notification_text(row[1] if len(row) > 1 else "")
            if existing_id == target_id:
                target_row_number = row_index
                break

        if target_row_number is None:
            return {"ok": False, "error": "Notification was not found in the configured Google Sheet."}

        sheets_api.batchUpdate(
            spreadsheetId=sheet_id,
            body={
                "requests": [
                    {
                        "deleteDimension": {
                            "range": {
                                "sheetId": sheet_gid,
                                "dimension": "ROWS",
                                "startIndex": target_row_number - 1,
                                "endIndex": target_row_number,
                            },
                        },
                    },
                ],
            },
        ).execute()

        _clear_notification_caches()
        return {"ok": True, "action": "deleted", "id": target_id, "sheetTitle": sheet_title, "sheetId": sheet_id, "source": "master"}
    except Exception as exc:
        logger.exception("[NOTIFICATIONS] Failed to delete notification from Google Sheets: %s", exc)
        return {"ok": False, "error": f"Google Sheets delete failed: {exc}"}


def _resolve_notification_sheet_url(value):
    raw = _normalize_notification_text(value)
    if not raw:
        return ""

    doc_id = _extract_google_sheet_id(raw)
    if doc_id and "docs.google.com/spreadsheets" in raw:
        gid = _extract_google_sheet_gid(raw) or "0"
        return f"https://docs.google.com/spreadsheets/d/{doc_id}/export?format=csv&gid={gid}"

    return raw


def _get_admin_notification_sheet_url():
    return _get_admin_notification_sheet_config()["export_url"]


def _notification_is_active(start_date, end_date):
    current = _notification_now_local()
    if start_date and current < start_date:
        return False
    if end_date and current > end_date:
        return False
    return True


def _parse_notification_csv(csv_text):
    groups = {"tickerMessages": [], "banners": [], "popups": []}

    for item in _parse_notification_items(csv_text):
        if not item["Enabled"]:
            continue
        if item["Type"] not in {"info", "warning", "urgent"}:
            continue
        if not item["Message"]:
            continue

        start_date = _combine_notification_datetime(
            item["StartDate"],
            item["StartTime"],
            (0, 0, 0),
        ) if item["StartDate"] else None
        end_default_time = (0, 0, 0)
        end_date = _combine_notification_datetime(
            item["EndDate"],
            item["EndTime"],
            end_default_time,
        ) if item["EndDate"] else None

        if item["StartDate"] and not start_date:
            logger.warning("[NOTIFICATIONS] Skipping row with invalid start date/time for message: %s", item["Message"])
            start_date = None
        if item["EndDate"] and not end_date:
            logger.warning("[NOTIFICATIONS] Skipping row with invalid end date/time for message: %s", item["Message"])
            continue
        if start_date and end_date and start_date > end_date:
            logger.warning("[NOTIFICATIONS] Skipping row with inverted active window for message: %s", item["Message"])
            continue
        if not _notification_is_active(start_date, end_date):
            continue

        item = {
            "id": item["ID"],
            "type": item["Type"],
            "title": item["Title"],
            "message": item["Message"],
            "showTicker": item["ShowTicker"],
            "showPopup": item["ShowPopup"],
            "showBanner": item["ShowBanner"],
            "persistent": item["Persistent"],
            "startTime": item["StartTime"],
            "endTime": item["EndTime"],
            "actionText": item["ActionText"] if item["ActionURL"] else "",
            "actionURL": item["ActionURL"],
        }

        if item["showTicker"]:
            groups["tickerMessages"].append(item)
        if item["showBanner"]:
            groups["banners"].append(item)
        if item["showPopup"]:
            groups["popups"].append(item)

    return groups


async def _fetch_notifications_from_sheet():
    import asyncio
    import time

    now = time.time()
    master_sheet_id = _shared_tracking_sheet_id()
    master_cache_key = f"master:{master_sheet_id}:{SAM_NOTIFICATIONS_TAB}"
    if (
        _notification_cache["groups"] is not None
        and _notification_cache["url"] == master_cache_key
        and (now - _notification_cache["last_fetch"]) < NOTIFICATION_CACHE_TTL_SECONDS
    ):
        logger.info(
            "[NOTIFICATIONS] Source=CACHE valid_ticker_rows=%s",
            len(_notification_cache["groups"].get("tickerMessages", [])),
        )
        return _notification_cache["groups"]

    authenticated = {"ok": False, "items": [], "error": "Notification fetch was not attempted."}
    try:
        authenticated = await asyncio.wait_for(
            asyncio.to_thread(_load_notification_items_from_google_sheets_api),
            timeout=NOTIFICATION_REMOTE_FETCH_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        reason = f"authenticated notification fetch timed out after {NOTIFICATION_REMOTE_FETCH_TIMEOUT_SECONDS}s"
        logger.warning("[NOTIFICATIONS] Source=TIMEOUT %s. Using cached/default notifications.", reason)
        _set_ticker_fetch_status("timeout", reason, 0)
        if _notification_cache["groups"] is not None:
            logger.info("[NOTIFICATIONS] Source=CACHE returning cached notifications after timeout.")
            return _notification_cache["groups"]
        return _notification_defaults
    except Exception as exc:
        logger.warning("[NOTIFICATIONS] Authenticated notification fetch failed before fallback: %s", exc)
        authenticated = {"ok": False, "items": [], "error": str(exc)}

    # If the authenticated fetch was attempted but failed with a non-fallback error, raise immediately
    if not authenticated.get("ok") and authenticated.get("errorCode") in {
        "role_mismatch", "invalid", "config_invalid", "unauthorized", "action_failure", "timeout", "remote_unavailable", "malformed_response"
    }:
        err_code = authenticated["errorCode"]
        _set_ticker_fetch_status("error", authenticated.get("error") or "Authenticated fetch failed", 0)
        from fastapi import HTTPException
        status_code = 500
        if err_code == "unauthorized":
            status_code = 401
        elif err_code == "forbidden":
            status_code = 403
        elif err_code == "timeout":
            status_code = 504
        elif err_code == "remote_unavailable":
            status_code = 503
        elif err_code in {"role_mismatch", "invalid", "config_invalid"}:
            status_code = 400
        elif err_code == "action_failure":
            status_code = 502
        elif err_code == "malformed_response":
            status_code = 502
        raise HTTPException(status_code=status_code, detail=authenticated.get("error") or "Authenticated Google Sheets read failed.")

    if authenticated.get("ok") and authenticated.get("source") == "master":
        groups = _group_notification_manager_items(authenticated.get("items", []))
        _notification_cache["groups"] = groups
        _notification_cache["last_fetch"] = now
        _notification_cache["url"] = master_cache_key
        logger.info(
            "[NOTIFICATIONS] Source=MASTER loaded %s ticker, %s banner, %s popup items from %s tab",
            len(groups["tickerMessages"]),
            len(groups["banners"]),
            len(groups["popups"]),
            SAM_NOTIFICATIONS_TAB,
        )
        _set_ticker_fetch_status("google", "master sam-notifications authenticated read succeeded", len(groups["tickerMessages"]))
        return groups

    config = _get_admin_notification_sheet_config()
    sheet_url = config["export_url"]
    logger.info(
        "[NOTIFICATIONS] Legacy ticker sheet config source=%s tab_gid=%s sheet_id=%s export_url_present=%s",
        config.get("source") or "unknown",
        config.get("gid") or "0",
        _mask_config_value(config.get("sheet_id")),
        bool(sheet_url),
    )
    if not sheet_url:
        logger.warning("[NOTIFICATIONS] No admin notification sheet URL is configured. Using cached/default notifications.")
        _set_ticker_fetch_status("fallback", "missing notification sheet URL", 0)
        if _notification_cache["groups"] is not None:
            logger.info("[NOTIFICATIONS] Source=CACHE returning cached notifications because sheet URL is missing.")
            return _notification_cache["groups"]
        return _notification_defaults

    if (
        _notification_cache["groups"] is not None
        and _notification_cache["url"] == sheet_url
        and (now - _notification_cache["last_fetch"]) < NOTIFICATION_CACHE_TTL_SECONDS
    ):
        logger.info(
            "[NOTIFICATIONS] Source=CACHE valid_ticker_rows=%s",
            len(_notification_cache["groups"].get("tickerMessages", [])),
        )
        return _notification_cache["groups"]

    try:
        logger.info(
            "[NOTIFICATIONS] Loading legacy notification sheet from %s URL %s",
            config.get("source") or "unknown",
            _mask_config_value(config.get("url")),
        )
        if authenticated.get("ok"):
            if authenticated.get("source") == "legacy_fallback":
                groups = _group_notification_manager_items(authenticated.get("items", []))
                _notification_cache["groups"] = groups
                _notification_cache["last_fetch"] = now
                _notification_cache["url"] = sheet_url
                logger.info(
                    "[NOTIFICATIONS] Source=LEGACY loaded %s ticker, %s banner, %s popup items from fallback notification sheet via authenticated Sheets API",
                    len(groups["tickerMessages"]),
                    len(groups["banners"]),
                    len(groups["popups"]),
                )
                _set_ticker_fetch_status("google", "legacy fallback authenticated Sheets API read succeeded", len(groups["tickerMessages"]))
                return groups
        else:
            logger.warning("[NOTIFICATIONS] %s", authenticated.get("error") or "Authenticated Google Sheets read failed.")

        async with httpx.AsyncClient(timeout=NOTIFICATION_REMOTE_FETCH_TIMEOUT_SECONDS) as client:
            resp = await client.get(sheet_url, follow_redirects=True)
            if resp.status_code == 200:
                content_type = (resp.headers.get("content-type") or "").lower()
                body_preview = (resp.text or "")[:512].lstrip().lower()
                looks_like_html = (
                    "text/html" in content_type
                    or body_preview.startswith("<!doctype html")
                    or body_preview.startswith("<html")
                )
                if looks_like_html:
                    creds_path = _resolve_notification_service_account_file()
                    reason = (
                        "public CSV request returned an HTML page (sheet is private and no Google service account is configured)"
                        if not creds_path
                        else "public CSV request returned an HTML page (sheet is private; service account is configured but authenticated read did not succeed)"
                    )
                    logger.warning(
                        "[NOTIFICATIONS] Source=FALLBACK %s. URL=%s",
                        reason,
                        _mask_config_value(sheet_url),
                    )
                    _set_ticker_fetch_status("fallback", reason, 0)
                else:
                    groups = _parse_notification_csv(resp.text)
                    _notification_cache["groups"] = groups
                    _notification_cache["last_fetch"] = now
                    _notification_cache["url"] = sheet_url
                    logger.info(
                        "[NOTIFICATIONS] Source=GOOGLE loaded %s ticker, %s banner, %s popup items from admin sheet public CSV tab gid=%s",
                        len(groups["tickerMessages"]),
                        len(groups["banners"]),
                        len(groups["popups"]),
                        config.get("gid") or "0",
                    )
                    _set_ticker_fetch_status("google", "public CSV read succeeded", len(groups["tickerMessages"]))
                    return groups
            else:
                reason = f"public CSV request returned status {resp.status_code}"
                logger.warning("[NOTIFICATIONS] Notification sheet request returned status %s. Using cached/default notifications.", resp.status_code)
                _set_ticker_fetch_status("fallback", reason, 0)
    except Exception as exc:
        logger.warning("[NOTIFICATIONS] Failed to fetch notification sheet: %s", exc)
        _set_ticker_fetch_status("fallback", f"Google notification fetch failed: {exc}", 0)

    if _notification_cache["groups"] is not None:
        logger.info("[NOTIFICATIONS] Source=CACHE reusing last cached notification payload after fetch failure.")
        _set_ticker_fetch_status("cache", "reusing cached notification payload after Google fetch failure", len(_notification_cache["groups"].get("tickerMessages", [])))
        return _notification_cache["groups"]
    logger.info("[NOTIFICATIONS] Source=FALLBACK returning built-in notification defaults.")
    return _notification_defaults

@api_router.get("/ticker")
async def get_ticker():
    import time

    groups = await _fetch_notifications_from_sheet()
    messages = [
        (f"{item['title']}: {item['message']}" if item.get("title") else item.get("message") or "").strip()
        for item in groups.get("tickerMessages", [])
        if (item.get("message") or "").strip()
    ]

    fetch_status = _ticker_fetch_status.get("source") or "unknown"
    fetch_success = (fetch_status == "google")

    if fetch_success:
        _ticker_cache["messages"] = messages
        _ticker_cache["last_fetch"] = time.time()
        _ticker_cache["using_fallback"] = False
        return {
            "messages": messages,
            "source": fetch_status,
            "fallback": False,
        }

    if messages:
        _ticker_cache["messages"] = messages
        _ticker_cache["last_fetch"] = time.time()
        _ticker_cache["using_fallback"] = False
        if _ticker_fetch_status.get("source") != "google":
            _set_ticker_fetch_status(_ticker_fetch_status.get("source") or "cache", _ticker_fetch_status.get("status") or "ticker loaded from cached/local notifications", len(messages))
        return {
            "messages": messages,
            "source": fetch_status,
            "fallback": False,
        }

    logger.warning("[TICKER] No active ticker rows available from the admin sheet. Using built-in fallback ticker.")
    _ticker_cache["messages"] = TICKER_MESSAGES
    _ticker_cache["last_fetch"] = time.time()
    _ticker_cache["using_fallback"] = True
    previous_status = _ticker_fetch_status.get("status") or "Google ticker was not fetched"
    _set_ticker_fetch_status("fallback", f"{previous_status}; no active ticker rows; using built-in fallback", len(TICKER_MESSAGES))
    return {
        "messages": TICKER_MESSAGES,
        "source": "fallback",
        "fallback": True,
    }


@api_router.get("/notifications")
async def get_notifications():
    groups = await _fetch_notifications_from_sheet()
    result = {
        **groups,
        "source": _ticker_fetch_status.get("source") or "unknown",
        "fallback": (_ticker_fetch_status.get("source") or "unknown") not in {"google", "cache"},
    }
    _schedule_shadow_domains("notifications")
    return result


@api_router.get("/config-status")
async def get_config_status():
    import time

    config = _get_admin_notification_sheet_config()
    credentials_path = _resolve_notification_service_account_file()
    defaults_dir = _resolve_defaults_dir()
    cached_groups = _notification_cache["groups"] if isinstance(_notification_cache.get("groups"), dict) else {}
    active_ticker_count = len(cached_groups.get("tickerMessages") or [])
    displayed_ticker_count = len(_ticker_cache.get("messages") or [])
    notification_cache_age = (
        max(0, int(time.time() - _notification_cache["last_fetch"]))
        if _notification_cache.get("last_fetch")
        else None
    )

    settings_doc = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0}) or {}
    sections = {}
    for key in TRACKED_CONTENT_KEYS:
        info = _content_source_status.get(key) or {}
        customized = bool(settings_doc.get(_managed_custom_flag(key))) if key in DEFAULT_MANAGED_SETTINGS_KEYS else False
        if key in DEFAULT_SETTINGS and key in settings_doc and (key not in DEFAULT_MANAGED_SETTINGS_KEYS or customized):
            served_from = "sqlite"
            served_count = _content_count(settings_doc.get(key))
        else:
            served_from = "memory"
            served_count = info.get("count") or 0
        sections[key] = {
            "defaultsSource": info.get("source") or "builtin",
            "servedFrom": served_from,
            "count": served_count,
            "defaultsCount": info.get("count") or 0,
            "ok": bool(info.get("ok", True)),
            "detail": info.get("detail") or "",
            "customized": customized,
        }

    return {
        "configFileUsed": _safe_file_label(_runtime_config_status.get("path") or ""),
        "configFound": bool(_runtime_config_status.get("found")),
        "configError": _runtime_config_status.get("error") or "",
        "defaultsFileUsed": _safe_file_label(defaults_dir or _defaults_status.get("path") or ""),
        "defaultsFound": bool(defaults_dir or _defaults_status.get("found")),
        "tickerSheetUrlSource": config.get("source") or "",
        "tickerSheetConfigured": bool(config.get("configured")),
        "tickerSheetUsingDefault": bool(config.get("using_default")),
        "tickerSheetUrlPresent": bool(config.get("url")),
        "tickerSheetUrlMasked": _mask_config_value(config.get("url")),
        "tickerSheetExportUrlPresent": bool(config.get("export_url")),
        "tickerSheetId": _mask_config_value(config.get("sheet_id")),
        "samNotificationSource": "master sam-notifications",
        "samNotificationSheetId": _mask_config_value(_shared_tracking_sheet_id()),
        "samNotificationTab": SAM_NOTIFICATIONS_TAB,
        "legacyNotificationSheetConfigured": bool(config.get("configured")),
        "googleCredentialsFound": bool(credentials_path),
        "googleCredentialsFile": _safe_file_label(credentials_path),
        "tickerSource": _ticker_fetch_status.get("source") or "builtin",
        "lastTickerFetchStatus": _ticker_fetch_status.get("status") or "",
        "lastTickerFetchTimestamp": _ticker_fetch_status.get("timestamp") or "",
        "activeTickerMessages": active_ticker_count,
        "displayedTickerMessages": displayed_ticker_count,
        "tickerFallbackInUse": bool(_ticker_cache.get("using_fallback")),
        "notificationCacheAgeSeconds": notification_cache_age,
        "notificationCacheTtlSeconds": NOTIFICATION_CACHE_TTL_SECONDS,
        "sections": sections,
    }


@api_router.get("/admin/runtime-diagnostics")
async def get_admin_runtime_diagnostics(request: Request):
    _require_admin_token(request)
    return _runtime_diagnostics_payload()


@api_router.get("/notifications/manage")
async def get_notifications_manage(request: Request):
    _require_admin_token(request)
    master_context = await asyncio.to_thread(_sam_master_sheet_context)
    authenticated = {"ok": False, "items": [], "error": master_context.get("error") or "SAM master Google Sheet is not configured."}
    if master_context.get("ok"):
        try:
            if master_context.get("appsScriptClient"):
                authenticated = await asyncio.to_thread(
                    _read_sam_notification_items_via_apps_script,
                    master_context["appsScriptClient"],
                    master_context.get("sheet_id") or "",
                )
            else:
                authenticated = await asyncio.to_thread(_read_sam_notification_items, master_context["service"].spreadsheets(), master_context["sheet_id"])
        except Exception as exc:
            logger.exception("[NOTIFICATIONS] Failed to read master sam-notifications for SAM manager: %s", exc)
            authenticated = {"ok": False, "items": [], "error": f"Unable to read master sam-notifications tab: {exc}"}

    if authenticated.get("ok"):
        result = {
            "ok": True,
            "items": authenticated.get("items", []),
            "sheet": {
                "configured": True,
                "url": DEFAULT_ADMIN_CONTENT_SHEET_URL,
                "sheetId": authenticated.get("sheetId") or _shared_tracking_sheet_id(),
                "gid": "",
                "sheetTitle": authenticated.get("sheetTitle") or SAM_NOTIFICATIONS_TAB,
                "source": "master",
            },
            "write": {
                "ready": True,
                "error": "",
            },
        }
        _schedule_shadow_domains("notifications")
        return result

    result = {
        "ok": False,
        "items": _default_managed_notifications,
        "error": "Remote content could not be loaded. Fallback content is being used.",
        "sheet": {
            "configured": bool(master_context.get("ok")),
            "url": DEFAULT_ADMIN_CONTENT_SHEET_URL,
            "sheetId": master_context.get("sheet_id") or _shared_tracking_sheet_id(),
            "gid": "",
            "sheetTitle": SAM_NOTIFICATIONS_TAB,
            "source": "master",
        },
        "write": {
            "ready": False,
            "error": authenticated.get("error") or "Notification writes require the master sam-notifications tab.",
        },
    }
    _schedule_shadow_domains("notifications")
    return result


@api_router.post("/notifications/manage")
async def save_notification_manage(payload: dict, request: Request):
    _require_admin_token(request)
    item_payload = (payload or {}).get("item") or payload or {}
    auth_result, _ = await asyncio.to_thread(
        get_dual_write_manager().execute_dual_write,
        domain="notifications",
        mutation_type="update" if item_payload.get("ID") else "insert",
        authoritative_payload=item_payload,
        authoritative_write_fn=lambda: _save_notification_to_google_sheet(item_payload),
        actor=str(request.headers.get("x-sam-user") or "admin"),
    )
    return auth_result


@api_router.delete("/notifications/manage/{notification_id:path}")
async def delete_notification_manage(notification_id: str, request: Request):
    _require_admin_token(request)
    auth_result, _ = await asyncio.to_thread(
        get_dual_write_manager().execute_dual_write,
        domain="notifications",
        mutation_type="delete",
        authoritative_payload={"ID": notification_id},
        authoritative_write_fn=lambda: _delete_notification_from_google_sheet(notification_id),
        actor=str(request.headers.get("x-sam-user") or "admin"),
    )
    return auth_result


async def _fetch_approved_headsets(force=False):
    import time

    now = time.time()
    if not force and _headset_cache["groups"] and (now - _headset_cache["last_fetch"]) < 300:
        return _headset_cache["groups"], _headset_cache.get("denied") or [], ""

    if force:
        refreshed = await asyncio.to_thread(_refresh_managed_content_sections, ("approved_headsets",))
        if refreshed and _headset_cache.get("groups"):
            return _headset_cache["groups"], _headset_cache.get("denied") or [], ""
        if _headset_cache.get("groups"):
            return (
                _headset_cache["groups"],
                _headset_cache.get("denied") or [],
                "Approved headset refresh is temporarily delayed. Showing the last available list.",
            )

    sheet_groups = EXTERNAL_CONTENT.get("approved_headsets")
    denied = EXTERNAL_CONTENT.get("denied_headsets") or []
    if isinstance(sheet_groups, list) and sheet_groups:
        _headset_cache["groups"] = sheet_groups
        _headset_cache["denied"] = denied
        _headset_cache["last_fetch"] = now
        return sheet_groups, denied, ""
    cached_groups = _headset_cache["groups"] or []
    if cached_groups:
        return cached_groups, _headset_cache.get("denied") or [], "Approved headset refresh is temporarily delayed. Showing the last available list."
    return [], _headset_cache.get("denied") or [], "Unable to load the approved headset list right now."


def _resolve_screenshot_path(filename: str) -> Path:
    # Strip any leading slashes or directories from filename to get just the base name
    base_filename = os.path.basename(filename)
    
    candidates = []
    
    # 1. APP_RESOURCES_PATH env var
    resources_root = (os.getenv("APP_RESOURCES_PATH") or "").strip()
    if resources_root:
        candidates.append(Path(resources_root) / "frontend" / base_filename)
        candidates.append(Path(resources_root) / "assets" / base_filename)
        candidates.append(Path(resources_root) / "backend" / "defaults" / base_filename)
        
    # 2. Packaged frozen runtime
    if getattr(sys, "frozen", False):
        exe_dir = Path(sys.executable).resolve().parent
        # sibling to backend: resources/frontend
        candidates.append(exe_dir.parent / "frontend" / base_filename)
        candidates.append(exe_dir.parent / "assets" / base_filename)
        candidates.append(exe_dir / "defaults" / base_filename)
        # in case packaged directly next to exe
        candidates.append(exe_dir / "frontend" / base_filename)
        candidates.append(exe_dir / "assets" / base_filename)
        
    # 3. Development mode fallback
    candidates.append(ROOT_DIR.parent / "frontend" / "public" / base_filename)
    candidates.append(ROOT_DIR.parent / "desktop" / "assets" / base_filename)
    candidates.append(ROOT_DIR / "defaults" / base_filename)
    candidates.append(ROOT_DIR / "defaults" / "screenshots" / base_filename)
    
    # Check all candidates and return the first one that exists
    for candidate in candidates:
        if candidate.exists() and candidate.is_file():
            return candidate.resolve()
            
    # If not found, return the first one as a fallback path
    return candidates[0]


@api_router.get("/screenshot-assets/{filename}")
async def get_screenshot_asset(filename: str):
    resolved_path = _resolve_screenshot_path(filename)
    exists = resolved_path.exists() and resolved_path.is_file()
    logger.debug("[SCREENSHOT] Asset lookup filename=%s exists=%s", filename, exists)
    
    if not exists:
        logger.error("[SCREENSHOT] File not found: %s (tried: %s)", filename, str(resolved_path))
        raise HTTPException(status_code=404, detail=f"Screenshot file '{filename}' not found.")
        
    from fastapi.responses import FileResponse
    return FileResponse(resolved_path, media_type="image/png")


@api_router.get("/headsets")
async def get_approved_headsets(force: bool = False):
    groups, denied, error = await _fetch_approved_headsets(force=force)
    result = {"groups": groups, "denied": denied, "error": error}
    _schedule_shadow_domains("headset_catalog")
    return result


@api_router.post("/headsets/review-log")
async def log_headset_review(payload: dict):
    return _append_headset_review_log(payload or {})


@api_router.get("/headsets/reviews")
async def get_headset_reviews(request: Request):
    _require_admin_token(request)
    result = await asyncio.to_thread(_headset_review_snapshot)
    _schedule_shadow_domains("headset_reviews")
    return result


async def _propagate_headset_review_edit_to_local_records(result, payload):
    if not result.get("ok") or str((payload or {}).get("action") or "").lower() != "edit":
        return 0
    review_id = str(result.get("review_id") or (payload or {}).get("review_id") or "").strip()
    source_session_id = str(result.get("source_session_id") or "").strip()
    label = _headset_display_label(result.get("brand"), result.get("model"))
    if not label:
        return 0
    updated = 0
    rows = db.history.store.fetchall("SELECT id, data FROM history_documents ORDER BY id DESC")
    for row in rows:
        record = SQLiteCollection.decode(row["data"])
        identities = {
            str(record.get(key) or "").strip()
            for key in ("history_id", "session_id", "source_session_id", "resume_source_history_id")
            if str(record.get(key) or "").strip()
        }
        if not (
            (review_id and str(record.get("headset_review_id") or "").strip() == review_id)
            or (source_session_id and source_session_id in identities)
        ):
            continue
        record["headset_brand"] = label
        record["headset_review_id"] = review_id or record.get("headset_review_id") or ""
        record["headset_review_status"] = "pending"
        db.history.store.execute(
            "UPDATE history_documents SET data = ?, timestamp = ? WHERE id = ?",
            (SQLiteCollection.encode(record), str(record.get("timestamp_iso") or record.get("timestamp") or ""), row["id"]),
        )
        updated += 1
    active = await db.sessions.find_one({"_id": "active_session"})
    if active:
        identities = {str(active.get(key) or "").strip() for key in ("session_id", "source_session_id", "resume_source_history_id")}
        if (review_id and str(active.get("headset_review_id") or "").strip() == review_id) or (source_session_id and source_session_id in identities):
            await db.sessions.update_one({"_id": "active_session"}, {"$set": {
                "headset_brand": label,
                "headset_review_id": review_id or active.get("headset_review_id") or "",
                "headset_review_status": "pending",
            }})
            updated += 1
    return updated


@api_router.post("/headsets/reviews/action")
async def post_headset_review_action(payload: dict, request: Request):
    _require_admin_token(request)
    auth_payload = payload or {}
    auth_result, _ = await asyncio.to_thread(
        get_dual_write_manager().execute_dual_write,
        domain="headset_reviews",
        mutation_type="action",
        authoritative_payload=auth_payload,
        authoritative_write_fn=lambda: _headset_review_action(auth_payload),
        actor=str(request.headers.get("x-sam-user") or "admin"),
    )
    if isinstance(auth_result, dict):
        auth_result["local_records_updated"] = await _propagate_headset_review_edit_to_local_records(auth_result, auth_payload)
    return auth_result


# ══════════════════════════════════════════════════════════════════
# GEMINI / SUMMARIES
# ══════════════════════════════════════════════════════════════════
@api_router.post("/gemini/summaries")
async def gen_summaries(payload: dict):
    payload_session = payload.get("session") if isinstance(payload, dict) else None
    doc = payload_session if isinstance(payload_session, dict) else None
    if not doc:
        doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if not doc:
        return {
            "coaching": "No active session.",
            "fail": "No active session.",
            "used_gemini": False,
            "used_fallback": True,
            "gemini_enabled": False,
            "gemini_key_configured": False,
            "coaching_prompt_source": "builtin",
            "fail_prompt_source": "builtin",
            "gemini_error": "No active session.",
        }
    settings = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0})
    api_key = _get_stored_gemini_api_key(settings)
    result = generate_summaries(doc, api_key, settings)
    return result


@api_router.post("/gemini/regenerate")
async def regen_summary(payload: dict):
    summary_type = payload.get("type", "coaching")
    instructions = payload.get("instructions", "")
    current_summary = payload.get("current_summary", "")
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if not doc:
        return {"ok": False, "error": "No active session"}
    settings = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0})
    api_key = _get_stored_gemini_api_key(settings)
    result = generate_summaries(doc, api_key, settings, instructions=instructions, current_summary=current_summary, summary_type=summary_type)
    if result.get("error"):
        return {"ok": False, "error": result["error"], "text": result.get(summary_type, ""), **result}
    return {"ok": True, "text": result.get(summary_type, ""), **result}


@api_router.post("/test-gemini")
async def test_gemini_connection():
    settings = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0})
    api_key = _get_stored_gemini_api_key(settings)
    return test_gemini_connection_with_timeout(api_key)


# ══════════════════════════════════════════════════════════════════
# FINISH SESSION (orchestrator)
# ══════════════════════════════════════════════════════════════════
@api_router.post("/finish-session")
async def finish_all(payload: dict, request: Request):
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if not doc:
        return {"ok": False, "error": "No active session"}
    doc = _session_with_workflow_defaults(doc)
    if doc.get("form_fill_status") == FORM_FILL_NOT_ATTEMPTED:
        doc["form_fill_status"] = FORM_FILL_SKIPPED
    final_status = compute_final_status(doc)
    timestamp_fields = _format_local_history_timestamp(datetime.now(timezone.utc))
    record = {
        **doc,
        **timestamp_fields,
        "candidate": doc.get("candidate_name", "Unknown"),
        "tester_name": doc.get("tester_name", ""),
        "final_status": final_status,
        "status": final_status,
        "coaching_summary": payload.get("coaching_summary", ""),
        "fail_summary": payload.get("fail_summary", ""),
        "history_id": doc.get("history_id") or doc.get("resume_source_history_id") or str(uuid.uuid4()),
    }

    # Remove finalEvaluatorNotes / evaluatorNotesSummaryEdited if user opted out of saving to History
    notes = record.get("finalEvaluatorNotes") or {}
    if not notes.get("saveToHistory", True):
        record.pop("finalEvaluatorNotes", None)
        record.pop("evaluatorNotesSummaryEdited", None)

    _saved_record, action = await _upsert_history_record(record, doc)
    shared_result = _sync_shared_candidate_tracking(_saved_record)
    await db.sessions.delete_one({"_id": "active_session"})
    db.backup("after-finish-session")
    message = "Resumed session updated successfully!" if action == "updated" else "Session saved successfully!"
    if not shared_result.get("ok"):
        message = f"{message} Session saved locally, but shared Google Sheet update failed."
    return {"ok": True, "message": message, "action": action, "sharedTracking": shared_result}


# ══════════════════════════════════════════════════════════════════
# UPDATE / FORM (stubs)
# ══════════════════════════════════════════════════════════════════
@api_router.get("/update")
async def check_update(app: str = "mts"):
    return _get_update_metadata(app)


@api_router.get("/update/status")
async def update_status():
    return {"update_available": False, "current_version": APP_VERSION}


@api_router.post("/form/fill")
async def fill_form(payload: dict, request: Request):
    session = payload.get("session") if isinstance(payload, dict) else None
    if not session:
        session = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if not session:
        return {"ok": False, "message": "No active session was found to send to the Cert Form."}

    settings = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0}) or {}
    form_url = (settings.get("form_url") or DEFAULT_FORM_URL or "").strip()
    if not form_url:
        return {"ok": False, "message": "No Cert Form URL is configured in Settings."}
    form_url_ok, form_url_error = _validate_microsoft_form_url(form_url)
    if not form_url_ok:
        return {"ok": False, "message": form_url_error}

    form_payload = build_form_fill_payload(
        session,
        settings,
        payload.get("coaching", ""),
        payload.get("fail_reason", ""),
    )
    result = fill_cert_form(form_url, form_payload, settings.get("form_fill_browser", "auto"))
    if result.get("ok"):
        status_result = await _safe_record_form_fill_status(session, FORM_FILL_FILLED)
        response = {
            **result,
            "ok": True,
            "automation_completed": True,
            "form_filled": True,
            "local_status_saved": bool(status_result.get("ok")),
            "shared_status_saved": None,
            "status_update": status_result.get("update") or {},
            "error_code": "" if status_result.get("ok") else "metadata_status_save_failed",
        }
        if not status_result.get("ok"):
            response["warning"] = (
                "The Microsoft Form was filled, but MTS could not update the session status. "
                "Do not run Form Fill again. Refresh or update the status manually if needed."
            )
            response["message"] = response["warning"]
        return response

    error_message = result.get("message") or result.get("error") or "Form fill failed."
    status_result = await _safe_record_form_fill_status(session, FORM_FILL_FAILED, error_message)
    return {
        **result,
        "ok": False,
        "automation_completed": False,
        "form_filled": False,
        "local_status_saved": bool(status_result.get("ok")),
        "shared_status_saved": None,
        "status_update": status_result.get("update") or {},
        "error_code": result.get("error_code") or "form_automation_failed",
        "message": error_message,
    }


@api_router.get("/")
async def root():
    return {"message": f"Mock Testing Suite API v{APP_VERSION}"}


@api_router.get("/health")
async def health():
    return {"ok": True, "version": APP_VERSION}


@api_router.get("/runtime/verify-token")
async def verify_runtime_token(request: Request):
    _require_admin_token(request)
    return {"ok": True, "version": APP_VERSION}


@api_router.get("/driver-diagnostics")
async def driver_diagnostics_route():
    try:
        from services.form_filler import driver_diagnostics as _diag
        return {"ok": True, "diagnostics": _diag()}
    except Exception as exc:
        logger.exception("Driver diagnostics failed: %s", exc)
        return {"ok": False, "message": str(exc)}


app.include_router(api_router)

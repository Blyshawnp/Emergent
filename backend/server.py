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
import time
import uuid
import secrets
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager
from functools import lru_cache
from zoneinfo import ZoneInfo
from urllib.parse import quote, urlparse
from urllib.request import urlopen

import httpx
from fastapi import FastAPI, APIRouter, HTTPException, Request
import asyncio
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel
from services.form_filler import fill_form as fill_cert_form

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)
logger.info("[STARTUP] backend process start")

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
            conn.execute("PRAGMA integrity_check")
            return conn
        except sqlite3.DatabaseError as exc:
            self._backup_corrupt_database(exc)
            try:
                self.path.unlink(missing_ok=True)
            except Exception as unlink_exc:
                logger.error("[STARTUP] Failed to remove unreadable SQLite database %s: %s", self.path, unlink_exc)
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
    "path": "",
    "client_email": "",
    "private_key_id": "",
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
    "help_markdown",
    "faq_markdown",
    "admin_setup_markdown",
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
        "path": str(path or ""),
        "client_email": "",
        "private_key_id": "",
        "error": "",
    }
    if not path:
        return info
    try:
        resolved = Path(path).expanduser()
        info["path"] = str(resolved)
        info["exists"] = resolved.is_file()
        if not info["exists"]:
            return info
        with resolved.open("r", encoding="utf-8") as f:
            data = json.load(f)
        info["client_email"] = str(data.get("client_email") or "")
        info["private_key_id"] = str(data.get("private_key_id") or "")
    except Exception as exc:
        info["error"] = str(exc)
    return info


def _record_google_sheet_auth_status(status, *, ok=False, path=None, tab_name="", error=""):
    public_info = _read_service_account_public_info(path) if path else {}
    _google_sheet_auth_status.update({
        "ok": bool(ok),
        "status": str(status or ""),
        "path": str(path or public_info.get("path") or ""),
        "client_email": public_info.get("client_email") or _google_sheet_auth_status.get("client_email") or "",
        "private_key_id": public_info.get("private_key_id") or _google_sheet_auth_status.get("private_key_id") or "",
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
}


def _managed_custom_flag(key):
    return f"{key}_customized"


def _fail_reason_fallback(section_key):
    if section_key == "call_fails":
        return list(CALL_FAILS)
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
        return fallback

    if _rows_have_headset_shape(rows):
        logger.warning(
            "[CONTENT] %s has headset-like columns and was rejected for %s. Using %s fail reasons.",
            source_label,
            section_key,
            fallback_label,
        )
        return fallback

    if _rows_have_coaching_shape(rows):
        logger.warning(
            "[CONTENT] %s has coaching-only columns and was rejected for %s. Using %s fail reasons.",
            source_label,
            section_key,
            fallback_label,
        )
        return fallback

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
        return fallback
    if _values_match_other_section(items, section_key):
        logger.warning(
            "[CONTENT] %s produced values from the wrong fail-reason section for %s. Using %s fail reasons.",
            source_label,
            section_key,
            fallback_label,
        )
        return fallback

    return items


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
    if not title_header or not message_header:
        logger.warning("[CONTENT] Discord posts rows require Title and Message columns.")
        return []

    items = []
    for row in rows:
        row = row or {}
        category = str(row.get(category_header) or "").strip() if category_header else ""
        category = category or DEFAULT_CONTENT_CATEGORY
        title = str(row.get(title_header) or "").strip()
        message = str(row.get(message_header) or "")
        if title:
            items.append({"category": category, "title": title, "message": message})
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


def _normalize_approved_headsets(rows):
    grouped = {}
    order = []
    ignored_brands = {"source note", "source url", "example"}

    for row in rows:
        row = row or {}
        brand = str(row.get("Brand") or "").strip()
        model = str(row.get("Model") or "").strip()
        if not brand or brand.lower() in ignored_brands or not model:
            continue
        if brand not in grouped:
            grouped[brand] = []
            order.append(brand)
        if model not in grouped[brand]:
            grouped[brand].append(model)
    return [{"brand": brand, "models": grouped[brand]} for brand in order if grouped[brand]]


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
        "approved_headsets": lambda: _normalize_approved_headsets(read_csv_file(DEFAULTS_FILE_MAP["approved_headsets"]) or []),
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

    return loaded


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
    "approved_headsets": lambda csv_text: {"approved_headsets": _normalize_approved_headsets(_read_csv_rows(csv_text))},
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
    return loaded

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
            loaded[content_key] = normalized
            logger.info(
                "[CONTENT] Loaded %d FAQ entries from Google Doc",
                question_count,
            )
        else:
            loaded[content_key] = text
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
        try:
            local_content = _load_local_defaults_content()
        except Exception as exc:
            logger.warning("[CONTENT] Local defaults load failed in background task: %s", exc)
            local_content = {}

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

        if sheet_content.get("discord_screenshots") and local_content.get("discord_screenshots"):
            existing = {
                (
                    str(item.get("title") or "").strip().lower(),
                    str(item.get("image_url") or "").strip().lower(),
                )
                for item in sheet_content.get("discord_screenshots") or []
            }
            additions = [
                item for item in local_content.get("discord_screenshots") or []
                if (
                    str(item.get("title") or "").strip().lower(),
                    str(item.get("image_url") or "").strip().lower(),
                ) not in existing
            ]
            if additions:
                sheet_content["discord_screenshots"] = [*sheet_content["discord_screenshots"], *additions]
                logger.info(
                    "[CONTENT] Added %d packaged screenshot default(s) not present in Google Sheet",
                    len(additions),
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
            CALL_FAILS = EXTERNAL_CONTENT["call_fails"]
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
                "[STARTUP] Master shared sheet setup verified. spreadsheet=%s service_account=%s",
                _mask_config_value(shared_sheet_status.get("spreadsheetId")),
                shared_sheet_status.get("serviceAccountEmail") or "unknown",
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
    ["Sam", "Smith", "400 N Broad St", "Philadelphia", "PA", "19103", "215-515-1212", "ssmith@test.com"],
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
    f"Welcome to Mock Testing Suite v{APP_VERSION}",
    "Tip: Use the Discord Post button to quickly copy common messages",
    "Need help? Check the Help tab for step-by-step setup guides",
]

DEFAULT_FORM_URL = "https://forms.office.com/pages/responsepage.aspx?id=3KFHNUeYz0mR2noZwaJeQnNAxP4sz6FBkEyNHMuYWT1URDZKWk1RWDU2VjRLTEZKNUxCWU1RRFlUVS4u&route=shorturl"

DISCORD_SCREENSHOTS = [
    {"title": "Welcome New Agent", "image_url": "/welcome-new-agent.png"},
    {"title": "Welcome to Stars", "image_url": "/welcome-to-stars.png"},
]

CALL_COACHING = [
    {"id": "c-show-app", "label": "Show appreciation", "children": ["For Current/Existing Donors", "After donation amount is given"]},
    {"id": "c-dontask", "label": "Don't Ask, Just Verify Address and Phone Number", "helper": "Existing member already provided address and phone number"},
    {"id": "c-verify", "label": "Verification", "children": ["Name", "Address", "Phone", "Email", "Card/EFT", "Phonetics for Sound Alike Letters"]},
    {"id": "c-phonetics", "label": "Phonetics table provided to candidate"},
    {"id": "c-verbatim", "label": "Read script verbatim", "helper": "No adlibbing or skipping sections"},
    {"id": "c-nav", "label": "Use effective script navigation", "children": ["Scroll down to avoid missing parts of the script", "Use the Back and Next buttons and not the Icons"]},
    {"id": "c-search-name", "label": "Search name for every call", "helper": "Search the caller's name on every call to avoid duplicate member records."},
    {"id": "c-no-volunteer", "label": "Do not volunteer information", "helper": "Do not verify details the member has not provided, such as an email address."},
    {"id": "c-other", "label": "Other"},
]

CALL_FAILS = [
    "Skipped parts of script",
    "Volunteered info",
    "Wrong donation",
    "Background noise on call",
    "Paraphrased script",
    "Wrong thank you gift",
    "Script navigation issues",
    "Other",
]

SUP_COACHING = [
    {"label": "Minimize dead air", "helper": "Maintain engagement throughout hold and transfer"},
    {"label": "Queue Not Changed", "helper": "Did not change queue to ACD Direct Supervisor"},
    {"label": "Caller Placed On Hold"},
    {"label": "Verification", "children": ["Name", "Address", "Phone", "Email", "Card/EFT", "Phonetics for Sound Alike Letters"]},
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
    CALL_FAILS = EXTERNAL_CONTENT["call_fails"]

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
        "sysExecutable": sys.executable,
        "cwd": os.getcwd(),
        "backendRoot": str(ROOT_DIR),
        "appResourcesPath": resources_root,
        "packagedLogPath": PACKAGED_BACKEND_LOG_PATH,
        "runtimeConfig": {
            "candidates": [str(path) for path in _runtime_config_candidates()],
            "path": _runtime_config_status.get("path") or "",
            "exists": bool(_runtime_config_status.get("found")),
            "error": _runtime_config_status.get("error") or "",
        },
        "googleServiceAccount": {
            "candidates": [
                str(path)
                for path in [
                    Path((os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE") or "").strip()).expanduser()
                    if (os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE") or "").strip() else None,
                    Path(resources_root) / "backend" / "config" / "google-service-account.json" if resources_root else None,
                    Path(sys.executable).resolve().parent / "config" / "google-service-account.json" if getattr(sys, "frozen", False) else None,
                    ROOT_DIR / "config" / "google-service-account.json",
                ]
                if path
            ],
            "path": credential_info.get("path") or "",
            "exists": bool(credential_info.get("exists")),
            "client_email": credential_info.get("client_email") or "",
            "private_key_id": credential_info.get("private_key_id") or "",
            "error": credential_info.get("error") or "",
        },
        "spreadsheetId": master_spreadsheet_id,
        "spreadsheetIdMasked": _mask_config_value(master_spreadsheet_id),
        "notificationConfig": {
            "source": notification_config.get("source") or "",
            "configured": bool(notification_config.get("configured")),
            "sheetId": notification_config.get("sheet_id") or "",
            "sheetIdMasked": _mask_config_value(notification_config.get("sheet_id")),
            "gid": notification_config.get("gid") or "",
            "error": notification_config.get("error") or "",
        },
        "contentSourceSummary": _content_source_summary_payload(),
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
        "[RUNTIME] mode=%s sys.executable=%s cwd=%s backend_root=%s resources=%s packaged_log=%s",
        diagnostics.get("mode"),
        diagnostics.get("sysExecutable"),
        diagnostics.get("cwd"),
        diagnostics.get("backendRoot"),
        diagnostics.get("appResourcesPath"),
        diagnostics.get("packagedLogPath"),
    )
    logger.info(
        "[RUNTIME] runtime_config exists=%s path=%s spreadsheet=%s notification_source=%s notification_sheet=%s",
        runtime_config.get("exists"),
        runtime_config.get("path"),
        diagnostics.get("spreadsheetIdMasked"),
        notification.get("source"),
        notification.get("sheetIdMasked"),
    )
    logger.info(
        "[RUNTIME] google_service_account exists=%s path=%s client_email=%s private_key_id=%s",
        credential.get("exists"),
        credential.get("path"),
        credential.get("client_email") or "unknown",
        credential.get("private_key_id") or "unknown",
    )
    logger.info("[RUNTIME] content_source_summary=%s", compact_sources)
    return diagnostics


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
    "sup_fails": SUP_FAILS,
}

GEMINI_API_KEY_SETTING = "gemini_api_key"
LEGACY_GEMINI_API_KEY_SETTINGS = ("gemini_key",)
SENSITIVE_SETTINGS_KEYS = {GEMINI_API_KEY_SETTING}
ADMIN_ONLY_SETTINGS_KEYS = set()
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
        else:
            continue
        category = category or DEFAULT_CONTENT_CATEGORY
        if title:
            rows.append({"category": category, "title": title, "message": message})
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


def sanitize_settings(doc: Optional[dict]) -> dict:
    base = {key: value for key, value in DEFAULT_SETTINGS.items() if key not in ADMIN_ONLY_SETTINGS_KEYS}
    if doc:
        for key, value in doc.items():
            if key in ALLOWED_SETTINGS_KEYS or key in SENSITIVE_SETTINGS_KEYS:
                if key in DEFAULT_MANAGED_SETTINGS_KEYS and not doc.get(_managed_custom_flag(key)):
                    continue
                base[key] = _sanitize_content_setting(key, value, "saved")
    base["sound_volume"] = _normalize_sound_volume(base.get("sound_volume"), base.get("enable_sounds"))
    base["enable_sounds"] = base["sound_volume"] != "off"
    base["welcome_voice"] = _normalize_welcome_voice(base.get("welcome_voice"))
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
        if key in DEFAULT_MANAGED_SETTINGS_KEYS and _content_values_equal(value, DEFAULT_SETTINGS.get(key)):
            unset_defaults[key] = ""
            unset_defaults[_managed_custom_flag(key)] = ""
            continue
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
        "headset_usb": None,
        "headset_brand": "",
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
        "final_status": None,
        "last_saved": None,
        "tech_issues_log": [],
        "current_call_num": None,
        "current_call_draft": None,
        "current_sup_transfer_num": None,
        "current_sup_transfer_draft": None,
    }


SHARED_CANDIDATE_SESSIONS_TAB = "Candidate Sessions"
SHARED_PENDING_SUP_TRANSFERS_TAB = "Pending Sup Transfers"
SAM_AUTHORIZED_USERS_TAB = "sam-authorized-users"
SAM_NOTIFICATIONS_TAB = "sam-notifications"
HEADSET_REVIEW_LOG_TAB = "headset-review-log"

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
    "headset_model",
    "candidate_name",
    "tester_name",
    "entered_at",
    "review_status",
    "notes",
]

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
        HEADSET_REVIEW_LOG_TAB: HEADSET_REVIEW_LOG_HEADERS,
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
            **_update_sheet_required_setup(),
            **_sam_admin_required_setup(),
        },
    }

    logger.info(
        "[SHEETS] Verifying master shared sheet=%s with service_account=%s. Legacy notification sheet fallback=%s gid=%s.",
        _mask_config_value(sheet_id),
        service_account_email or "unknown",
        _mask_config_value(notification_config.get("sheet_id")),
        notification_config.get("gid") or "0",
    )

    if not service_result.get("ok"):
        result.update({"error": service_result.get("error"), "setup": service_result.get("setup") or result["setup"]})
        logger.error("[SHEETS] Master shared sheet verification failed before access: %s", service_result.get("error"))
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

    creds_path = _resolve_notification_service_account_file()
    service_account_email = _get_service_account_email()
    _record_google_sheet_auth_status("shared_service_resolved", ok=bool(creds_path), path=creds_path, error="" if creds_path else "No service account credentials found.")
    logger.info(
        "[SHARED] Master MTS content/candidate sheet config spreadsheet_id=%s service_account=%s credentials_path=%s",
        sheet_id or "",
        service_account_email or "unknown",
        creds_path or "",
    )
    if not creds_path:
        return {
            "ok": False,
            "error": "Google service account credentials are not configured, so shared candidate tracking cannot write to the master sheet.",
            "sheet_id": sheet_id,
            "serviceAccountEmail": service_account_email,
            "setup": _shared_tracking_manual_setup(sheet_id, service_account_email),
        }

    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except Exception as exc:
        return {"ok": False, "error": f"Google Sheets dependencies are unavailable: {exc}", "setup": _shared_tracking_manual_setup(sheet_id, service_account_email)}

    try:
        scopes = ["https://www.googleapis.com/auth/spreadsheets"]
        creds = service_account.Credentials.from_service_account_file(str(creds_path), scopes=scopes)
        service = build("sheets", "v4", credentials=creds, cache_discovery=False)
        _record_google_sheet_auth_status("shared_service_ok", ok=True, path=creds_path)
        return {"ok": True, "service": service, "sheet_id": sheet_id, "serviceAccountEmail": service_account_email}
    except Exception as exc:
        _record_google_sheet_auth_status("shared_service_failed", ok=False, path=creds_path, error=exc)
        return {"ok": False, "error": f"Unable to initialize Google Sheets credentials for shared tracking: {exc}", "setup": _shared_tracking_manual_setup(sheet_id, service_account_email)}


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
                    "[SHARED] Failed to create shared tracking tabs. reason=%s service_account=%s spreadsheet=%s missing_tabs=%s error=%s",
                    reason,
                    service_account_email or "unknown",
                    _mask_config_value(sheet_id),
                    missing_tabs,
                    exc,
                )
                return {
                    "ok": False,
                    "error": (
                        "Missing shared tracking tabs could not be created. "
                        f"Reason: {reason}. Service account requiring Editor access: {service_account_email or 'unknown'}."
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
            "[SHARED] Unable to verify shared tracking tabs. reason=%s service_account=%s spreadsheet=%s error=%s",
            reason,
            service_account_email or "unknown",
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


def _readiness_override_note(session):
    if not _readiness_override_applied(session):
        return ""
    judgment = _readiness_judgment(session)
    calculated = str(judgment.get("calculatedResult") or compute_calculated_status(session) or "").strip()
    final_result = str(judgment.get("overrideResult") or "").strip()
    reason = str(judgment.get("primaryReason") or "").strip()
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
    return f"{base}\n\n{note}" if base else note


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
            sheet_id,
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
        sheet_id,
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
        sheet_id,
        tab_name,
        row_number,
    )
    sheets_api.values().update(
        spreadsheetId=sheet_id,
        range=f"{quoted}!A{row_number}:{last_col}{row_number}",
        valueInputOption="USER_ENTERED",
        body={"values": [row_values]},
    ).execute()


def _normalize_headset_review_key(value):
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def _approved_headset_review_keys():
    keys = set()
    for group in EXTERNAL_CONTENT.get("approved_headsets") or []:
        brand = str((group or {}).get("brand") or "").strip()
        for model in (group or {}).get("models") or []:
            model_text = str(model or "").strip()
            label = f"{brand} {model_text}".strip()
            if label:
                keys.add(_normalize_headset_review_key(label))
            if model_text:
                keys.add(_normalize_headset_review_key(model_text))
    return keys


def _ensure_headset_review_log_tab(sheets_api, sheet_id):
    metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
    tabs = {
        ((sheet.get("properties") or {}).get("title") or ""): sheet
        for sheet in metadata.get("sheets", [])
    }
    return _verify_header_tab(
        sheets_api,
        sheet_id,
        HEADSET_REVIEW_LOG_TAB,
        HEADSET_REVIEW_LOG_HEADERS,
        "headset_review_log",
        tabs,
    )


def _append_headset_review_log(payload):
    headset_model = str((payload or {}).get("headset_model") or "").strip()
    normalized_model = _normalize_headset_review_key(headset_model)
    if not normalized_model:
        return {"ok": True, "skipped": True, "reason": "blank_headset"}
    if normalized_model in _approved_headset_review_keys():
        return {"ok": True, "skipped": True, "reason": "approved_headset"}

    try:
        context = _shared_sheet_context()
        if not context.get("ok"):
            logger.warning("[HEADSET-REVIEW] Unable to log headset review row: %s", context.get("error"))
            return {"ok": False, "skipped": True, "reason": "sheet_unavailable", "error": context.get("error") or ""}

        sheets_api = context["service"].spreadsheets()
        sheet_id = context["sheet_id"]
        status = _ensure_headset_review_log_tab(sheets_api, sheet_id)
        if not status.get("ok"):
            logger.warning("[HEADSET-REVIEW] Unable to verify %s tab: %s", HEADSET_REVIEW_LOG_TAB, status.get("error"))
            return {"ok": False, "skipped": True, "reason": "tab_unavailable", "error": status.get("error") or ""}

        rows = _shared_read_rows(sheets_api, sheet_id, HEADSET_REVIEW_LOG_TAB, HEADSET_REVIEW_LOG_HEADERS)
        for row in rows:
            existing_model = _normalize_headset_review_key(row.get("headset_model"))
            existing_status = str(row.get("review_status") or "").strip().lower()
            if existing_model == normalized_model and existing_status in {"", "pending"}:
                return {"ok": True, "skipped": True, "reason": "duplicate_pending"}

        quoted = _quote_sheet_title_for_a1(HEADSET_REVIEW_LOG_TAB)
        sheets_api.values().append(
            spreadsheetId=sheet_id,
            range=f"{quoted}!A2",
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": [[
                headset_model,
                str((payload or {}).get("candidate_name") or "").strip(),
                str((payload or {}).get("tester_name") or "").strip(),
                datetime.now(timezone.utc).isoformat(),
                "pending",
                "",
            ]]},
        ).execute()
        logger.info("[HEADSET-REVIEW] Logged unknown headset model for admin review: %s", headset_model)
        return {"ok": True, "logged": True}
    except Exception as exc:
        logger.warning("[HEADSET-REVIEW] Failed to log unknown headset model; continuing workflow: %s", exc)
        return {"ok": False, "skipped": True, "reason": "write_failed", "error": str(exc)}


def _shared_row_values(row, headers):
    return [row.get(header, "") for header in headers]


def _candidate_name_key(value):
    return " ".join(str(value or "").strip().lower().split())


def _candidate_row_active(row):
    if _shared_truthy(row.get("archived")):
        return False
    return True


def _candidate_row_withdrawn(row):
    return _shared_truthy((row or {}).get("withdrawn")) or str((row or {}).get("status") or (row or {}).get("latest_status") or "").upper() == "WITHDREW FROM CERTIFICATION"


def _candidate_row_extra_attempt(row):
    return _shared_truthy((row or {}).get("extra_attempt_granted"))


def _candidate_qualifying_failure(row):
    status = str(row.get("status") or "").strip().upper()
    if status in {"FAIL", "FAIL-FINAL ATTEMPT", "NC/NS"}:
        return True
    sup_results = [str(row.get(f"sup_transfer_{i}_result") or "").strip().lower() for i in range(1, 3)]
    call_results = [str(row.get(f"call_{i}_result") or "").strip().lower() for i in range(1, 4)]
    return call_results.count("pass") >= 2 and sup_results.count("fail") >= 2


def _candidate_attempt_summary(rows):
    qualifying_failures = sum(1 for row in rows if _candidate_qualifying_failure(row))
    extra_attempt = any(_shared_truthy(row.get("extra_attempt_granted")) for row in rows)
    withdrawn = any(_candidate_row_withdrawn(row) for row in rows)
    return {
        "attempt_count": qualifying_failures,
        "final_attempt_risk": qualifying_failures >= 2 and not extra_attempt,
        "extra_attempt_granted": extra_attempt,
        "withdrawn": withdrawn,
    }


def _shared_sheet_gid(sheets_api, sheet_id, tab_name):
    metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
    for sheet in metadata.get("sheets", []):
        props = sheet.get("properties") or {}
        if props.get("title") == tab_name:
            return props.get("sheetId")
    return None


def _shared_admin_candidate_snapshot():
    context = _shared_sheet_context()
    if not context.get("ok"):
        return {"ok": False, "error": context.get("error"), "setup": context.get("setup"), "candidates": [], "pending": []}

    try:
        sheets_api = context["service"].spreadsheets()
        sheet_id = context["sheet_id"]
        candidate_rows = [
            _normalize_shared_row(row)
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
    except Exception as exc:
        logger.exception("[SHARED] Failed to read admin candidate tracking rows: %s", exc)
        return {"ok": False, "error": f"Unable to read shared candidate tracking: {exc}", "setup": _shared_tracking_required_setup(), "candidates": [], "pending": []}

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

    pending_active = [
        row for row in pending_rows
        if str(row.get("status") or "").strip().lower() in {"pending", "resumed"}
    ]
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
        "mark_passed",
        "mark_failed",
        "mark_incomplete",
        "move_pending_sup_transfer",
        "remove_pending_sup_transfer",
    }
    if action not in supported_actions:
        return {"ok": False, "error": "Unsupported candidate tracking action."}
    if action == "restore_active":
        action = "restore_withdrawal"
    if not candidate_name and not session_id and not pending_id:
        targets = (payload or {}).get("targets") or []
        if action != "delete_candidate_history" or not isinstance(targets, list) or not targets:
            return {"ok": False, "error": "Candidate name, session id, or pending id is required."}

    context = _shared_sheet_context()
    if not context.get("ok"):
        return {"ok": False, "error": context.get("error"), "setup": context.get("setup")}

    try:
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
                (session_id and str(row.get("session_id") or "").strip() == session_id)
                or (target_key and _candidate_name_key(row.get("candidate_name")) == target_key)
            )
            if not matches:
                continue
            if action == "withdraw":
                row["status"] = "WITHDREW FROM CERTIFICATION"
                row["withdrawn"] = "TRUE"
                row["withdrawn_at"] = now_iso
                row["retention_until"] = row.get("retention_until") or retention_until
            elif action == "restore_withdrawal":
                row["withdrawn"] = "FALSE"
                row["withdrawn_at"] = ""
                if str(row.get("status") or "").upper() == "WITHDREW FROM CERTIFICATION":
                    row["status"] = "INCOMPLETE"
                row["review_notes"] = "\n\n".join(part for part in [row.get("review_notes") or "", "Admin restored candidate from withdrew from certification status."] if part)
            elif action == "grant_extra_attempt":
                row["extra_attempt_granted"] = "TRUE"
                row["extra_attempt_reason"] = reason
                row["withdrawn"] = "FALSE"
                row["withdrawn_at"] = ""
                if str(row.get("status") or "").upper() == "WITHDREW FROM CERTIFICATION":
                    row["status"] = "INCOMPLETE"
                row["review_notes"] = "\n\n".join(part for part in [row.get("review_notes") or "", f"Extra attempt granted. {reason}".strip()] if part)
            elif action in {"mark_passed", "mark_failed", "mark_incomplete", "move_pending_sup_transfer", "remove_pending_sup_transfer"}:
                previous_status = row.get("status") or ""
                if action == "mark_passed":
                    row["status"] = "Pass"
                    row["mock_calls_completed"] = "TRUE"
                    row["sup_transfers_completed"] = "TRUE"
                    row["needs_sup_transfer"] = "FALSE"
                    row["pending_sup_transfer_id"] = ""
                elif action == "mark_failed":
                    row["status"] = fail_status_for_row(row)
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
        logger.exception("[SHARED] Candidate admin action failed: %s", exc)
        return {"ok": False, "error": f"Candidate tracking update failed: {exc}", "setup": _shared_tracking_required_setup()}


def _sam_master_sheet_context():
    service_result = _get_shared_tracking_sheet_service()
    if not service_result.get("ok"):
        return service_result
    return {
        "ok": True,
        "service": service_result["service"],
        "sheet_id": service_result["sheet_id"],
        "serviceAccountEmail": service_result.get("serviceAccountEmail") or _get_service_account_email(),
    }


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
        return {"ok": False, "configured": False, "error": "SAM setup requires access to the admin configuration sheet."}
    try:
        status, _rows = _read_sam_authorized_users(context["service"].spreadsheets(), context["sheet_id"])
        return {
            "ok": bool(status.get("ok")),
            "configured": bool(status.get("ok")),
            "defaultOwnerCreated": bool(status.get("defaultOwnerCreated")),
            "error": status.get("error") or "",
        }
    except Exception as exc:
        logger.warning("[SAM-SETUP] Unable to verify authorized users tab: %s", exc)
        return {"ok": False, "configured": False, "error": "SAM setup requires access to the admin configuration sheet."}


def _complete_sam_setup(payload):
    entered_name = " ".join(str((payload or {}).get("name") or "").split())
    entered_pin = str((payload or {}).get("pin") or "").strip()
    device_name = str((payload or {}).get("device_name") or "").strip()[:120]
    logger.info("[SAM-SETUP] Starting setup validation name=%s pin=%s device_present=%s", entered_name or "<blank>", _masked_pin_for_log(entered_pin), bool(device_name))
    if not entered_name or not entered_pin:
        reason = "Name is required." if not entered_name else "PIN is required."
        logger.warning("[SAM-SETUP] Validation failed: %s", reason)
        return {"ok": False, "error": reason}

    context = _sam_master_sheet_context()
    if not context.get("ok"):
        message = context.get("error") or "SAM setup requires access to the admin configuration sheet."
        logger.warning("[SAM-SETUP] Master sheet context unavailable: %s", message)
        return {"ok": False, "error": message}

    try:
        sheets_api = context["service"].spreadsheets()
        status, rows = _read_sam_authorized_users(sheets_api, context["sheet_id"])
        if not status.get("ok"):
            message = status.get("error") or "Missing headers on sam-authorized-users."
            logger.warning(
                "[SAM-SETUP] Authorized-users tab unusable tab=%s headerStatus=%s error=%s",
                SAM_AUTHORIZED_USERS_TAB,
                status.get("headerStatus") or "",
                message,
            )
            return {"ok": False, "error": message}
        logger.info(
            "[SAM-SETUP] Headers found for %s: %s",
            SAM_AUTHORIZED_USERS_TAB,
            ", ".join(SAM_AUTHORIZED_USER_HEADERS),
        )
        matched_name_row = None
        name_key = entered_name.casefold()
        for row in rows:
            if str(row.get("name") or "").strip().casefold() != name_key:
                continue
            matched_name_row = row
            pin_ok = hmac.compare_digest(str(row.get("pin") or "").strip(), entered_pin)
            enabled_ok = _shared_truthy(row.get("enabled"))
            logger.info(
                "[SAM-SETUP] Matched user row=%s name=%s pinMatch=%s enabledRaw=%r enabledParsed=%s storedPin=%s",
                row.get("_row_number"),
                row.get("name") or entered_name,
                pin_ok,
                row.get("enabled"),
                enabled_ok,
                _masked_pin_for_log(row.get("pin")),
            )
            if not pin_ok:
                logger.warning("[SAM-SETUP] Validation failed for name=%s: PIN mismatch", entered_name)
                return {"ok": False, "error": "PIN mismatch."}
            if not enabled_ok:
                logger.warning("[SAM-SETUP] Validation failed for name=%s: user disabled enabledRaw=%r", entered_name, row.get("enabled"))
                return {"ok": False, "error": "User disabled."}
            if pin_ok and enabled_ok:
                target = row
                break
        else:
            target = None
        if not matched_name_row:
            logger.warning("[SAM-SETUP] Validation failed: user not found name=%s rows=%d", entered_name, len(rows))
            return {"ok": False, "error": "User not found."}
        if not target:
            logger.warning("[SAM-SETUP] Validation failed for name=%s: access not enabled", entered_name)
            return {"ok": False, "error": "User disabled."}

        target["installed"] = "TRUE"
        target["install_date"] = datetime.now(timezone.utc).isoformat()
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
        logger.info(
            "[SAM-SETUP] Setup completed for row=%s name=%s role=%s installed=TRUE device_written=%s",
            target.get("_row_number"),
            target.get("name") or entered_name,
            target.get("role") or "user",
            bool(device_name),
        )
        return {"ok": True, "name": target.get("name") or entered_name, "role": target.get("role") or "user"}
    except Exception as exc:
        logger.exception("[SAM-SETUP] Setup validation failed because sheet access failed: %s", exc)
        return {"ok": False, "error": f"SAM setup validation failed: {exc}"}


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
    service_result = _get_shared_tracking_sheet_service()
    if not service_result.get("ok"):
        return {"ok": False, "error": service_result.get("error"), "setup": _update_sheet_required_setup()}
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


def _candidate_session_row(session, existing_rows=None):
    existing_rows = existing_rows or []
    status = compute_final_status(session)
    shared_status = _shared_status(status)
    session_id = str(session.get("history_id") or session.get("resume_source_history_id") or uuid.uuid4())
    candidate_name = str(session.get("candidate_name") or session.get("candidate") or "").strip()
    first, last_initial = _split_candidate_name(candidate_name)
    pending_id = str(session.get("pending_sup_transfer_id") or session.get("shared_pending_id") or "").strip()
    needs_sup = _candidate_needs_sup_transfer(session, status)
    if needs_sup and not pending_id:
        pending_id = f"pending-{session_id}"
    created_at = str(session.get("timestamp_iso") or session.get("created_at") or datetime.now(timezone.utc).isoformat())
    completed_at = str(session.get("completed_at") or session.get("timestamp_iso") or datetime.now(timezone.utc).isoformat())
    attempt_number = session.get("attempt_number") or _session_attempt_number(existing_rows, candidate_name)
    review_notes = session.get("review_notes") or ""
    if session.get("candidate_override_used"):
        override_note = "Final-attempt override used for this candidate."
        if session.get("candidate_override_reason"):
            override_note = f"{override_note} {session.get('candidate_override_reason')}"
        review_notes = "\n\n".join(part for part in [review_notes, override_note] if str(part or "").strip())

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
    ], pending_id, needs_sup


def _pending_sup_transfer_row(session, pending_id, existing_row=None, completed=False):
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
    ]


def _sync_shared_candidate_tracking(session):
    context = _shared_sheet_context()
    if not context.get("ok"):
        logger.warning("[SHARED] Candidate tracking unavailable: %s Required setup: %s", context.get("error"), context.get("setup"))
        return {"ok": False, "error": context.get("error"), "setup": context.get("setup")}

    current_operation = "initialize"
    try:
        sheets_api = context["service"].spreadsheets()
        sheet_id = context["sheet_id"]
        current_operation = "read_candidate_rows"
        candidate_rows = _shared_read_rows(
            sheets_api,
            sheet_id,
            SHARED_CANDIDATE_SESSIONS_TAB,
            SHARED_CANDIDATE_SESSION_HEADERS,
        )
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

        return {"ok": True, "candidateAction": candidate_action, "pendingAction": pending_action}
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
    if candidate.startswith(query) and len(query) >= 5:
        return 65
    if query in candidate and len(query) >= 5:
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


def _lookup_shared_candidate_sessions(candidate_name):
    query = " ".join(str(candidate_name or "").lower().split())
    if len(query) < 2:
        return {"ok": True, "matches": [], "finalAttempt": False, "finalAttemptUsed": False, "withdrawn": False, "extraAttemptGranted": False}
    try:
        context = _shared_sheet_context()
        if not context.get("ok"):
            return {"ok": False, "matches": [], "error": context.get("error"), "setup": context.get("setup")}
        sheets_api = context["service"].spreadsheets()
        rows = _shared_read_rows(sheets_api, context["sheet_id"], SHARED_CANDIDATE_SESSIONS_TAB, SHARED_CANDIDATE_SESSION_HEADERS)
    except Exception as exc:
        logger.warning("[SHARED] Candidate lookup unavailable; continuing local workflow: %s", exc)
        return {"ok": False, "matches": [], "error": f"Shared candidate lookup unavailable: {exc}", "setup": _shared_tracking_required_setup()}
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
    qualifying_failures = [
        row for row in confirmed_matches
        if _shared_status_upper(row) in {"FAIL", "FAIL-FINAL ATTEMPT"}
    ]
    final_attempt_used = any(_shared_status_upper(row) == "FAIL-FINAL ATTEMPT" for row in confirmed_matches)
    withdrawn = any(_candidate_row_withdrawn(row) or _shared_status_upper(row) == "WITHDREW FROM CERTIFICATION" for row in confirmed_matches)
    extra_attempt = any(_candidate_row_extra_attempt(row) for row in confirmed_matches)
    visible_matches = [row for row in active_matches if _shared_candidate_suggestion_visible(row)]
    return {
        "ok": True,
        "matches": visible_matches[:20],
        "finalAttempt": len(qualifying_failures) >= 2 and not extra_attempt and not final_attempt_used,
        "finalAttemptUsed": final_attempt_used and not extra_attempt,
        "qualifyingFailureCount": len(qualifying_failures),
        "withdrawn": withdrawn,
        "extraAttemptGranted": extra_attempt,
    }


def _get_shared_pending_sup_transfers():
    try:
        context = _shared_sheet_context()
        if not context.get("ok"):
            return {"ok": False, "items": [], "error": context.get("error"), "setup": context.get("setup")}
        sheets_api = context["service"].spreadsheets()
        rows = _shared_read_rows(sheets_api, context["sheet_id"], SHARED_PENDING_SUP_TRANSFERS_TAB, SHARED_PENDING_SUP_TRANSFER_HEADERS)
    except Exception as exc:
        logger.warning("[SHARED] Pending supervisor transfer lookup unavailable; continuing local workflow: %s", exc)
        return {"ok": False, "items": [], "error": f"Shared pending supervisor transfers unavailable: {exc}", "setup": _shared_tracking_required_setup()}
    items = [
        _normalize_shared_row(row)
        for row in rows
        if str(row.get("status") or "").strip().lower() in {"pending", "resumed"}
    ]
    items.sort(key=lambda row: str(row.get("created_at") or ""), reverse=True)
    return {"ok": True, "items": items}


# ══════════════════════════════════════════════════════════════════
# GEMINI SERVICE (summary generation)
# ══════════════════════════════════════════════════════════════════
def _get_coaching_items(data):
    if not data:
        return []
    items = []
    coaching = data.get("coaching", {})
    for key, checked in coaching.items():
        if checked and "_" not in key and key != "Other":
            items.append(key.lower())
        elif checked and "_" in key:
            items.append(key.split("_", 1)[1].lower())
    notes = data.get("coach_notes", "")
    if notes:
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
            items.append(f"{key.lower()} (Detail: {detail})" if detail else key.lower())
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
    return bool(_looks_like_discord_screenshot_coaching(notes))


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

    for key, checked in coaching.items():
        if not checked or not key:
            continue
        if "_" in key:
            parent, child = key.split("_", 1)
            parent = str(parent or "").strip()
            child = str(child or "").strip()
            if not parent or not child:
                continue
            grouped.setdefault(parent, [])
            if child not in grouped[parent]:
                grouped[parent].append(child)
            continue
        parent = str(key or "").strip()
        if not parent:
            continue
        grouped.setdefault(parent, [])

    parts = []
    for parent, children in grouped.items():
        parent_text = _sentence_case(parent)
        child_values = [_sentence_case(child) for child in children if _sentence_case(child)]
        if child_values:
            parts.append(f"{parent_text} ({'; '.join(child_values)})")
        else:
            parts.append(parent_text)
    return _reject_headset_like_summary_parts(parts, "coaching")


def _extract_fail_summary_parts(section):
    fails = (section or {}).get("fails", {}) or {}
    parts = []
    for key, checked in fails.items():
        if checked and key:
            parts.append(str(key).strip())
    return _reject_headset_like_summary_parts(_dedupe_preserve_order(parts), "fail")


def _extract_fail_reason_details(section):
    details = (section or {}).get("failReasonDetails") or (section or {}).get("fail_reason_details") or {}
    if not isinstance(details, dict):
        return {}
    return {
        str(reason or "").strip(): _normalize_notes_sentence(value)
        for reason, value in details.items()
        if str(reason or "").strip() and _normalize_notes_sentence(value)
    }


def _format_fail_reason_detail_lines(section):
    fail_items = [item for item in _extract_fail_summary_parts(section) if item != "Other"]
    fail_details = _extract_fail_reason_details(section)
    lines = []
    for item in fail_items:
        detail = fail_details.get(item)
        if detail:
            lines.append(f"Fail reason: {item}. Detail: {detail}.")
        else:
            lines.append(f"Fail reason: {item}.")
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


def _is_fail_na(session):
    """Fail Summary is only for session-level failures, not coaching/incomplete outcomes.
    But it must not be only N/A when fail reasons, failed calls, stopped responding, tech issue, or evaluator notes exist.
    """
    final_status = compute_final_status(session)
    if final_status in {"Pass", "RESUMED-PASS"}:
        return True
    if final_status == FINAL_READINESS_NEEDS_RETEST:
        return False

    if session.get("auto_fail_reason"):
        return False
    if _has_tech_issue(session) or session.get("stopped_responding"):
        return False

    # Check failed calls/transfers
    for i in range(1, 4):
        if (session.get(f"call_{i}") or {}).get("result") == "Fail":
            return False
    for i in range(1, 3):
        if (session.get(f"sup_transfer_{i}") or {}).get("result") == "Fail":
            return False

    # Check evaluator notes
    notes = session.get("finalEvaluatorNotes") or {}
    has_notes = bool(notes.get("needsCoaching", "").strip() or notes.get("other", "").strip() or notes.get("strengths", "").strip() or notes.get("notes", "").strip())
    include_notes = notes.get("includeInFailSummary", True) and not notes.get("historyOnly", False)
    if has_notes and include_notes:
        return False

    return final_status not in {"Fail", "FAIL-Final Attempt", "NC/NS"}


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

    if auto_fail:
        auto_fail_text = str(auto_fail or "").strip().lower()
        if auto_fail_text.startswith("nc"):
            return "NC/NS"
        return "FAIL-Final Attempt" if final_attempt else "Fail"

    if sup_only:
        if sups_passed >= 1:
            return "RESUMED-PASS" if resumed_sup else "Pass"
        if sups_failed >= 2:
            return "FAIL-Final Attempt" if final_attempt else "Incomplete"
        if newbie is not None:
            return "Incomplete"
        return "Incomplete"

    if calls_passed >= 2:
        if sups_passed >= 1:
            return "Pass"
        if sups_failed >= 2:
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
        if auto_fail.startswith("nc"):
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
    auto_fail = session.get("auto_fail_reason")
    if auto_fail:
        base_fail = (
            "Session Auto-Fail - Fail - "
            f"Recorded auto-fail reason: {_sentence_case(auto_fail)}."
        )
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
            return _append_readiness_override_note(fallback_notes_str, session)
        return _append_readiness_override_note(base_fail + "\n\n" + fallback_notes_str, session)
    else:
        if not base_fail:
            return _append_readiness_override_note("No structured fail reason was selected. See evaluator notes and call results for context.", session)
        return _append_readiness_override_note(base_fail, session)


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


def _log_gemini_prompt_source(prompt_type, source):
    prompt_name = "fail" if prompt_type == "fail" else "coaching"
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

    auto_fail_summaries = _auto_fail_review_summaries(session)
    use_gemini = bool(settings and settings.get("enable_gemini"))
    api_key = (api_key or "").strip()
    coaching_prompt, coaching_prompt_source = _get_gemini_prompt_details(settings, "coaching")
    fail_prompt, fail_prompt_source = _get_gemini_prompt_details(settings, "fail")
    _log_gemini_prompt_source("coaching", coaching_prompt_source)
    _log_gemini_prompt_source("fail", fail_prompt_source)
    logger.info(
        "[Gemini] Override source active: coaching=%s fail=%s",
        coaching_prompt_source,
        fail_prompt_source,
    )
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
        return {**auto_fail_summaries, **diagnostics}

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

    # Format evaluator notes for coaching summary
    notes = session.get("finalEvaluatorNotes") or {}
    coaching_notes_text = ""
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
            coaching_notes_text = "Additional Notes: " + " ".join(notes_parts)

    # Format evaluator notes for fail summary
    fail_notes_text = ""
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
            fail_notes_text = "Additional Notes: " + " ".join(notes_parts)

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
        ret["fail"] = res_fail
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
    newbie = session.get("newbie_shift_data")
    if not newbie:
        return "N/A"
    parts = [newbie.get("newbie_date", "").strip(), "at", newbie.get("newbie_time", "").strip(), newbie.get("newbie_tz", "").strip()]
    return " ".join(part for part in parts if part).strip() or "N/A"


def _map_auto_fail_for_form(auto_fail_reason):
    reason = (auto_fail_reason or "").strip().lower()
    if not reason:
        return "N/A"
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
        return {"coaching": _append_readiness_override_note("N/A", session), "fail": _append_readiness_override_note(f"{name} was a NC/NS.", session)}
    if auto_fail_type == "not_ready":
        return {"coaching": _append_readiness_override_note("N/A", session), "fail": _append_readiness_override_note(f"{name} was not ready or prepared for the session.", session)}
    if auto_fail_type == "headset":
        return {
            "coaching": _append_readiness_override_note(f"{name} was informed that a USB headset with a noise-cancelling microphone is required to contract with ACD.", session),
            "fail": _append_readiness_override_note(f"{name} was not using an approved USB headset with a noise-cancelling microphone.", session),
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


def _is_form_fail_session(session):
    if session.get("auto_fail_reason"):
        return False
    if session.get("supervisor_only", False):
        return _count_results(session, "sup_transfer", 2, "Fail") >= 2
    return _count_results(session, "call", 3, "Fail") >= 2


def build_form_fill_payload(session, settings, coaching_summary="", fail_summary=""):
    sup_only = session.get("supervisor_only", False)
    tech_issue = _map_tech_issue_for_form(session)
    summaries = generate_summaries(session)
    completion_flags = _completion_flags_for_form(session)

    fail_reason = "N/A"
    final_status = compute_final_status(session)
    if session.get("auto_fail_reason") or _is_form_fail_session(session) or final_status in {"Fail", "FAIL-Final Attempt", "NC/NS", FINAL_READINESS_NEEDS_RETEST}:
        fail_reason = (fail_summary or "").strip() or summaries["fail"]

    return {
        "tester_name": (session.get("tester_name") or settings.get("tester_name") or settings.get("display_name") or "").strip(),
        "candidate_name": (session.get("candidate_name") or session.get("candidate") or "").strip(),
        "skills": ["Supervisor Transfer"] if sup_only else ["Mock Calls", "Supervisor Transfer"],
        "mock_complete": completion_flags["mock_complete"],
        "sup_complete": completion_flags["sup_complete"],
        "all_complete": completion_flags["all_complete"],
        "newbie_shift": _format_newbie_shift_for_form(session),
        "auto_fail": _map_auto_fail_for_form(session.get("auto_fail_reason")),
        "headset": (session.get("headset_brand") or "N/A").strip() or "N/A",
        "tech_issue_choice": tech_issue["choice"],
        "tech_issue_other": tech_issue["other_text"],
        "coaching": (coaching_summary or "").strip() or summaries["coaching"],
        "fail_reason": fail_reason,
    }


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
        "http://localhost:3000,http://127.0.0.1:3000,file://,null",
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


@api_router.get("/settings/defaults")
async def get_defaults():
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
        "admin_setup_markdown": ADMIN_SETUP_MARKDOWN,
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
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if doc:
        return {"session": doc, "has_active": bool(doc.get("candidate_name"))}
    return {"session": None, "has_active": False}


@api_router.get("/shared/candidates/lookup")
async def lookup_shared_candidate(name: str = ""):
    return await asyncio.to_thread(_lookup_shared_candidate_sessions, name)


@api_router.get("/shared/pending-sup-transfers")
async def get_shared_pending_sup_transfers():
    return await asyncio.to_thread(_get_shared_pending_sup_transfers)


@api_router.get("/shared/admin/candidates")
async def get_shared_admin_candidates(request: Request):
    _require_admin_token(request)
    return await asyncio.to_thread(_shared_admin_candidate_snapshot)


@api_router.post("/shared/admin/candidates/action")
async def post_shared_admin_candidate_action(payload: dict, request: Request):
    _require_admin_token(request)
    return await asyncio.to_thread(_shared_admin_candidate_action, payload or {})


@api_router.get("/sam/setup/status")
async def get_sam_setup_status():
    settings_doc = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0}) or {}
    status = await asyncio.to_thread(_sam_setup_status)
    return {
        **status,
        "setupComplete": bool(settings_doc.get("sam_setup_complete")),
        "userName": settings_doc.get("sam_user_name") or "",
        "role": settings_doc.get("sam_user_role") or "",
    }


@api_router.post("/sam/setup/complete")
async def post_sam_setup_complete(payload: dict):
    result = await asyncio.to_thread(_complete_sam_setup, payload or {})
    if not result.get("ok"):
        return result
    await db.settings.update_one(
        {"_id": "app_settings"},
        {"$set": {
            "sam_setup_complete": True,
            "sam_user_name": result.get("name") or "",
            "sam_user_role": result.get("role") or "",
        }},
        upsert=True,
    )
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


@api_router.post("/session/start")
async def start_session(payload: dict, request: Request):
    session = empty_session()
    session.update(payload)
    session["last_saved"] = datetime.now(timezone.utc).strftime("%I:%M %p")
    await db.sessions.replace_one({"_id": "active_session"}, {"_id": "active_session", **session}, upsert=True)
    return {"ok": True, "session": session}


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
        
    payload["last_saved"] = datetime.now(timezone.utc).strftime("%I:%M %p")
    await db.sessions.update_one({"_id": "active_session"}, {"$set": payload}, upsert=False)
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    return {"ok": True, "session": doc}


@api_router.post("/session/call")
async def save_call(payload: dict, request: Request):
    key = f"call_{payload.get('call_num', 1)}"
    await db.sessions.update_one({"_id": "active_session"}, {"$set": {key: payload, "current_call_draft": None, "current_call_num": None}})
    return {"ok": True}


@api_router.post("/session/sup")
async def save_sup(payload: dict, request: Request):
    key = f"sup_transfer_{payload.get('transfer_num', 1)}"
    await db.sessions.update_one({"_id": "active_session"}, {"$set": {key: payload, "current_sup_transfer_draft": None, "current_sup_transfer_num": None}})
    return {"ok": True}


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
    db.backup("after-finish-session")
    await db.sessions.delete_one({"_id": "active_session"})
    warning = ""
    if not shared_result.get("ok"):
        warning = "Session saved locally, but shared Google Sheet update failed."
    return {
        "ok": True,
        "action": action,
        "record": {k: v for k, v in saved_record.items() if k != "_id"},
        "sharedTracking": shared_result,
        "warning": warning,
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
    for doc in docs:
        normalized_status = normalize_history_status(doc)
        doc["status"] = normalized_status
        if normalized_status != "NC/NS":
            doc["final_status"] = normalized_status
        doc["history_id"] = doc.get("history_id") or _history_identity(doc)
    return docs


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
    return {"total": total, "passes": passes, "fails": fails, "ncns": ncns, "incomplete": incomplete, "pass_rate": pass_rate}


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

# ══════════════════════════════════════════════════════════════════
# TICKER / NOTIFICATIONS (fetches from admin-configured Google Sheet, falls back to cache/defaults)
# ══════════════════════════════════════════════════════════════════
NOTIFICATION_CACHE_TTL_SECONDS = 25
NOTIFICATION_REMOTE_FETCH_TIMEOUT_SECONDS = 4

_ticker_cache = {"messages": None, "last_fetch": 0, "using_fallback": False}
_headset_cache = {"groups": None, "last_fetch": 0}
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
            "message": f"Welcome to Mock Testing Suite v{APP_VERSION}",
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
            "message": "Tip: Use the Discord Post button to quickly copy common messages",
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
            "id": "default-help",
            "type": "ticker",
            "title": "Help",
            "message": "Need help? Check the Help tab for step-by-step setup guides",
            "showTicker": True,
            "showPopup": False,
            "showBanner": False,
            "persistent": True,
            "startTime": "",
            "endTime": "",
            "actionText": "",
            "actionURL": "",
        }
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
    if re.match(r"^\d{4}-\d{2}-\d{2}$", text):
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
    text = _normalize_notification_text(value).upper().replace(".", "").strip()
    if not text:
        return None

    for fmt in ("%I:%M %p", "%I:%M:%S %p", "%H:%M", "%H:%M:%S"):
        try:
            parsed = datetime.strptime(text, fmt)
            return parsed.hour, parsed.minute, parsed.second
        except ValueError:
            continue

    return None


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


def _combine_notification_datetime(date_value, time_value, default_time):
    parsed_date = _normalize_notification_date(date_value)
    if not parsed_date:
        return None

    parsed_time = _normalize_notification_time(time_value) or default_time
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
        "StartDate": _normalize_notification_text(item.get("StartDate")),
        "StartTime": _normalize_notification_text(item.get("StartTime")),
        "EndDate": _normalize_notification_text(item.get("EndDate")),
        "EndTime": _normalize_notification_text(item.get("EndTime")),
        "ActionText": _normalize_notification_text(item.get("ActionText")),
        "ActionURL": _normalize_notification_text(item.get("ActionURL")),
        "CreatedAt": created_at,
        "UpdatedAt": updated_at,
    }
    normalized["ID"] = _ensure_notification_id(normalized)
    if normalized["EndDate"] and not normalized["EndTime"]:
        normalized["EndTime"] = "12:00 AM"
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

    start_date = _combine_notification_datetime(
        normalized["StartDate"],
        normalized["StartTime"],
        (0, 0, 0),
    ) if normalized["StartDate"] else None
    end_date = _combine_notification_datetime(
        normalized["EndDate"],
        normalized["EndTime"],
        (0, 0, 0),
    ) if normalized["EndDate"] else None

    if normalized["StartDate"] and not start_date:
        errors.append("Starts At must use a valid Eastern date and time.")
    if normalized["EndDate"] and not end_date:
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
    logger.info(
        "[SHEETS] Active Google service account file=%s client_email=%s",
        creds_path,
        client_email or "unknown",
    )
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


def _google_sheet_error_type(exc):
    if exc is None:
        return ""
    return exc.__class__.__name__


def _sheet_permission_needed(operation):
    if str(operation or "").startswith("read_"):
        return "Viewer access to the target spreadsheet, plus Google Sheets API access for the project."
    return "Editor access to the target spreadsheet for the active service account, plus Google Sheets API access for the project."


def _run_google_sheet_permission_check():
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
        result["serviceAccountEmail"] = (
            (credential_info or {}).get("activeClientEmail")
            or result.get("serviceAccountEmail")
            or ""
        )
        result["activeServiceAccountEmail"] = result["serviceAccountEmail"]
        result["credentialFiles"] = credential_info or {}
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
            "[SHEETS-DIAG] Operation failed. operation=%s spreadsheet_id=%s service_account=%s reason=%s error=%s",
            operation,
            result.get("spreadsheetId") or "",
            result.get("serviceAccountEmail") or "unknown",
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
        "[SHEETS-DIAG] Starting permission check. master_spreadsheet_id=%s notification_spreadsheet_id=%s service_account=%s",
        master_sheet_id or "",
        notification_config.get("sheet_id") or "",
        result["activeServiceAccountEmail"] or "unknown",
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
        result["serviceAccountEmail"] = service_result.get("serviceAccountEmail") or result.get("serviceAccountEmail") or ""
        result["activeServiceAccountEmail"] = result["serviceAccountEmail"]
        record_success("load_credentials", credentialsPath=(credential_info or {}).get("activePath") or "")
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
        logger.info("[SHEETS-DIAG] Operation=read_spreadsheet_metadata spreadsheet_id=%s", master_sheet_id)
        metadata = sheets_api.get(spreadsheetId=master_sheet_id).execute()
        record_success("read_spreadsheet_metadata", title=((metadata.get("properties") or {}).get("title") or ""))
    except Exception as exc:
        record_failure("read_spreadsheet_metadata", exc)
        return result

    try:
        logger.info("[SHEETS-DIAG] Operation=list_tabs spreadsheet_id=%s", master_sheet_id)
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
            logger.info("[SHEETS-DIAG] Operation=create_or_verify_test_tab spreadsheet_id=%s tab=%s", master_sheet_id, test_tab_title)
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
        logger.info("[SHEETS-DIAG] Operation=read_test_tab spreadsheet_id=%s tab=%s", master_sheet_id, test_tab_title)
        sheets_api.values().get(
            spreadsheetId=master_sheet_id,
            range=f"{quoted_test_tab}!A1:B2",
        ).execute()
        record_success("read_test_tab", tab=test_tab_title)
    except Exception as exc:
        record_failure("read_test_tab", exc)
        return result

    try:
        logger.info("[SHEETS-DIAG] Operation=write_test_cell spreadsheet_id=%s tab=%s", master_sheet_id, test_tab_title)
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
        logger.info("[SHEETS-DIAG] Operation=append_test_row spreadsheet_id=%s tab=%s", master_sheet_id, test_tab_title)
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
        "[SHEETS-DIAG] Permission check passed. master_spreadsheet_id=%s service_account=%s",
        master_sheet_id,
        result["activeServiceAccountEmail"] or "unknown",
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


def _load_notification_items_from_google_sheets_api():
    context = _sam_master_sheet_context()
    if context.get("ok"):
        try:
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
            logger.warning("[NOTIFICATIONS] Master sam-notifications unavailable; using legacy fallback if available: %s", exc)

    legacy = _load_legacy_notification_items_from_google_sheets_api()
    if legacy.get("ok"):
        legacy["source"] = "legacy_fallback"
        logger.warning("[NOTIFICATIONS] Active source=LEGACY fallback sheet.")
    return legacy


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
            "[NOTIFICATIONS] Operation=ensure_master_notification_tab spreadsheet_id=%s tab=%s service_account=%s",
            sheet_id,
            SAM_NOTIFICATIONS_TAB,
            client_email,
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
            logger.info("[NOTIFICATIONS] Operation=header_write spreadsheet_id=%s tab=%s", sheet_id, sheet_title)
            sheets_api.values().update(
                spreadsheetId=sheet_id,
                range=header_range,
                valueInputOption="USER_ENTERED",
                body={"values": [expected_header]},
            ).execute()

        data_range = f"{quoted_title}!A2:{last_column}"
        current_operation = "read_rows"
        logger.info("[NOTIFICATIONS] Operation=read_rows spreadsheet_id=%s tab=%s", sheet_id, sheet_title)
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
            logger.info("[NOTIFICATIONS] Operation=update spreadsheet_id=%s tab=%s row=%s", sheet_id, sheet_title, target_row_number)
            sheets_api.values().update(
                spreadsheetId=sheet_id,
                range=f"{quoted_title}!A{target_row_number}:{last_column}{target_row_number}",
                valueInputOption="USER_ENTERED",
                body={"values": [row_values]},
            ).execute()
            action = "updated"
        else:
            current_operation = "append"
            logger.info("[NOTIFICATIONS] Operation=append spreadsheet_id=%s tab=%s", sheet_id, sheet_title)
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
    if messages:
        _ticker_cache["messages"] = messages
        _ticker_cache["last_fetch"] = time.time()
        _ticker_cache["using_fallback"] = False
        if _ticker_fetch_status.get("source") != "google":
            _set_ticker_fetch_status(_ticker_fetch_status.get("source") or "cache", _ticker_fetch_status.get("status") or "ticker loaded from cached/local notifications", len(messages))
        return {
            "messages": messages,
            "source": _ticker_fetch_status.get("source") or "unknown",
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
    return groups


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
        "configPathUsed": _runtime_config_status.get("path") or "",
        "configFound": bool(_runtime_config_status.get("found")),
        "configError": _runtime_config_status.get("error") or "",
        "defaultsPathUsed": str(defaults_dir or _defaults_status.get("path") or ""),
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
        "googleCredentialsPath": str(credentials_path or ""),
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
    try:
        _require_admin_token(request)
    except HTTPException:
        if not _can_use_local_diagnostic_auth_fallback(request):
            raise
    return _runtime_diagnostics_payload()


@api_router.get("/notifications/manage")
async def get_notifications_manage(request: Request):
    _require_admin_token(request)
    master_context = await asyncio.to_thread(_sam_master_sheet_context)
    authenticated = {"ok": False, "items": [], "error": master_context.get("error") or "SAM master Google Sheet is not configured."}
    if master_context.get("ok"):
        try:
            authenticated = await asyncio.to_thread(_read_sam_notification_items, master_context["service"].spreadsheets(), master_context["sheet_id"])
        except Exception as exc:
            logger.exception("[NOTIFICATIONS] Failed to read master sam-notifications for SAM manager: %s", exc)
            authenticated = {"ok": False, "items": [], "error": f"Unable to read master sam-notifications tab: {exc}"}

    if authenticated.get("ok"):
        return {
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

    return {
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


@api_router.post("/notifications/manage")
async def save_notification_manage(payload: dict, request: Request):
    _require_admin_token(request)
    result = await asyncio.to_thread(_save_notification_to_google_sheet, (payload or {}).get("item") or payload or {})
    return result


@api_router.delete("/notifications/manage/{notification_id:path}")
async def delete_notification_manage(notification_id: str, request: Request):
    _require_admin_token(request)
    return await asyncio.to_thread(_delete_notification_from_google_sheet, notification_id)


async def _fetch_approved_headsets():
    import time

    now = time.time()
    if _headset_cache["groups"] and (now - _headset_cache["last_fetch"]) < 300:
        return _headset_cache["groups"], ""

    sheet_groups = EXTERNAL_CONTENT.get("approved_headsets")
    if isinstance(sheet_groups, list) and sheet_groups:
        _headset_cache["groups"] = sheet_groups
        _headset_cache["last_fetch"] = now
        return sheet_groups, ""
    return _headset_cache["groups"] or [], "Unable to load the approved headset list right now."


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
    logger.info("[SCREENSHOT] Request received for filename: %s", filename)
    resolved_path = _resolve_screenshot_path(filename)
    exists = resolved_path.exists() and resolved_path.is_file()
    
    logger.info(
        "[SCREENSHOT] Lookup details - Requested: %s | Resolved path: %s | Exists: %s",
        filename,
        str(resolved_path),
        exists
    )
    
    if not exists:
        logger.error("[SCREENSHOT] File not found: %s (tried: %s)", filename, str(resolved_path))
        raise HTTPException(status_code=404, detail=f"Screenshot file '{filename}' not found.")
        
    logger.info("[SCREENSHOT] Returning 200 FileResponse for: %s", str(resolved_path))
    from fastapi.responses import FileResponse
    return FileResponse(resolved_path, media_type="image/png")


@api_router.get("/headsets")
async def get_approved_headsets():
    groups, error = await _fetch_approved_headsets()
    return {"groups": groups, "error": error}


@api_router.post("/headsets/review-log")
async def log_headset_review(payload: dict):
    return _append_headset_review_log(payload or {})


# ══════════════════════════════════════════════════════════════════
# GEMINI / SUMMARIES
# ══════════════════════════════════════════════════════════════════
@api_router.post("/gemini/summaries")
async def gen_summaries(payload: dict):
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

    form_payload = build_form_fill_payload(
        session,
        settings,
        payload.get("coaching", ""),
        payload.get("fail_reason", ""),
    )
    return fill_cert_form(form_url, form_payload, settings.get("form_fill_browser", "auto"))


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

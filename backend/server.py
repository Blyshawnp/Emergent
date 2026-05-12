"""
Mock Testing Suite — FastAPI Backend
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
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager
from functools import lru_cache
from zoneinfo import ZoneInfo
from urllib.parse import quote, urlparse
from urllib.request import urlopen

import httpx
from fastapi import FastAPI, APIRouter, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from pydantic import BaseModel
from services.form_filler import fill_form as fill_cert_form

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# ══════════════════════════════════════════════════════════════════
# CONSTANTS / DEFAULTS
# ══════════════════════════════════════════════════════════════════
DEFAULT_APP_VERSION = "1.0.1"
DEFAULT_NOTIFICATION_SHEET_URL = "https://docs.google.com/spreadsheets/d/1OkDE9SxnNA0WEHa-TeiZ3b2j5AZ9qiJi1Hv4Lmn8YSE/edit?gid=0#gid=0"
ADMIN_TOKEN_HEADER = "X-MTS-Admin-Token"
AUTH_EXEMPT_PATHS = {
    "/api/",
}


def _require_admin_token(request: Request):
    expected = (os.getenv("MTS_ADMIN_TOKEN") or "").strip()
    provided = (request.headers.get(ADMIN_TOKEN_HEADER) or "").strip()
    if not expected or not provided or not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=403, detail="Admin access is required for this endpoint.")


def _admin_token_configured():
    return bool((os.getenv("MTS_ADMIN_TOKEN") or "").strip())


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


def _runtime_config_candidates():
    candidates = []
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
# content came from. Values: source in {google, local, builtin}; served_from
# is computed lazily at request time (sqlite vs memory).
_content_source_status = {}


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


# Canonical list of content sections tracked across loaders. Keep in sync with
# DEFAULTS_FILE_MAP / CONTENT_SHEET_TAB_MAP plus the donor sub-keys produced by
# _normalize_callers and the markdown keys produced by _load_google_doc_overrides.
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
    encoded_tab_name = quote(tab_name, safe="")
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv&sheet={encoded_tab_name}"
    with urlopen(url, timeout=10) as response:
        return response.read().decode("utf-8-sig")


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
    structure — callers should treat that as malformed and fall back to local
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
    return list(csv.DictReader(io.StringIO(csv_text or "")))


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
}

DISCORD_POST_MESSAGE_ALIASES = {
    "message",
    "post",
    "template",
    "body",
    "text",
}

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
    for row in rows:
        row = row or {}
        show_name = str(row.get("ShowName") or "").strip()
        if not show_name:
            continue
        items.append([
            show_name,
            str(row.get("OneTimeAmount") or "").strip(),
            str(row.get("MonthlyAmount") or "").strip(),
            str(row.get("Gift") or "").strip(),
        ])
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

    for row in rows:
        row = row or {}
        category = _normalize_caller_category(row.get("Category"))
        first = str(row.get("First") or "").strip()
        last = str(row.get("Last") or "").strip()
        if not category or (not first and not last):
            continue
        entry = [
            first,
            last,
            str(row.get("Address") or "").strip(),
            str(row.get("City") or "").strip(),
            str(row.get("State") or "").strip(),
            str(row.get("Zip") or "").strip(),
            str(row.get("Phone") or "").strip(),
            str(row.get("Email") or "").strip(),
        ]
        if category == "new":
            grouped["donors_new"].append(entry)
        elif category == "existing":
            grouped["donors_existing"].append(entry)
        elif category == "increase":
            grouped["donors_increase"].append(entry)
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

    title_header = _find_csv_header(rows, DISCORD_POST_HEADER_ALIASES)
    message_header = _find_csv_header(rows, DISCORD_POST_MESSAGE_ALIASES)
    if not title_header or not message_header:
        logger.warning("[CONTENT] Discord posts rows require Title and Message columns.")
        return []

    items = []
    for row in rows:
        row = row or {}
        title = str(row.get(title_header) or "").strip()
        message = str(row.get(message_header) or "")
        if title:
            items.append([title, message])
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

    title_header = _find_csv_header(rows, SCREENSHOT_TITLE_HEADER_ALIASES)
    image_header = _find_csv_header(rows, SCREENSHOT_PATH_HEADER_ALIASES)
    if not title_header or not image_header:
        logger.warning("[CONTENT] Screenshot rows require Title and ImagePath columns.")
        return []

    items = []
    for row in rows:
        row = row or {}
        title = str(row.get(title_header) or "").strip()
        image_path = str(row.get(image_header) or "").strip()
        if title:
            items.append({"title": title, "image_url": image_path})
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
    return items


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
    defaults_dir = _resolve_defaults_dir()
    if not defaults_dir:
        logger.warning("[CONTENT] No backend/defaults directory found; using built-in defaults when needed")
        return {}

    logger.info("[CONTENT] Loading packaged defaults from %s", defaults_dir)
    loaded = {}

    def read_csv_file(filename):
        path = defaults_dir / filename
        if not path.is_file():
            logger.warning("[CONTENT] Missing local defaults file: %s", path)
            return None
        return _read_csv_rows(path.read_text(encoding="utf-8-sig"))

    def read_text_file(filename):
        path = defaults_dir / filename
        if not path.is_file():
            logger.warning("[CONTENT] Missing local defaults file: %s", path)
            return None
        return path.read_text(encoding="utf-8")

    try:
        rows = read_csv_file(DEFAULTS_FILE_MAP["callers"])
        if rows is not None:
            loaded.update(_normalize_callers(rows))
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


def _normalize_prompt_sheet_text(csv_text):
    rows = _read_csv_rows(csv_text)
    if _rows_have_headset_shape(rows):
        logger.warning("[CONTENT] Gemini prompt sheet has headset-like columns and was rejected.")
        return ""
    prompt_header = _find_csv_header(rows, {"prompt", "instruction", "instructions", "text", "markdown"})
    if not prompt_header:
        logger.warning("[CONTENT] Gemini prompt sheet requires a Prompt/Instruction/Text/Markdown column and was rejected.")
        return ""

    lines = []
    for row in rows:
        if not row:
            continue
        value = row.get(prompt_header)
        text = str(value or "").strip()
        if text:
            lines.append(text)

    if _values_look_like_headsets(lines):
        logger.warning("[CONTENT] Gemini prompt sheet produced headset-like values and was rejected.")
        return ""
    return "\n".join(lines).strip()


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
    "gemini_coaching_prompt": lambda csv_text: {"gemini_coaching_prompt": _normalize_prompt_sheet_text(csv_text)},
    "gemini_fail_prompt": lambda csv_text: {"gemini_fail_prompt": _normalize_prompt_sheet_text(csv_text)},
}


def _load_google_sheet_content(runtime_config):
    sheet_id = _resolve_content_sheet_id(runtime_config or {})
    if not sheet_id:
        return {}

    loaded = {}
    for content_key, tab_name in CONTENT_SHEET_TAB_MAP.items():
        try:
            csv_text = _fetch_google_sheet_tab_csv(sheet_id, tab_name)
            row_count = len(_read_csv_rows(csv_text))
            parsed = CONTENT_SHEET_PARSERS[content_key](csv_text)
            for key, value in parsed.items():
                if value:
                    loaded[key] = value
            if not any(parsed.values()):
                if row_count:
                    logger.warning(
                        "[CONTENT] Google Sheet tab '%s' has %d row(s) but produced no usable %s data — check tab columns; using local defaults",
                        tab_name,
                        row_count,
                        content_key,
                    )
                else:
                    logger.warning(
                        "[CONTENT] Google Sheet tab '%s' was empty; using local defaults for %s",
                        tab_name,
                        content_key,
                    )
        except Exception as exc:
            logger.warning("[CONTENT] Failed to load Google Sheet tab '%s'; using local defaults for %s: %s", tab_name, content_key, exc)
    return loaded

def _load_google_doc_overrides(runtime_config):
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
        "gemini_coaching_prompt": (
            ("admin_gemini_coaching_prompt_doc_url", "gemini_coaching_prompt_doc_url"),
            ("admin_gemini_coaching_prompt_doc_id", "gemini_coaching_prompt_doc_id"),
            "",
        ),
        "gemini_fail_prompt": (
            ("admin_gemini_fail_prompt_doc_url", "gemini_fail_prompt_doc_url"),
            ("admin_gemini_fail_prompt_doc_id", "gemini_fail_prompt_doc_id"),
            "",
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
        elif content_key in {"gemini_coaching_prompt", "gemini_fail_prompt"}:
            loaded[content_key] = text.strip()
        else:
            loaded[content_key] = text
    return loaded


def _load_external_content():
    runtime_config = _load_backend_runtime_config()
    local_content = _load_local_defaults_content()
    sheet_content = _load_google_sheet_content(runtime_config)
    doc_content = _load_google_doc_overrides(runtime_config)

    merged = {}
    for key, value in (local_content or {}).items():
        merged[key] = value
        _set_content_source(key, "local", value, ok=True)

    for key, value in (sheet_content or {}).items():
        merged[key] = value
        _set_content_source(key, "google", value, ok=True, detail="google_sheet")

    for key, value in (doc_content or {}).items():
        merged[key] = value
        _set_content_source(key, "google", value, ok=True, detail="google_doc")

    remote_keys = sorted(set(sheet_content.keys()) | set(doc_content.keys()))
    if remote_keys:
        logger.info("[CONTENT] Loaded remote admin overrides for: %s", ", ".join(remote_keys))
    return merged


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
    ["Pass", "**:tada: Congratulations! You passed your test calls! :tada:**\n- 24-48hrs to go live. Watch your inbox.\n- Log out of Call Corp and Simple Script.\n- Complete TLMS courses.\n- Remove extra mock shifts from Gateway.\n**Welcome to ACDD!**"],
    ["Fail", "Unfortunately I can't pass you today. Please reschedule in Gateway within 24 hours."],
    ["Fail Final", "Thank you for your time. Unfortunately you have exceeded the allowed Mock Call attempts. We wish you luck."],
    ["Incomplete", "Our time is up. We'll schedule another session for Supervisor Transfers.\nPlease give me a moment."],
    ["Ncns", "Candidate was a No Call / No Show for mock testing."],
    ["Sup Intro", "I'll help you complete the Supervisor Transfer test call. I'll provide instructions step by step. OK?"],
    ["Sup Instructions", "When you need to transfer:\n1) Ask in chat first\n2) Give CCM time to check\n3) When CCM says ok - let caller know you are transferring"],
    ["Sup Transfer", "1. Click Transfer in CC\n2. Select Queue > ACD Direct Supervisor\n3. Tell caller to hold, click Blind Transfer"],
    ["Sup Dte", "Change DTE to Ready (green)."],
    ["Sup Status", "I show Ready. Calling now."],
    ["Sup Transfer Now", "You may transfer the call now."],
    ["Sup Stars", "WXYZ Supervisor Test Call Being Queued"],
    ["Sup Disposition", "Click cancel (red phone), disposition as Test/Training.\nThen disposition in Call Corp."],
    ["Sup Retry", "Transfer was not successful. Review steps and let me know when ready."],
    ["Ran Out Of Time", "We have run out of time for today's session. I will need to schedule you for a Newbie Shift to complete the Supervisor Transfer portion."],
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

UPDATE_DOC_URL = "https://docs.google.com/document/d/1-eNbA4KriCkE8pKnnpj0FReUhUmMvTVjG8Y7B7ppu_A/export?format=txt"

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
    {"label": "Other"},
]

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
            "title": "Home Screen",
            "paragraphs": [
                "The Home screen is your dashboard. It shows your stats (Total Sessions, Pass Rate, NC/NS Rate) and recent sessions."
            ],
            "bullets": [
                "<b>Start New Session</b> — Begin a full mock call + supervisor transfer session",
                "<b>Supervisor Transfer Only</b> — Used when a candidate previously ran out of time and only needs supervisor transfers",
                "<b>Session History</b> — View all past sessions with search and detail views",
            ],
        },
        {
            "title": "The Basics Screen",
            "paragraphs": [
                "This is the first step in every session. You'll verify the candidate's setup.",
                "<b>Footer buttons:</b>",
            ],
            "bullets": [
                "<b>Tester Name</b> — Auto-filled from your settings",
                "<b>Candidate Name</b> — Type the candidate's full name (required)",
                "<b>Final Attempt</b> — Mark whether this is the candidate's last allowed mock session",
                "<b>Headset</b> — Must be USB with noise-cancelling microphone. If not, auto-fails",
                "<b>VPN</b> — If they have one, they must turn it off. If they can't, auto-fails",
                "<b>Browser</b> — Must be default, extensions off, pop-ups allowed",
                "<b style=\"color: var(--color-danger)\">NC/NS</b> — No Call / No Show. Instantly fails and goes to Review",
                "<b style=\"color: var(--color-danger)\">Not Ready</b> — Candidate wasn't prepared for the session",
                "<b style=\"color: var(--color-danger)\">Stopped Responding</b> — Candidate went silent in Discord",
                "<b>Tech Issue</b> — Opens the Technical Issues dialog for troubleshooting",
            ],
        },
        {
            "title": "Calls Screen (Up to 3)",
            "paragraphs": [
                "You'll grade up to 3 mock calls. The scenario card shows you exactly who to portray.",
                "<b>Routing logic:</b> 2 passes (1 New Donor + 1 Existing Member) → Sup Transfers. 2 fails → session ends. 1+1 → Call 3.",
            ],
            "bullets": [
                "<b>Call Setup</b> — Select Call Type, Show, Caller, and Donation from the dropdowns",
                "<b>Scenario Card</b> — Shows the caller's info, gift, and randomized variables (Phone Type, SMS, E-Newsletter, Shipping, CC Fee)",
                "<b>Regenerate</b> — Re-rolls the random scenario variables without changing the call data",
                "<b>Payment Simulation</b> — Shows the credit card and EFT info for the test call",
                "<b>Pass/Fail</b> — Click PASS or FAIL after the call",
                "<b>Coaching</b> — Select coaching checkboxes (required — if none selected, you'll be asked to confirm)",
                "<b>Fail Reasons</b> — If FAIL, you must select at least one fail reason",
            ],
        },
        {
            "title": "Supervisor Transfer Screen (Up to 2)",
            "paragraphs": [
                "Tests the candidate's ability to transfer to a supervisor. Same coaching/fail flow as calls."
            ],
            "bullets": [
                "Post \"WXYZ Supervisor Test Call Being Queued\" in Discord Stars channel",
                "Call the WXYZ number: <b>1-828-630-7006</b>",
                "Pass Transfer 1 → done (go to Review). Fail both → Newbie Shift.",
            ],
        },
        {
            "title": "Smart Resume for Supervisor Transfer Only",
            "paragraphs": [
                "The Smart Resume flow helps you continue a candidate into Supervisor Transfer when the mock calls were already completed in an earlier session."
            ],
            "bullets": [
                "<b>When it appears</b> — Click <b>Supervisor Transfer Only</b> from Home, then answer <b>Yes</b> when asked if you previously conducted the mock session for that candidate.",
                "<b>How it finds sessions</b> — The app looks through saved history for prior mock-call sessions tied to the current tester name in Settings. It only shows sessions that already have mock call results and have not already completed supervisor transfers.",
                "<b>What you’ll see</b> — If matching sessions exist, a resume picker opens so you can choose the right candidate. If none exist, the app tells you there are no resumable sessions for that tester.",
                "<b>How to continue</b> — Select the candidate, confirm the prompt, and the app restores the earlier Basics and mock-call data, then opens directly on <b>Supervisor Transfer #1</b>.",
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
                "<b>Add to Google Calendar</b> — Creates an event titled \"Supervisor Test Call - [Candidate Name]\"",
            ],
        },
        {
            "title": "Review Screen",
            "paragraphs": [
                "Final review of the session. The Pass/Fail/Incomplete banner is calculated automatically."
            ],
            "bullets": [
                "<b>Coaching Summary</b> — Generated from your coaching checkboxes (or Gemini AI if enabled)",
                "<b>Fail Summary</b> — Generated from fail reasons (N/A for passing sessions)",
                "<b>Copy</b> — Copies the summary text to your clipboard",
                "<b>Regenerate</b> — Rebuilds the summary from checkbox data",
                "<b>Fill Form</b> — Opens the Cert Form and maps session data to form fields",
                "<b>Save & Finish</b> — Saves to history and clears the session",
            ],
        },
        {
            "title": "Discord Post Panel",
            "paragraphs": [
                "Click \"Discord Post\" in the sidebar to open the panel with two tabs:"
            ],
            "bullets": [
                "<b>Templates</b> — Pre-written messages for Pass, Fail, Sup Intro, etc. Click \"Copy\" to copy to clipboard",
                "<b>Screenshots</b> — Welcome images that can be copied to clipboard for Discord. Click \"Copy Image\" to copy",
                "Both tabs are searchable",
            ],
        },
        {
            "title": "Tech Issue Button",
            "paragraphs": [
                "Available on every session screen. Opens a troubleshooting wizard:"
            ],
            "bullets": [
                "<b>Internet Speed</b> — Asks for speed test results. Below 25 Mbps down / 10 Mbps up = fail",
                "<b>Calls Won't Route</b> — Checks DTE status, then browser troubleshooting",
                "<b>No Script Pop</b> — Browser troubleshooting steps",
                "<b>Discord/Other</b> — Manual notes with resolution tracking",
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
                "<b>NC/NS</b> — No Call / No Show",
                "<b>Stopped Responding</b> — Candidate went silent in Discord",
                "<b>Not Ready</b> — Incorrect setup, can't log in",
                "<b>Wrong Headset</b> — Not USB or not noise-cancelling",
                "<b>VPN</b> — Using VPN and can't turn it off",
            ],
        },
    ],
    "integrations": [
        {
            "title": "Gemini AI — Smart Summaries",
            "paragraphs": [
                "When enabled, Gemini creates clean coaching and fail summaries from the coaching and fail reason checkboxes you selected during the session."
            ],
            "footer": "Gemini uses the session's coaching and fail selections to write a cleaner summary automatically when Review loads.",
        },
        {
            "title": "Google Calendar",
            "paragraphs": [
                "The \"Add to Google Calendar\" button on the Newbie Shift screen creates a calendar event. No setup needed — it uses a Google Calendar URL template."
            ],
        },
    ],
    "faq": [
        {"q": "What if the candidate stops responding?", "a": "Click the red \"Stopped Responding\" button. This instantly ends the session as a fail."},
        {"q": "What if the candidate has technical issues?", "a": "Click \"Tech Issue\". The app walks you through troubleshooting: check DTE status, clear browsing data, re-login."},
        {"q": "Can I go back and change something?", "a": "Yes — click \"Back\" on any screen. Your data is saved as you go."},
        {"q": "What if I forget to select coaching?", "a": "The app will ask you to confirm if you want to continue without coaching."},
        {"q": "How do I do a Supervisor Transfer ONLY session?", "a": "On the Home screen, click \"Supervisor Transfer Only\". This skips Mock Calls."},
        {"q": "What does \"Final Attempt\" mean?", "a": "Use this on The Basics screen when the candidate is on their last allowed attempt. The app uses it in the session flow and messaging."},
        {"q": "How does Smart Resume find a candidate for Supervisor Transfer Only?", "a": "It searches saved history for prior mock-call sessions that belong to the current tester, already have mock call results, and do not already have completed supervisor transfers."},
        {"q": "What if 2 calls fail?", "a": "The session ends immediately and goes to Review. They should reschedule within 24 hours."},
        {"q": "Where is my data stored?", "a": "In the app's local database."},
        {"q": "How do I customize the Discord templates?", "a": "Go to Settings → Discord tab. You can add, edit, and remove both message templates and screenshot images."},
        {"q": "Can I edit the caller data and shows?", "a": "Yes — go to Settings. The Call Types, Shows, Callers, and Sup Reasons tabs let you fully customize all scenario data."},
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

`gemini-coaching-prompt.md` and `gemini-fail-prompt.md` are editable local defaults for Gemini summary wording. They can also be overridden by Google Sheet tabs named `gemini-coaching-prompt` and `gemini-fail-prompt`, or by Google Docs configured with `admin_gemini_coaching_prompt_doc_url` and `admin_gemini_fail_prompt_doc_url`.
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
        if key not in _content_source_status:
            _set_content_source(key, "builtin", builtin_values.get(key, []), ok=True)


_record_builtin_sources()


def _log_content_source_summary():
    if not _content_source_status:
        return
    parts = [
        f"{key}={info.get('source', 'builtin')}({info.get('count', 0)})"
        for key, info in sorted(_content_source_status.items())
    ]
    logger.info("[CONTENT] Source summary — %s", ", ".join(parts))


_log_content_source_summary()

DEFAULT_SETTINGS = {
    "setup_complete": False,
    "tutorial_completed": False,
    "tester_name": "",
    "display_name": "",
    "form_fill_browser": "auto",
    "form_url": DEFAULT_FORM_URL,
    "cert_sheet_url": DEFAULT_CERT_SHEET_URL,
    "ticker_speed": "normal",
    "enable_sounds": True,
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
    return value


def _sanitize_discord_template_setting(value, source_label):
    if not isinstance(value, list):
        logger.warning("[CONTENT] %s discord_templates setting was not a list and was ignored. Using defaults.", source_label)
        return DEFAULT_SETTINGS["discord_templates"]
    rows = []
    for item in value:
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            title = str(item[0] or "").strip()
            message = str(item[1] or "")
        elif isinstance(item, dict):
            title = str(item.get("title") or item.get("Title") or item.get("trigger") or item.get("Trigger") or "").strip()
            message = str(item.get("message") or item.get("Message") or "")
        else:
            continue
        if title:
            rows.append([title, message])
    return rows


def _sanitize_screenshot_setting(value, source_label):
    if not isinstance(value, list):
        logger.warning("[CONTENT] %s discord_screenshots setting was not a list and was ignored. Using defaults.", source_label)
        return DEFAULT_SETTINGS["discord_screenshots"]
    items = []
    for item in value:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or item.get("Title") or "").strip()
        image_url = str(item.get("image_url") or item.get("ImagePath") or item.get("imagePath") or item.get("url") or "").strip()
        if title:
            items.append({"title": title, "image_url": image_url})
    return items


def _sanitize_content_setting(key, value, source_label):
    value = _sanitize_coaching_setting(key, value, source_label)
    value = _sanitize_fail_reason_setting(key, value, source_label)
    if key == "discord_templates":
        return _sanitize_discord_template_setting(value, source_label)
    if key == "discord_screenshots":
        return _sanitize_screenshot_setting(value, source_label)
    return value


def sanitize_settings(doc: Optional[dict]) -> dict:
    base = {key: value for key, value in DEFAULT_SETTINGS.items() if key not in ADMIN_ONLY_SETTINGS_KEYS}
    if doc:
        for key, value in doc.items():
            if key in ALLOWED_SETTINGS_KEYS or key in SENSITIVE_SETTINGS_KEYS:
                if key in DEFAULT_MANAGED_SETTINGS_KEYS and not doc.get(_managed_custom_flag(key)):
                    continue
                base[key] = _sanitize_content_setting(key, value, "saved")
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
    if coaching.get("Other") and notes:
        items.append(notes)
    return items


def _get_fail_items(data):
    if not data or data.get("result") != "Fail":
        return []
    items = []
    fails = data.get("fails", {})
    for key, checked in fails.items():
        if checked and key != "Other":
            items.append(key.lower())
    notes = data.get("fail_notes", "")
    if fails.get("Other") and notes:
        items.append(notes)
    return items


DISCORD_SCREENSHOT_SUMMARY_TEXT = (
    "Provided coaching using the standard screenshots and instructions in Discord chat."
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
    return f"{name} — {auto_fail}."


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


def _build_section_coaching_summary(section, label):
    result = (section or {}).get("result")
    if result not in {"Pass", "Fail"}:
        return ""

    coaching = (section or {}).get("coaching", {}) or {}
    coaching_items = _extract_coaching_summary_parts(section)
    coaching_notes = _normalize_notes_sentence((section or {}).get("coach_notes", "")) if coaching.get("Other") else ""
    has_discord_screenshot = _has_discord_screenshot_coaching(section)

    details = []
    if coaching_items:
        details.append("Coaching addressed " + _format_management_list(coaching_items) + ".")
    if has_discord_screenshot:
        details.append(DISCORD_SCREENSHOT_SUMMARY_TEXT)
    if coaching_notes:
        details.append(f"Coaching notes: {coaching_notes}.")
    if not details:
        details.append("No coaching items were selected for this portion of the session.")

    return f"{label} - {result.upper()} - {' '.join(details)}"


def _build_section_fail_summary(section, label):
    if (section or {}).get("result") != "Fail":
        return ""

    fails = (section or {}).get("fails", {}) or {}
    fail_items = _extract_fail_summary_parts(section)
    fail_notes = _normalize_notes_sentence((section or {}).get("fail_notes", "")) if fails.get("Other") else ""
    details = []

    if fail_items:
        details.append("Fail reasons: " + _format_management_list(fail_items) + ".")
    else:
        details.append("Fail reasons: N/A.")

    if fail_notes:
        details.append(f"Fail notes: {fail_notes}.")

    return f"{label} - FAIL - {' '.join(details)}"


def _is_fail_na(session):
    """Fail Summary is only for auto-fails or session-level mock-call failures."""
    if session.get("auto_fail_reason"):
        return False
    if session.get("supervisor_only", False):
        return True
    call_fails = sum(1 for i in range(1, 4) if (session.get(f"call_{i}") or {}).get("result") == "Fail")
    return call_fails < 2


def compute_final_status(session):
    auto_fail = session.get("auto_fail_reason")
    sup_only = session.get("supervisor_only", False)
    calls_passed = sum(1 for i in range(1, 4) if (session.get(f"call_{i}") or {}).get("result") == "Pass")
    sups_passed = sum(1 for i in range(1, 3) if (session.get(f"sup_transfer_{i}") or {}).get("result") == "Pass")
    newbie = session.get("newbie_shift_data")

    final_status = "Fail"
    if not auto_fail:
        if sup_only:
            if sups_passed >= 1:
                final_status = "Pass"
            elif newbie is not None:
                final_status = "Incomplete"
        elif calls_passed >= 2:
            if sups_passed >= 1:
                final_status = "Pass"
            elif newbie is not None:
                final_status = "Incomplete"

    return final_status


def normalize_history_status(entry):
    explicit_status = entry.get("status")
    if explicit_status in {"Pass", "Fail", "Incomplete", "NC/NS"}:
        return explicit_status

    explicit_final_status = entry.get("final_status")
    if explicit_final_status in {"Pass", "Fail", "Incomplete"}:
        return explicit_final_status

    computed_status = compute_final_status(entry)
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


def build_clean_coaching(session):
    auto_fail = session.get("auto_fail_reason")
    lines = []
    for i in range(1, 4):
        line = _build_section_coaching_summary(session.get(f"call_{i}"), f"Call {i}")
        if line:
            lines.append(line)
    for i in range(1, 3):
        line = _build_section_coaching_summary(
            session.get(f"sup_transfer_{i}"),
            f"Supervisor Transfer {i}",
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
        return "\n".join(lines)
    if auto_fail:
        return (
            "No coaching summary was generated before the session ended. "
            f"Session closed under the recorded auto-fail reason: {_sentence_case(auto_fail)}."
        )
    return "No coaching summary was generated because no coaching items were selected for this session."


def build_clean_fail(session):
    auto_fail = session.get("auto_fail_reason")
    if auto_fail:
        return (
            "Session Auto-Fail - FAIL - "
            f"Recorded auto-fail reason: {_sentence_case(auto_fail)}."
        )

    lines = []
    for i in range(1, 4):
        line = _build_section_fail_summary(session.get(f"call_{i}"), f"Call {i}")
        if line:
            lines.append(line)
    if lines:
        return "\n".join(lines)
    return "N/A"


DEFAULT_GEMINI_COACHING_PROMPT = (
    "You are writing an internal certification test call results summary for management. "
    "Based on the coaching checkboxes selected during the mock certification session, "
    "write a clear, concise, management-facing summary of what occurred during the test. "
    "The summary must be objective, professional, and suitable for internal documentation. "
    "Use the existing session-note line structure when possible, keeping each completed call "
    "or supervisor transfer management-facing and concise. "
    "Incorporate the selected coaching checklist items directly into the summary instead of "
    "generalizing vaguely. Reference the specific coached items in plain language. Do not "
    "address the candidate. Do not use second-person language such as 'you' or 'your'. Do "
    "not give advice or instructions such as 'should', 'try to', or 'remember to'. Describe "
    "the observed performance and the coaching provided during the session. If the selected "
    "coaching includes screenshots, Discord chat, or standard instructions, explicitly include "
    "management-facing wording equivalent to 'Provided coaching using the standard screenshots "
    "and instructions in Discord chat.' Do not invent any coaching item that was not selected."
)

DEFAULT_GEMINI_FAIL_PROMPT = (
    "You are writing an internal certification test call failure summary for management. "
    "Based on the fail reasons selected during the mock certification session, write a "
    "clear, concise, management-facing summary of why the candidate did not pass. The "
    "summary must be objective, professional, and suitable for internal documentation. "
    "Incorporate the selected fail checklist items directly into the summary instead of "
    "generalizing vaguely. Reference the specific fail reasons in plain language. Do not "
    "address the candidate. Do not use second-person language such as 'you' or 'your'. Do "
    "not give advice or instructions such as 'should', 'try to', or 'remember to'. State "
    "what occurred during the session and any additional contributing issues."
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


def _get_gemini_prompt(settings, prompt_type):
    if prompt_type == "fail":
        setting_key = "gemini_fail_prompt"
        fallback = DEFAULT_GEMINI_FAIL_PROMPT
    else:
        setting_key = "gemini_coaching_prompt"
        fallback = DEFAULT_GEMINI_COACHING_PROMPT

    saved_prompt = _clean_gemini_prompt_text((settings or {}).get(setting_key))
    if saved_prompt:
        return saved_prompt

    remote_or_local_prompt = _clean_gemini_prompt_text(EXTERNAL_CONTENT.get(setting_key))
    if remote_or_local_prompt:
        return remote_or_local_prompt

    return fallback

PREFERRED_GEMINI_TEXT_MODELS = (
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
)


def _extract_gemini_text(response):
    text = (getattr(response, "text", "") or "").strip()
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

@lru_cache(maxsize=8)
def _select_supported_gemini_model(api_key: str) -> str:
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
            return preferred_model

    discovered = ", ".join(sorted(supported.keys())) or "none"
    raise RuntimeError(
        "No supported Gemini text model was found for generateContent. "
        f"Available generateContent models for this API key: {discovered}"
    )


def _generate_gemini_summary(source_text, prompt_template, api_key, summary_type):
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
    prompt = (
        f"{prompt_template}\n\n"
        f"Session notes:\n{source_text}\n\n"
        "Return only the final summary text with no heading, markdown, or extra commentary."
    )
    response = model.generate_content(prompt)
    text = _extract_gemini_text(response)
    if not text:
        raise RuntimeError(f"Gemini returned an empty {summary_type} summary.")
    return text


def generate_summaries(session, api_key="", settings=None):
    auto_fail_summaries = _auto_fail_review_summaries(session)
    if auto_fail_summaries:
        return auto_fail_summaries

    coaching = build_clean_coaching(session)
    fail = "N/A" if _is_fail_na(session) else build_clean_fail(session)

    use_gemini = bool(settings and settings.get("enable_gemini"))
    if not use_gemini:
        return {"coaching": coaching, "fail": fail}
    api_key = (api_key or "").strip()
    if not api_key:
        return {
            "coaching": coaching,
            "fail": fail,
            "error": "Gemini is enabled, but no API key was provided. Using generic summaries instead.",
        }

    try:
        gemini_coaching = _generate_gemini_summary(
            coaching,
            _get_gemini_prompt(settings, "coaching"),
            api_key,
            "coaching",
        ) if coaching != "No coaching data recorded." else coaching

        gemini_fail = _generate_gemini_summary(
            fail,
            _get_gemini_prompt(settings, "fail"),
            api_key,
            "fail",
        ) if fail != "N/A" else fail

        return {"coaching": gemini_coaching, "fail": gemini_fail}
    except Exception as exc:
        logger.exception("[GEMINI] Summary generation failed: %s", exc)
        return {
            "coaching": coaching,
            "fail": fail,
            "error": f"Gemini summary generation failed: {exc}",
        }


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

    sup_only = session.get("supervisor_only", False)
    calls_passed = _count_results(session, "call", 3, "Pass")
    sups_passed = _count_results(session, "sup_transfer", 2, "Pass")

    mock_complete = "Yes" if sup_only or calls_passed >= 2 else "No"
    sup_complete = "Yes" if sups_passed >= 1 else "No"
    all_complete = "Yes" if mock_complete == "Yes" and sup_complete == "Yes" else "No"

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

    for i in range(1, 4):
        line = _build_section_coaching_summary(session.get(f"call_{i}"), f"Call {i}")
        if line:
            coaching_lines.append(line)
    for i in range(1, 3):
        line = _build_section_coaching_summary(session.get(f"sup_transfer_{i}"), f"Supervisor Transfer {i}")
        if line:
            coaching_lines.append(line)

    if auto_fail_type == "ncns":
        return {"coaching": "N/A", "fail": f"{name} was a NC/NS."}
    if auto_fail_type == "not_ready":
        return {"coaching": "N/A", "fail": f"{name} was not ready or prepared for the session."}
    if auto_fail_type == "headset":
        return {
            "coaching": f"{name} was informed that a USB headset with a noise-cancelling microphone is required to contract with ACD.",
            "fail": f"{name} was not using an approved USB headset with a noise-cancelling microphone.",
        }
    if auto_fail_type == "vpn":
        return {
            "coaching": f"{name} was informed that the use of a VPN is not acceptable when contracting with ACD.",
            "fail": f"{name} was using a VPN and was unable to turn it off.",
        }
    if auto_fail_type == "stopped":
        return {
            "coaching": "\n".join(coaching_lines) if coaching_lines else "N/A",
            "fail": f"{name} stopped responding.",
        }
    return {
        "coaching": "\n".join(coaching_lines) if coaching_lines else "N/A",
        "fail": _sentence_case(auto_fail_reason) + ".",
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
    if session.get("auto_fail_reason") or _is_form_fail_session(session):
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
        if updates or unsets:
            await db.settings.update_one({"_id": "app_settings"}, {"$set": updates, "$unset": unsets})
            logger.info(f"[STARTUP] Migrated settings: {list(updates.keys())}")
        for key in ("discord_templates", "discord_screenshots"):
            if key in existing and existing.get(_managed_custom_flag(key)):
                logger.info(
                    "[CONTENT] %s served from SQLite customized settings (%s item(s)); defaults source is %s (%s item(s))",
                    key,
                    _content_count(existing.get(key)),
                    (_content_source_status.get(key) or {}).get("source") or "builtin",
                    (_content_source_status.get(key) or {}).get("count") or 0,
                )
            elif key in existing:
                logger.info(
                    "[CONTENT] %s saved value has no customization marker and will follow %s defaults (%s item(s))",
                    key,
                    (_content_source_status.get(key) or {}).get("source") or "builtin",
                    (_content_source_status.get(key) or {}).get("count") or 0,
                )
    logger.info(f"[STARTUP] Mock Testing Suite v{APP_VERSION}")
    yield
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
    if (
        _admin_token_configured()
        and request.url.path.startswith("/api")
        and request.url.path not in AUTH_EXEMPT_PATHS
        and request.method.upper() not in {"OPTIONS"}
    ):
        _require_admin_token(request)
    return await call_next(request)


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
        unsets = {"donors_new": "", "donors_existing": "", "donors_increase": ""}
    else:
        updates = {}
        unsets = {section: "", _managed_custom_flag(section): ""}

    await db.settings.update_one({"_id": "app_settings"}, {"$set": updates, "$unset": unsets}, upsert=True)

    doc = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0})
    return {"ok": True, "section": section, "settings": sanitize_settings(doc)}


@api_router.get("/settings/defaults")
async def get_defaults():
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
        overrides = _load_google_doc_overrides(runtime_config) or {}
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
    final_status = doc.get("final_status") or compute_final_status(doc)
    timestamp_fields = _format_local_history_timestamp(datetime.now(timezone.utc))
    record = {
        **doc,
        **timestamp_fields,
        "candidate": doc.get("candidate_name", "Unknown"),
        "tester_name": doc.get("tester_name", ""),
        "final_status": final_status,
        "status": final_status,
    }
    await db.history.insert_one(record)
    db.backup("after-finish-session")
    await db.sessions.delete_one({"_id": "active_session"})
    return {"ok": True, "record": {k: v for k, v in record.items() if k != "_id"}}


@api_router.post("/session/discard")
async def discard_session(request: Request):
    await db.sessions.delete_one({"_id": "active_session"})
    return {"ok": True}


# ══════════════════════════════════════════════════════════════════
# HISTORY ROUTES
# ══════════════════════════════════════════════════════════════════
@api_router.get("/history")
async def get_history():
    docs = await db.history.find({}, {"_id": 0}).sort("timestamp", -1).to_list(500)
    for doc in docs:
        _normalize_history_timestamp(doc)
        normalized_status = normalize_history_status(doc)
        doc["status"] = normalized_status
        if normalized_status != "NC/NS":
            doc["final_status"] = doc.get("final_status") or normalized_status
    return docs


@api_router.get("/history/stats")
async def get_history_stats():
    docs = await db.history.find({}, {"_id": 0}).to_list(5000)
    total = len(docs)
    normalized_statuses = [normalize_history_status(doc) for doc in docs]
    passes = sum(1 for status in normalized_statuses if status == "Pass")
    fails = sum(1 for status in normalized_statuses if status == "Fail")
    ncns = sum(1 for status in normalized_statuses if status == "NC/NS")
    incomplete = sum(1 for status in normalized_statuses if status == "Incomplete")
    pass_rate = round((passes / total * 100) if total > 0 else 0, 1)
    return {"total": total, "passes": passes, "fails": fails, "ncns": ncns, "incomplete": incomplete, "pass_rate": pass_rate}


@api_router.delete("/history")
async def clear_history(request: Request):
    db.backup("before-clear-history")
    await db.history.delete_many({})
    return {"ok": True}

# ══════════════════════════════════════════════════════════════════
# TICKER / NOTIFICATIONS (fetches from admin-configured Google Sheet, falls back to cache/defaults)
# ══════════════════════════════════════════════════════════════════
NOTIFICATION_CACHE_TTL_SECONDS = 25

_ticker_cache = {"messages": None, "last_fetch": 0, "using_fallback": False}
_headset_cache = {"groups": None, "last_fetch": 0}
_notification_cache = {"groups": None, "last_fetch": 0, "url": ""}

_notification_defaults = {
    "tickerMessages": [],
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
    return str(value or "").strip().lower() in {"true", "1", "yes", "y", "on"}


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
        "Enabled": item.get("Enabled") if isinstance(item.get("Enabled"), bool) else _normalize_notification_bool(item.get("Enabled")) or str(item.get("Enabled")).strip() == "",
        "ID": _normalize_notification_text(item.get("ID")),
        "Type": normalized_type,
        "Title": _normalize_notification_text(item.get("Title")),
        "Message": _normalize_notification_text(item.get("Message")),
        "ShowTicker": item.get("ShowTicker") if isinstance(item.get("ShowTicker"), bool) else (_normalize_notification_bool(item.get("ShowTicker")) or (_normalize_notification_text(item.get("ShowTicker")) == "" and legacy_ticker_type)),
        "ShowPopup": item.get("ShowPopup") if isinstance(item.get("ShowPopup"), bool) else _normalize_notification_bool(item.get("ShowPopup")),
        "ShowBanner": item.get("ShowBanner") if isinstance(item.get("ShowBanner"), bool) else _normalize_notification_bool(item.get("ShowBanner")),
        "Persistent": item.get("Persistent") if isinstance(item.get("Persistent"), bool) else _normalize_notification_bool(item.get("Persistent")),
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
        "ShowPopup": _notification_cell(row, "show popup", "showpopup"),
        "ShowTicker": _notification_cell(row, "show ticker", "showticker"),
        "ShowBanner": _notification_cell(row, "show banner", "showbanner"),
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
    return {"ready": True, "credentials_path": str(creds_path)}


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
        return {"ok": True, "service": service}
    except Exception as exc:
        return {"ok": False, "error": f"Unable to initialize Google Sheets service account credentials: {exc}"}


def _load_notification_items_from_google_sheets_api():
    config = _get_admin_notification_sheet_config()
    service_result = _get_notification_sheet_service()
    if not service_result.get("ok"):
        return service_result

    try:
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

        return {"ok": True, "items": items, "sheetTitle": sheet_title}
    except Exception as exc:
        logger.warning("[NOTIFICATIONS] Authenticated Google Sheets read failed: %s", exc)
        return {"ok": False, "error": f"Authenticated Google Sheets read failed: {exc}"}


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

    config = _get_admin_notification_sheet_config()
    sheet_id = config["sheet_id"]
    target_gid = str(config["gid"] or "0")
    service_result = _get_notification_sheet_service()
    if not service_result.get("ok"):
        return {"ok": False, "error": service_result.get("error") or "Direct Google Sheets write is not configured."}

    try:
        from googleapiclient.errors import HttpError
    except Exception as exc:
        return {"ok": False, "error": f"Google Sheets dependencies are unavailable: {exc}"}

    try:
        sheets_api = service_result["service"].spreadsheets()

        metadata = sheets_api.get(spreadsheetId=sheet_id).execute()
        sheets = metadata.get("sheets", [])
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
        quoted_title = _quote_sheet_title_for_a1(sheet_title)
        last_column = _column_letter(len(NOTIFICATION_SHEET_COLUMNS))
        header_range = f"{quoted_title}!A1:{last_column}1"
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
            sheets_api.values().update(
                spreadsheetId=sheet_id,
                range=header_range,
                valueInputOption="USER_ENTERED",
                body={"values": [expected_header]},
            ).execute()

        data_range = f"{quoted_title}!A2:{last_column}"
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
            sheets_api.values().update(
                spreadsheetId=sheet_id,
                range=f"{quoted_title}!A{target_row_number}:{last_column}{target_row_number}",
                valueInputOption="USER_ENTERED",
                body={"values": [row_values]},
            ).execute()
            action = "updated"
        else:
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
        }
    except HttpError as exc:
        message = str(exc)
        if "PERMISSION_DENIED" in message or "The caller does not have permission" in message:
            return {
                "ok": False,
                "error": (
                    "Google Sheets rejected the write request. Confirm the service account JSON is valid, "
                    "the Google Sheets API is enabled, and the spreadsheet is shared with the service account email."
                ),
            }
        return {"ok": False, "error": f"Google Sheets write failed: {message}"}
    except Exception as exc:
        logger.exception("[NOTIFICATIONS] Failed to write notification to Google Sheets: %s", exc)
        return {"ok": False, "error": f"Google Sheets write failed: {exc}"}


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
    import time

    config = _get_admin_notification_sheet_config()
    sheet_url = config["export_url"]
    if not sheet_url:
        logger.warning("[NOTIFICATIONS] No admin notification sheet URL is configured. Using cached/default notifications.")
        _set_ticker_fetch_status("builtin", "missing notification sheet URL", 0)
        if _notification_cache["groups"] is not None:
            return _notification_cache["groups"]
        return _notification_defaults

    now = time.time()
    if (
        _notification_cache["groups"] is not None
        and _notification_cache["url"] == sheet_url
        and (now - _notification_cache["last_fetch"]) < NOTIFICATION_CACHE_TTL_SECONDS
    ):
        return _notification_cache["groups"]

    try:
        logger.info(
            "[NOTIFICATIONS] Loading notification sheet from %s URL %s",
            config.get("source") or "unknown",
            _mask_config_value(config.get("url")),
        )
        if _get_notification_sheet_write_status().get("ready"):
            authenticated = _load_notification_items_from_google_sheets_api()
            if authenticated.get("ok"):
                groups = _group_notification_manager_items(authenticated.get("items", []))
                _notification_cache["groups"] = groups
                _notification_cache["last_fetch"] = now
                _notification_cache["url"] = sheet_url
                logger.info(
                    "[NOTIFICATIONS] Loaded %s ticker, %s banner, %s popup items from admin sheet via authenticated Sheets API",
                    len(groups["tickerMessages"]),
                    len(groups["banners"]),
                    len(groups["popups"]),
                )
                _set_ticker_fetch_status("google", "authenticated Sheets API read succeeded", len(groups["tickerMessages"]))
                return groups
            logger.warning("[NOTIFICATIONS] %s", authenticated.get("error") or "Authenticated Google Sheets read failed.")

        async with httpx.AsyncClient(timeout=10) as client:
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
                        "[NOTIFICATIONS] %s. Using built-in fallback ticker. URL=%s",
                        reason,
                        _mask_config_value(sheet_url),
                    )
                    _set_ticker_fetch_status("builtin", reason, 0)
                else:
                    groups = _parse_notification_csv(resp.text)
                    _notification_cache["groups"] = groups
                    _notification_cache["last_fetch"] = now
                    _notification_cache["url"] = sheet_url
                    logger.info(
                        "[NOTIFICATIONS] Loaded %s ticker, %s banner, %s popup items from admin sheet",
                        len(groups["tickerMessages"]),
                        len(groups["banners"]),
                        len(groups["popups"]),
                    )
                    _set_ticker_fetch_status("google", "public CSV read succeeded", len(groups["tickerMessages"]))
                    return groups
            else:
                reason = f"public CSV request returned status {resp.status_code}"
                logger.warning("[NOTIFICATIONS] Notification sheet request returned status %s. Using cached/default notifications.", resp.status_code)
                _set_ticker_fetch_status("builtin", reason, 0)
    except Exception as exc:
        logger.warning("[NOTIFICATIONS] Failed to fetch notification sheet: %s", exc)
        _set_ticker_fetch_status("builtin", f"Google notification fetch failed: {exc}", 0)

    if _notification_cache["groups"] is not None:
        logger.info("[NOTIFICATIONS] Reusing last cached notification payload after fetch failure.")
        _set_ticker_fetch_status("local", "reusing cached notification payload after Google fetch failure", len(_notification_cache["groups"].get("tickerMessages", [])))
        return _notification_cache["groups"]
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
            _set_ticker_fetch_status("local", _ticker_fetch_status.get("status") or "ticker loaded from cached/local notifications", len(messages))
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
    _set_ticker_fetch_status("builtin", f"{previous_status}; no active ticker rows; using built-in fallback", len(TICKER_MESSAGES))
    return {
        "messages": TICKER_MESSAGES,
        "source": "builtin",
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


@api_router.get("/notifications/manage")
async def get_notifications_manage(request: Request):
    _require_admin_token(request)
    config = _get_admin_notification_sheet_config()
    write_status = _get_notification_sheet_write_status()
    response = {
        "ok": True,
        "items": [],
        "sheet": {
            "configured": bool(config["url"]),
            "url": config["url"],
            "sheetId": config["sheet_id"],
            "gid": config["gid"],
        },
        "write": {
            "ready": bool(write_status.get("ready")),
            "error": write_status.get("error", ""),
        },
    }

    if not config["export_url"]:
        response["ok"] = False
        response["error"] = "No notification sheet URL is configured in backend/config/runtime_config.json."
        return response

    if write_status.get("ready"):
        authenticated = _load_notification_items_from_google_sheets_api()
        if authenticated.get("ok"):
            response["items"] = authenticated.get("items", [])
            return response
        response["ok"] = False
        response["error"] = authenticated.get("error") or "Unable to read notification sheet with the configured service account."
        return response

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(config["export_url"], follow_redirects=True)
            if resp.status_code == 200:
                response["items"] = _parse_notification_items(resp.text)
                return response
            response["ok"] = False
            response["error"] = f"Notification sheet read failed with status {resp.status_code}."
            return response
    except Exception as exc:
        response["ok"] = False
        response["error"] = f"Unable to read notification sheet: {exc}"
        return response


@api_router.post("/notifications/manage")
async def save_notification_manage(payload: dict, request: Request):
    _require_admin_token(request)
    result = _save_notification_to_google_sheet((payload or {}).get("item") or payload or {})
    return result


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


@api_router.get("/headsets")
async def get_approved_headsets():
    groups, error = await _fetch_approved_headsets()
    return {"groups": groups, "error": error}


# ══════════════════════════════════════════════════════════════════
# GEMINI / SUMMARIES
# ══════════════════════════════════════════════════════════════════
@api_router.post("/gemini/summaries")
async def gen_summaries(payload: dict):
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if not doc:
        return {"coaching": "No active session.", "fail": "No active session."}
    settings = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0})
    payload_api_key = str((payload or {}).get("api_key") or "").strip()
    if _is_masked_sensitive_placeholder(payload_api_key):
        payload_api_key = ""
    api_key = payload_api_key or _get_stored_gemini_api_key(settings)
    result = generate_summaries(doc, api_key, settings)
    return result


@api_router.post("/gemini/regenerate")
async def regen_summary(payload: dict):
    summary_type = payload.get("type", "coaching")
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if not doc:
        return {"ok": False, "error": "No active session"}
    settings = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0})
    payload_api_key = str((payload or {}).get("api_key") or "").strip()
    if _is_masked_sensitive_placeholder(payload_api_key):
        payload_api_key = ""
    api_key = payload_api_key or _get_stored_gemini_api_key(settings)
    result = generate_summaries(doc, api_key, settings)
    if result.get("error"):
        return {"ok": False, "error": result["error"], "text": result.get(summary_type, "")}
    return {"ok": True, "text": result.get(summary_type, "")}


# ══════════════════════════════════════════════════════════════════
# FINISH SESSION (orchestrator)
# ══════════════════════════════════════════════════════════════════
@api_router.post("/finish-session")
async def finish_all(payload: dict, request: Request):
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if not doc:
        return {"ok": False, "error": "No active session"}
    final_status = doc.get("final_status") or compute_final_status(doc)
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
    }

    await db.history.insert_one(record)
    await db.sessions.delete_one({"_id": "active_session"})
    db.backup("after-finish-session")
    return {"ok": True, "message": "Session saved successfully!"}


# ══════════════════════════════════════════════════════════════════
# UPDATE / FORM (stubs)
# ══════════════════════════════════════════════════════════════════
@api_router.get("/update")
async def check_update():
    return {"update_available": False, "current_version": APP_VERSION}


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


@api_router.get("/runtime/verify-token")
async def verify_runtime_token(request: Request):
    _require_admin_token(request)
    return {"ok": True, "version": APP_VERSION}


app.include_router(api_router)

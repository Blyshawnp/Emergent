"""
Mock Testing Suite — FastAPI Backend
All routes in a single file for simplicity. Uses SQLite for local persistence.
"""
import os
import json
import sys
import logging
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager
from functools import lru_cache
from zoneinfo import ZoneInfo
from urllib.parse import quote, urlparse
from urllib.request import urlopen

from fastapi import FastAPI, APIRouter
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
        values = update.get("$set", update)
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
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._initialize_schema()
        self.settings = SQLiteCollection(self, "settings")
        self.sessions = SQLiteCollection(self, "sessions")
        self.history = SQLiteCollection(self, "history")
        logger.info("[STARTUP] SQLite database: %s", self.path)

    def _initialize_schema(self):
        with self.lock, self.conn:
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

    def close(self):
        with self.lock:
            self.conn.close()


db = SQLiteDocumentStore(_resolve_sqlite_path())


def _content_file_candidates():
    candidates = []
    resources_root = (os.getenv("APP_RESOURCES_PATH") or "").strip()
    if resources_root:
        candidates.append(Path(resources_root) / "backend" / "content" / "app_content.json")
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent / "content" / "app_content.json")
    candidates.append(ROOT_DIR / "content" / "app_content.json")
    return candidates


CONTENT_SHEET_TAB_MAP = {
    "call_types": "call-types",
    "sup_reasons": "sup-reasons",
    "shows": "shows",
    "donors_new": "callers-new",
    "donors_existing": "callers-existing",
    "donors_increase": "callers-increase",
    "discord_templates": "discord-posts",
    "discord_screenshots": "screenshots",
    "call_coaching": "call-coaching",
    "call_fails": "call-fails",
    "sup_coaching": "sup-coaching",
    "sup_fails": "sup-fails",
    "approved_headsets": "approved-headsets",
}


def _runtime_config_candidates():
    candidates = []
    resources_root = (os.getenv("APP_RESOURCES_PATH") or "").strip()
    if resources_root:
        candidates.append(Path(resources_root) / "backend" / "config" / "runtime_config.json")
    if getattr(sys, "frozen", False):
        candidates.append(Path(sys.executable).resolve().parent / "config" / "runtime_config.json")
    candidates.append(ROOT_DIR / "config" / "runtime_config.json")
    return candidates


def _load_external_content():
    local_content = {}
    for candidate in _content_file_candidates():
        try:
            if candidate.is_file():
                with candidate.open("r", encoding="utf-8") as f:
                    local_content = json.load(f)
                logger.info("[CONTENT] Loaded editable content from %s", candidate)
                break
        except Exception as exc:
            logger.warning("[CONTENT] Failed to load %s: %s", candidate, exc)

    sheet_content = _load_google_sheet_content(_load_backend_runtime_config())
    if sheet_content:
        merged = {**local_content, **sheet_content}
        logger.info("[CONTENT] Loaded Google Sheet overrides for: %s", ", ".join(sorted(sheet_content.keys())))
        return merged

    if local_content:
        return local_content

    logger.info("[CONTENT] Using built-in content defaults")
    return {}


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
    ]

    for candidate in candidates:
        sheet_id = _extract_google_sheet_id(candidate)
        if sheet_id:
            return sheet_id
    return ""


def _fetch_google_sheet_tab_csv(sheet_id, tab_name):
    encoded_tab_name = quote(tab_name, safe="")
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/gviz/tq?tqx=out:csv&sheet={encoded_tab_name}"
    with urlopen(url, timeout=10) as response:
        return response.read().decode("utf-8-sig")


def _parse_google_sheet_text_list(csv_text):
    reader = csv.DictReader(io.StringIO(csv_text or ""))
    items = []
    for row in reader:
        if not isinstance(row, dict):
            continue
        values = [str(value or "").strip() for value in row.values()]
        first_value = next((value for value in values if value), "")
        if first_value:
            items.append(first_value)
    return items


def _parse_google_sheet_shows(csv_text):
    reader = csv.DictReader(io.StringIO(csv_text or ""))
    items = []
    for row in reader:
        show_name = str((row or {}).get("ShowName") or "").strip()
        if not show_name:
            continue
        items.append([
            show_name,
            str((row or {}).get("OneTimeAmount") or "").strip(),
            str((row or {}).get("MonthlyAmount") or "").strip(),
            str((row or {}).get("Gift") or "").strip(),
        ])
    return items


def _parse_google_sheet_callers(csv_text):
    reader = csv.DictReader(io.StringIO(csv_text or ""))
    items = []
    for row in reader:
        first = str((row or {}).get("First") or "").strip()
        last = str((row or {}).get("Last") or "").strip()
        if not first and not last:
            continue
        items.append([
            first,
            last,
            str((row or {}).get("Address") or "").strip(),
            str((row or {}).get("City") or "").strip(),
            str((row or {}).get("State") or "").strip(),
            str((row or {}).get("Zip") or "").strip(),
            str((row or {}).get("Phone") or "").strip(),
            str((row or {}).get("Email") or "").strip(),
        ])
    return items


def _parse_google_sheet_discord_posts(csv_text):
    reader = csv.DictReader(io.StringIO(csv_text or ""))
    items = []
    for row in reader:
        title = str((row or {}).get("Title") or "").strip()
        message = str((row or {}).get("Message") or "")
        if title:
            items.append([title, message])
    return items


def _parse_google_sheet_screenshots(csv_text):
    reader = csv.DictReader(io.StringIO(csv_text or ""))
    items = []
    for row in reader:
        title = str((row or {}).get("Title") or "").strip()
        image_path = str((row or {}).get("ImagePath") or "").strip()
        if title:
            items.append({"title": title, "image_url": image_path})
    return items


def _parse_google_sheet_coaching(csv_text, include_ids):
    reader = csv.DictReader(io.StringIO(csv_text or ""))
    items = []
    for row in reader:
        label = str((row or {}).get("Label") or "").strip()
        if not label:
            continue
        item = {"label": label}
        helper = str((row or {}).get("Helper") or "").strip()
        children = [
            child.strip()
            for child in str((row or {}).get("ChildrenPipeDelimited") or "").split("|")
            if child.strip()
        ]
        if include_ids:
            item["id"] = str((row or {}).get("ID") or "").strip()
        if helper:
            item["helper"] = helper
        if children:
            item["children"] = children
        items.append(item)
    return items


def _parse_google_sheet_approved_headsets(csv_text):
    reader = csv.DictReader(io.StringIO(csv_text or ""))
    grouped = {}
    order = []
    ignored_brands = {"source note", "source url", "example"}

    for row in reader:
        brand = str((row or {}).get("Brand") or "").strip()
        model = str((row or {}).get("Model") or "").strip()
        if not brand or brand.lower() in ignored_brands or not model:
            continue
        if brand not in grouped:
            grouped[brand] = []
            order.append(brand)
        if model not in grouped[brand]:
            grouped[brand].append(model)

    return [{"brand": brand, "models": grouped[brand]} for brand in order if grouped[brand]]


CONTENT_SHEET_PARSERS = {
    "call_types": lambda csv_text: _parse_google_sheet_text_list(csv_text),
    "sup_reasons": lambda csv_text: _parse_google_sheet_text_list(csv_text),
    "shows": _parse_google_sheet_shows,
    "donors_new": _parse_google_sheet_callers,
    "donors_existing": _parse_google_sheet_callers,
    "donors_increase": _parse_google_sheet_callers,
    "discord_templates": _parse_google_sheet_discord_posts,
    "discord_screenshots": _parse_google_sheet_screenshots,
    "call_coaching": lambda csv_text: _parse_google_sheet_coaching(csv_text, include_ids=True),
    "call_fails": lambda csv_text: _parse_google_sheet_text_list(csv_text),
    "sup_coaching": lambda csv_text: _parse_google_sheet_coaching(csv_text, include_ids=False),
    "sup_fails": lambda csv_text: _parse_google_sheet_text_list(csv_text),
    "approved_headsets": _parse_google_sheet_approved_headsets,
}


def _load_google_sheet_content(runtime_config):
    sheet_id = _resolve_content_sheet_id(runtime_config or {})
    if not sheet_id:
        return {}

    loaded = {}
    for content_key, tab_name in CONTENT_SHEET_TAB_MAP.items():
        try:
            csv_text = _fetch_google_sheet_tab_csv(sheet_id, tab_name)
            parsed = CONTENT_SHEET_PARSERS[content_key](csv_text)
            if parsed:
                loaded[content_key] = parsed
            else:
                logger.warning("[CONTENT] Google Sheet tab '%s' was empty or produced no rows; using local defaults for %s", tab_name, content_key)
        except Exception as exc:
            logger.warning("[CONTENT] Failed to load Google Sheet tab '%s'; using local defaults for %s: %s", tab_name, content_key, exc)
    return loaded


@lru_cache(maxsize=1)
def _load_backend_runtime_config():
    for candidate in _runtime_config_candidates():
        try:
            if candidate.is_file():
                with candidate.open("r", encoding="utf-8") as f:
                    data = json.load(f)
                logger.info("[CONFIG] Loaded backend runtime config from %s", candidate)
                return data
        except Exception as exc:
            logger.warning("[CONFIG] Failed to load %s: %s", candidate, exc)
    logger.info("[CONFIG] No backend runtime config found")
    return {}


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

TICKER_DOC_URL = "https://docs.google.com/document/d/1kRJMSd-1qK3qU6jDYr30HeNglrqTiF0tF5fiYEhpP80/export?format=txt"
UPDATE_DOC_URL = "https://docs.google.com/document/d/1-eNbA4KriCkE8pKnnpj0FReUhUmMvTVjG8Y7B7ppu_A/export?format=txt"
APPROVED_HEADSETS_DOC_ID = "1HXdvhOLKjoA5YDznJRtFuEZfKFU2CDNDiEp-Vn4fE2o"
APPROVED_HEADSETS_DOC_URL = f"https://docs.google.com/document/d/{APPROVED_HEADSETS_DOC_ID}/export?format=txt"

DEFAULT_FORM_URL = "https://forms.office.com/pages/responsepage.aspx?id=3KFHNUeYz0mR2noZwaJeQnNAxP4sz6FBkEyNHMuYWT1URDZKWk1RWDU2VjRLTEZKNUxCWU1RRFlUVS4u&route=shorturl"

DISCORD_SCREENSHOTS = [
    {"title": "Welcome New Agent", "image_url": "/welcome-new-agent.png"},
    {"title": "Welcome to Stars", "image_url": "/welcome-to-stars.png"},
]

CALL_COACHING = [
    {"id": "c-show-app", "label": "Show appreciation", "children": ["For Current/Existing Donors", "After donation amount is given"]},
    {"id": "c-phonetics", "label": "Phonetics table provided to candidate"},
    {"id": "c-dontask", "label": "Don't Ask, Just Verify Address and Phone Number", "helper": "Existing member already provided address and phone number"},
    {"id": "c-verify", "label": "Verification", "children": ["Name", "Address", "Phone", "Email", "Card/EFT", "Phonetics for Sound Alike Letters"]},
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

if isinstance(EXTERNAL_CONTENT.get("help"), dict) and EXTERNAL_CONTENT["help"]:
    HELP_CONTENT = EXTERNAL_CONTENT["help"]

DEFAULT_SETTINGS = {
    "setup_complete": False,
    "tutorial_completed": False,
    "tester_name": "",
    "display_name": "",
    "form_fill_browser": "auto",
    "form_url": DEFAULT_FORM_URL,
    "cert_sheet_url": DEFAULT_CERT_SHEET_URL,
    "notification_sheet_url": DEFAULT_NOTIFICATION_SHEET_URL,
    "ticker_speed": "normal",
    "enable_sounds": True,
    "theme": "dark",
    "enable_gemini": True,
    "gemini_key": "",
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

SENSITIVE_SETTINGS_KEYS = set()
ADMIN_ONLY_SETTINGS_KEYS = {"notification_sheet_url"}
ALLOWED_SETTINGS_KEYS = set(DEFAULT_SETTINGS.keys()) - ADMIN_ONLY_SETTINGS_KEYS
PRESERVED_SETTINGS_KEYS_ON_RESTORE = {"setup_complete", "tutorial_completed"}


def sanitize_settings(doc: Optional[dict]) -> dict:
    base = {key: value for key, value in DEFAULT_SETTINGS.items() if key not in ADMIN_ONLY_SETTINGS_KEYS}
    if doc:
        for key, value in doc.items():
            if key in ALLOWED_SETTINGS_KEYS or key in SENSITIVE_SETTINGS_KEYS:
                base[key] = value
    for key in SENSITIVE_SETTINGS_KEYS:
        base[key] = ""
        base[f"{key}_configured"] = bool(doc and doc.get(key))
    return base


def normalize_settings_payload(payload: dict) -> dict:
    sanitized = {}

    for key, value in payload.items():
        if key not in ALLOWED_SETTINGS_KEYS:
            continue

        if key in SENSITIVE_SETTINGS_KEYS:
            if isinstance(value, str) and not value.strip():
                continue
            sanitized[key] = value
            continue

        sanitized[key] = value

    return sanitized


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
    if notes:
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
    if notes:
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
    """Gather fail reason lines from calls and supervisor transfers."""
    lines = []
    for i in range(1, 4):
        call = session.get(f"call_{i}")
        if not call or call.get("result") != "Fail":
            continue
        reasons = _get_fail_items(call)
        reasons_str = ", ".join(reasons) if reasons else "unspecified"
        lines.append(f"Call {i} ({call.get('type', 'Unknown type')}) failed: {reasons_str}.")
    for i in range(1, 3):
        sup = session.get(f"sup_transfer_{i}")
        if not sup or sup.get("result") != "Fail":
            continue
        reasons = _get_fail_items(sup)
        reasons_str = ", ".join(reasons) if reasons else "unspecified"
        lines.append(f"Supervisor Transfer {i} failed: {reasons_str}.")
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
    return _looks_like_discord_screenshot_coaching(notes)


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
    return parts


def _extract_fail_summary_parts(section):
    fails = (section or {}).get("fails", {}) or {}
    parts = []
    for key, checked in fails.items():
        if checked and key:
            parts.append(str(key).strip())
    return _dedupe_preserve_order(parts)


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
    for i in range(1, 3):
        items.extend(_get_fail_items(session.get(f"sup_transfer_{i}") or {}))
    return _dedupe_preserve_order(items)


def _build_section_coaching_summary(section, label):
    result = (section or {}).get("result")
    if result not in {"Pass", "Fail"}:
        return ""

    coaching_items = _extract_coaching_summary_parts(section)
    coaching_notes = _normalize_notes_sentence((section or {}).get("coach_notes", ""))
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

    fail_items = _extract_fail_summary_parts(section)
    fail_notes = _normalize_notes_sentence((section or {}).get("fail_notes", ""))
    details = []

    if fail_items:
        details.append("Fail reasons: " + _format_management_list(fail_items) + ".")
    else:
        details.append("Fail reasons: N/A.")

    if fail_notes:
        details.append(f"Fail notes: {fail_notes}.")

    return f"{label} - FAIL - {' '.join(details)}"


def _is_fail_na(session):
    """Determine whether the fail summary should be N/A (passing/incomplete sessions)."""
    if session.get("auto_fail_reason"):
        return False
    sup_only = session.get("supervisor_only", False)
    calls_passed = sum(1 for i in range(1, 4) if (session.get(f"call_{i}") or {}).get("result") == "Pass")
    sups_passed = sum(1 for i in range(1, 3) if (session.get(f"sup_transfer_{i}") or {}).get("result") == "Pass")
    newbie = session.get("newbie_shift_data")
    if sup_only:
        return sups_passed >= 1
    return calls_passed >= 2 and (sups_passed >= 1 or newbie)


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
    for i in range(1, 3):
        line = _build_section_fail_summary(
            session.get(f"sup_transfer_{i}"),
            f"Supervisor Transfer {i}",
        )
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
            DEFAULT_GEMINI_COACHING_PROMPT,
            api_key,
            "coaching",
        ) if coaching != "No coaching data recorded." else coaching

        gemini_fail = _generate_gemini_summary(
            fail,
            DEFAULT_GEMINI_FAIL_PROMPT,
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
    newbie = session.get("newbie_shift_data")
    calls_passed = _count_results(session, "call", 3, "Pass")
    calls_failed = _count_results(session, "call", 3, "Fail")
    sups_passed = _count_results(session, "sup_transfer", 2, "Pass")
    sups_failed = _count_results(session, "sup_transfer", 2, "Fail")
    sup_attempts = sups_passed + sups_failed
    final_status = compute_final_status(session)
    tech_issue = _map_tech_issue_for_form(session)
    summaries = generate_summaries(session)

    auto_fail_flags = _auto_fail_completion_flags(session)
    if auto_fail_flags:
        mock_complete = auto_fail_flags["mock_complete"]
        sup_complete = auto_fail_flags["sup_complete"]
        all_complete = auto_fail_flags["all_complete"]
    else:
        mock_complete = "Yes" if sup_only else "No"
        if not sup_only and (calls_passed >= 2 or calls_failed >= 2):
            mock_complete = "Yes"

        sup_complete = "No"
        if not newbie:
            if sup_only:
                sup_complete = "Yes" if sups_passed >= 1 else "No"
            elif sups_passed >= 1 or sups_failed >= 2:
                sup_complete = "Yes"

        if sup_only:
            all_complete = "Yes" if not newbie and sups_passed >= 1 else "No"
        else:
            all_complete = "Yes" if not newbie and final_status in {"Pass", "Fail"} else "No"

    fail_reason = "N/A"
    if session.get("auto_fail_reason") or _is_form_fail_session(session):
        fail_reason = (fail_summary or "").strip() or summaries["fail"]

    return {
        "tester_name": (session.get("tester_name") or settings.get("tester_name") or settings.get("display_name") or "").strip(),
        "candidate_name": (session.get("candidate_name") or session.get("candidate") or "").strip(),
        "skills": ["Supervisor Transfer"] if sup_only else ["Mock Calls", "Supervisor Transfer"],
        "mock_complete": mock_complete,
        "sup_complete": sup_complete,
        "all_complete": all_complete,
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
        await db.settings.insert_one({"_id": "app_settings", **DEFAULT_SETTINGS})
        logger.info("[STARTUP] Created default settings")
    else:
        # Migrate: backfill any missing fields from defaults
        updates = {}
        for key, val in DEFAULT_SETTINGS.items():
            if key not in existing:
                updates[key] = val
        if not str(existing.get("notification_sheet_url") or "").strip() and DEFAULT_NOTIFICATION_SHEET_URL:
            updates["notification_sheet_url"] = DEFAULT_NOTIFICATION_SHEET_URL
        # Migrate old 3-template discord to new 15-template list
        if len(existing.get("discord_templates", [])) < 5:
            updates["discord_templates"] = DISCORD_TEMPLATES
        if updates:
            await db.settings.update_one({"_id": "app_settings"}, {"$set": updates})
            logger.info(f"[STARTUP] Migrated settings: {list(updates.keys())}")
    logger.info(f"[STARTUP] Mock Testing Suite v{APP_VERSION}")
    yield
    db.close()
    logger.info("[SHUTDOWN] Server stopped")


app = FastAPI(title="Mock Testing Suite", version=APP_VERSION, lifespan=lifespan)
api_router = APIRouter(prefix="/api")

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)


# ══════════════════════════════════════════════════════════════════
# SETTINGS ROUTES
# ══════════════════════════════════════════════════════════════════
@api_router.get("/settings")
async def get_settings():
    doc = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0})
    return sanitize_settings(doc)


@api_router.put("/settings")
async def save_settings(payload: dict):
    updates = normalize_settings_payload(payload)
    if not updates:
        return {"ok": True}
    await db.settings.update_one(
        {"_id": "app_settings"},
        {"$set": updates},
        upsert=True
    )
    return {"ok": True}


@api_router.post("/settings/restore-defaults")
async def restore_settings_defaults():
    existing = await db.settings.find_one({"_id": "app_settings"}) or {}
    restored = dict(DEFAULT_SETTINGS)

    for key in PRESERVED_SETTINGS_KEYS_ON_RESTORE:
        if key in existing:
            restored[key] = existing[key]

    await db.settings.replace_one(
        {"_id": "app_settings"},
        {"_id": "app_settings", **restored},
        upsert=True,
    )
    return {"ok": True, "settings": sanitize_settings(restored)}


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


@api_router.get("/help/content")
async def get_help_content():
    return HELP_CONTENT


@api_router.post("/settings/complete-setup")
async def complete_setup(payload: dict):
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
async def start_session(payload: dict):
    session = empty_session()
    session.update(payload)
    session["last_saved"] = datetime.now(timezone.utc).strftime("%I:%M %p")
    await db.sessions.replace_one({"_id": "active_session"}, {"_id": "active_session", **session}, upsert=True)
    return {"ok": True, "session": session}


@api_router.put("/session/update")
async def update_session(payload: dict):
    payload["last_saved"] = datetime.now(timezone.utc).strftime("%I:%M %p")
    await db.sessions.update_one({"_id": "active_session"}, {"$set": payload}, upsert=True)
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    return {"ok": True, "session": doc}


@api_router.post("/session/call")
async def save_call(payload: dict):
    key = f"call_{payload.get('call_num', 1)}"
    await db.sessions.update_one({"_id": "active_session"}, {"$set": {key: payload, "current_call_draft": None, "current_call_num": None}})
    return {"ok": True}


@api_router.post("/session/sup")
async def save_sup(payload: dict):
    key = f"sup_transfer_{payload.get('transfer_num', 1)}"
    await db.sessions.update_one({"_id": "active_session"}, {"$set": {key: payload, "current_sup_transfer_draft": None, "current_sup_transfer_num": None}})
    return {"ok": True}


@api_router.post("/session/finish")
async def finish_session_simple():
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
    await db.sessions.delete_one({"_id": "active_session"})
    return {"ok": True, "record": {k: v for k, v in record.items() if k != "_id"}}


@api_router.post("/session/discard")
async def discard_session():
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
async def clear_history():
    await db.history.delete_many({})
    return {"ok": True}


import csv
import io
import re
import httpx

# ══════════════════════════════════════════════════════════════════
# TICKER (fetches from Google Doc, falls back to defaults)
# ══════════════════════════════════════════════════════════════════
_ticker_cache = {"messages": None, "last_fetch": 0}
_headset_cache = {"groups": None, "last_fetch": 0}
_notification_cache = {"groups": None, "last_fetch": 0, "url": ""}

_notification_defaults = {
    "tickerMessages": [],
    "banners": [],
    "popups": [],
}
DEFAULT_NOTIFICATION_TIMEZONE = "America/New_York"

async def _fetch_ticker_from_doc():
    """Fetch ticker messages from Google Doc. Each numbered line becomes a message.
    The leading number+period is stripped. Falls back to defaults on error."""
    import time
    now = time.time()
    if _ticker_cache["messages"] and (now - _ticker_cache["last_fetch"]) < 55:
        return _ticker_cache["messages"]
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(TICKER_DOC_URL, follow_redirects=True)
            if resp.status_code == 200:
                text = resp.text.strip()
                lines = []
                for line in text.split('\n'):
                    line = line.strip()
                    if not line:
                        continue
                    cleaned = re.sub(r'^\d+[\.\)]\s*', '', line).strip()
                    if cleaned:
                        lines.append(cleaned)
                if lines:
                    _ticker_cache["messages"] = lines
                    _ticker_cache["last_fetch"] = now
                    return lines
    except Exception as e:
        logger.warning(f"[TICKER] Failed to fetch Google Doc: {e}")
    return TICKER_MESSAGES


def _normalize_notification_bool(value):
    return str(value or "").strip().lower() in {"true", "1", "yes", "y", "on"}


def _normalize_notification_text(value):
    return str(value or "").strip()


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


def _combine_notification_datetime(date_value, time_value, default_time):
    parsed_date = _normalize_notification_date(date_value)
    if not parsed_date:
        return None

    parsed_time = _normalize_notification_time(time_value) or default_time
    return datetime(
        parsed_date.year,
        parsed_date.month,
        parsed_date.day,
        parsed_time[0],
        parsed_time[1],
        parsed_time[2],
        tzinfo=ZoneInfo(DEFAULT_NOTIFICATION_TIMEZONE),
    )


def _resolve_notification_sheet_url(value):
    raw = _normalize_notification_text(value)
    if not raw:
        return ""

    match = re.match(r"^https://docs\.google\.com/spreadsheets/d/([^/]+)/.*?(?:[?#&]gid=(\d+))?", raw)
    if match:
        doc_id = match.group(1)
        gid = match.group(2) or "0"
        return f"https://docs.google.com/spreadsheets/d/{doc_id}/export?format=csv&gid={gid}"

    return raw


def _get_admin_notification_sheet_url(settings_doc):
    runtime_config = _load_backend_runtime_config()
    runtime_url = _resolve_notification_sheet_url(runtime_config.get("notification_sheet_url"))
    if runtime_url:
        return runtime_url
    return _resolve_notification_sheet_url((settings_doc or {}).get("notification_sheet_url"))


def _notification_is_active(start_date, end_date):
    current = datetime.now(ZoneInfo(DEFAULT_NOTIFICATION_TIMEZONE))
    if start_date and current < start_date:
        return False
    if end_date and current > end_date:
        return False
    return True


def _parse_notification_csv(csv_text):
    reader = csv.DictReader(io.StringIO(csv_text or ""))
    allowed_types = {"ticker", "info", "warning", "urgent"}
    groups = {"tickerMessages": [], "banners": [], "popups": []}

    for row in reader:
        if not isinstance(row, dict):
            continue

        if not _normalize_notification_bool(row.get("Enabled")):
            continue

        notification_type = _normalize_notification_text(row.get("Type")).lower()
        if notification_type not in allowed_types:
            continue

        message = _normalize_notification_text(row.get("Message"))
        if not message:
            continue

        start_date = _combine_notification_datetime(
            row.get("StartDate"),
            row.get("StartTime"),
            (0, 0, 0),
        ) if _normalize_notification_text(row.get("StartDate")) else None
        end_default_time = (23, 59, 59) if row.get("EndTime") is None else (0, 0, 0)
        end_date = _combine_notification_datetime(
            row.get("EndDate"),
            row.get("EndTime"),
            end_default_time,
        ) if _normalize_notification_text(row.get("EndDate")) else None

        if _normalize_notification_text(row.get("StartDate")) and not start_date:
            start_date = None
        if _normalize_notification_text(row.get("EndDate")) and not end_date:
            continue
        if start_date and end_date and start_date > end_date:
            continue
        if not _notification_is_active(start_date, end_date):
            continue

        notification_id = _normalize_notification_text(row.get("ID")) or f"notification-row-{len(groups['tickerMessages']) + len(groups['banners']) + len(groups['popups']) + 1}"
        item = {
            "id": notification_id,
            "type": notification_type,
            "title": _normalize_notification_text(row.get("Title")),
            "message": message,
            "showPopup": _normalize_notification_bool(row.get("ShowPopup")),
            "showBanner": _normalize_notification_bool(row.get("ShowBanner")),
            "persistent": _normalize_notification_bool(row.get("Persistent")),
            "startTime": _normalize_notification_text(row.get("StartTime")),
            "endTime": _normalize_notification_text(row.get("EndTime")),
            "actionText": _normalize_notification_text(row.get("ActionText")) if _normalize_notification_text(row.get("ActionURL")) else "",
            "actionURL": _normalize_notification_text(row.get("ActionURL")),
            }

        if item["type"] == "ticker":
            groups["tickerMessages"].append(item)
        if item["showBanner"]:
            groups["banners"].append(item)
        if item["showPopup"]:
            groups["popups"].append(item)

    return groups


async def _fetch_notifications_from_sheet():
    import time

    settings_doc = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0}) or {}
    sheet_url = _get_admin_notification_sheet_url(settings_doc)
    if not sheet_url:
        return _notification_defaults

    now = time.time()
    if (
        _notification_cache["groups"] is not None
        and _notification_cache["url"] == sheet_url
        and (now - _notification_cache["last_fetch"]) < 55
    ):
        return _notification_cache["groups"]

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(sheet_url, follow_redirects=True)
            if resp.status_code == 200:
                groups = _parse_notification_csv(resp.text)
                _notification_cache["groups"] = groups
                _notification_cache["last_fetch"] = now
                _notification_cache["url"] = sheet_url
                return groups
    except Exception as exc:
        logger.warning("[NOTIFICATIONS] Failed to fetch notification sheet: %s", exc)

    return _notification_defaults

@api_router.get("/ticker")
async def get_ticker():
    messages = await _fetch_ticker_from_doc()
    return {"messages": messages}


@api_router.get("/notifications")
async def get_notifications():
    groups = await _fetch_notifications_from_sheet()
    return groups


def _parse_approved_headsets_doc(text: str):
    groups = []
    current = None
    pending_brand = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        line = re.sub(r"^[\u2022\u25CF\u25E6]+\s*", "", line)
        line = re.sub(r"^\d+[\.\)]\s*", "", line)

        brand_match = re.match(r"^Brand:\s*(.+?)\s*$", line, re.IGNORECASE)
        if brand_match:
            brand = brand_match.group(1).strip()
            if brand:
                current = {"brand": brand, "models": []}
                groups.append(current)
                pending_brand = None
            continue

        model_match = re.match(r"^-\s+(.+?)\s*$", line)
        if model_match and current is not None:
            model = model_match.group(1).strip()
            if model and model not in current["models"]:
                current["models"].append(model)
            continue

        if line.endswith(":"):
            pending_brand = line[:-1].strip()
            continue

        if pending_brand and not line.startswith("-"):
            current = {"brand": pending_brand, "models": []}
            groups.append(current)
            pending_brand = None

        if current is None and not line.startswith("-") and len(line) < 80 and not re.search(r"\b(usb|noise|microphone|discord|approved)\b", line, re.IGNORECASE):
            pending_brand = line
            continue

        model_text = re.sub(r"^-\s*", "", line).strip()
        if pending_brand and model_text:
            current = {"brand": pending_brand, "models": []}
            groups.append(current)
            pending_brand = None

        if current is not None and model_text and model_text.lower() not in {current["brand"].lower(), "approved models"} and model_text not in current["models"]:
            current["models"].append(model_text)

    return [group for group in groups if group["models"]]


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

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(APPROVED_HEADSETS_DOC_URL, follow_redirects=True)
            if resp.status_code == 200:
                groups = _parse_approved_headsets_doc(resp.text.strip())
                if groups:
                    _headset_cache["groups"] = groups
                    _headset_cache["last_fetch"] = now
                    return groups, ""
                return _headset_cache["groups"] or [], "The approved headset Google Doc was reached, but its contents could not be parsed."
    except Exception as exc:
        logger.warning("[HEADSETS] Failed to fetch approved headset doc: %s", exc)
        return _headset_cache["groups"] or [], "Unable to reach the approved headset Google Doc right now."

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
    api_key = (payload or {}).get("api_key", "")
    result = generate_summaries(doc, api_key, settings)
    return result


@api_router.post("/gemini/regenerate")
async def regen_summary(payload: dict):
    summary_type = payload.get("type", "coaching")
    doc = await db.sessions.find_one({"_id": "active_session"}, {"_id": 0})
    if not doc:
        return {"ok": False, "error": "No active session"}
    settings = await db.settings.find_one({"_id": "app_settings"}, {"_id": 0})
    api_key = payload.get("api_key", "")
    result = generate_summaries(doc, api_key, settings)
    if result.get("error"):
        return {"ok": False, "error": result["error"], "text": result.get(summary_type, "")}
    return {"ok": True, "text": result.get(summary_type, "")}


# ══════════════════════════════════════════════════════════════════
# FINISH SESSION (orchestrator)
# ══════════════════════════════════════════════════════════════════
@api_router.post("/finish-session")
async def finish_all(payload: dict):
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
async def fill_form(payload: dict):
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


app.include_router(api_router)

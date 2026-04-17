"""
session_manager.py — Singleton service for managing the active mock testing session.

Maintains an in-memory session dict, auto-saves to draft.json every 60 seconds,
and provides methods for the routes to read/mutate session state.
"""
import json
import os
import threading
from datetime import datetime
from typing import Optional

import config


class SessionManager:
    """Single-user session state manager with auto-save."""

    def __init__(self):
        self._session: Optional[dict] = None
        self._lock = threading.Lock()
        self._timer: Optional[threading.Timer] = None
        self._running = False

    # ── Empty Session Template ──────────────────────────────────
    @staticmethod
    def _empty_session() -> dict:
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
        }

    # ── Auto-Save Timer ─────────────────────────────────────────
    def start_autosave(self):
        """Start the 60-second auto-save loop."""
        self._running = True
        self._schedule_next()

    def stop_autosave(self):
        """Stop the auto-save loop."""
        self._running = False
        if self._timer:
            self._timer.cancel()
            self._timer = None

    def _schedule_next(self):
        if not self._running:
            return
        self._timer = threading.Timer(60.0, self._autosave_tick)
        self._timer.daemon = True
        self._timer.start()

    def _autosave_tick(self):
        self.save_draft()
        self._schedule_next()

    # ── Draft Persistence ───────────────────────────────────────
    def save_draft(self):
        """Write current session to draft.json if a candidate name exists."""
        with self._lock:
            if not self._session or not self._session.get("candidate_name"):
                return
            self._session["last_saved"] = datetime.now().strftime("%I:%M %p")
            try:
                with open(config.DRAFT_FILE, "w", encoding="utf-8") as f:
                    json.dump(self._session, f, indent=2)
            except Exception as e:
                print(f"[session_manager] Draft save failed: {e}")

    def load_draft(self) -> bool:
        """Load a previously saved draft into memory. Returns True if loaded."""
        if os.path.exists(config.DRAFT_FILE):
            try:
                with open(config.DRAFT_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                with self._lock:
                    self._session = data
                return True
            except Exception:
                pass
        return False

    def clear_draft(self):
        """Remove draft file and reset in-memory session."""
        with self._lock:
            self._session = None
        if os.path.exists(config.DRAFT_FILE):
            try:
                os.remove(config.DRAFT_FILE)
            except Exception:
                pass

    # ── Session CRUD ────────────────────────────────────────────
    @property
    def current(self) -> Optional[dict]:
        return self._session

    @property
    def has_active(self) -> bool:
        return self._session is not None and bool(self._session.get("candidate_name"))

    def start(self, data: dict) -> dict:
        """Start a new session, merging in initial data (basics screen)."""
        with self._lock:
            self._session = self._empty_session()
            self._session.update(data)
        self.save_draft()
        return self._session

    def update(self, data: dict) -> dict:
        """Merge partial updates into the active session."""
        with self._lock:
            if self._session is None:
                self._session = self._empty_session()
            self._session.update(data)
        self.save_draft()
        return self._session

    def save_call(self, data: dict):
        """Save a call result (call_1, call_2, call_3)."""
        key = f"call_{data.get('call_num', 1)}"
        with self._lock:
            if self._session:
                self._session[key] = data
        self.save_draft()

    def save_sup(self, data: dict):
        """Save a supervisor transfer result."""
        key = f"sup_transfer_{data.get('transfer_num', 1)}"
        with self._lock:
            if self._session:
                self._session[key] = data
        self.save_draft()

    def finish(self) -> dict:
        """Finalize session: append to history, clear draft, return the record."""
        with self._lock:
            if not self._session:
                return {}

            record = {
                "timestamp": datetime.now().strftime("%Y-%m-%d %I:%M %p"),
                "candidate": self._session.get("candidate_name", "Unknown"),
                "tester_name": self._session.get("tester_name", ""),
                "status": self._session.get("final_status", "Fail"),
                **self._session,
            }

        # Append to history file
        history = []
        if os.path.exists(config.HISTORY_FILE):
            try:
                with open(config.HISTORY_FILE, "r", encoding="utf-8") as f:
                    history = json.load(f)
            except Exception:
                history = []

        history.insert(0, record)

        with open(config.HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump(history, f, indent=2)

        # Clear
        self.clear_draft()
        return record

    def discard(self):
        """Discard the current session without saving to history."""
        self.clear_draft()


# ── Singleton ───────────────────────────────────────────────────
session_mgr = SessionManager()

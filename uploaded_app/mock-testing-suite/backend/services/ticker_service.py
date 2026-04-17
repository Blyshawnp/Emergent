"""
ticker_service.py — Fetches scrolling ticker messages from a published Google Doc.

The Google Doc should be published to web as plain text.
Each non-empty line becomes a ticker message.
Polls every 60 seconds so admins can update messages in real-time.

Fallback: if no Google Doc URL is configured, uses local default messages.
"""
import urllib.request
import threading
import time
from typing import List

DEFAULT_MESSAGES = [
    "Welcome to Mock Testing Suite v3.0 — Built by Shawn P. Bly",
    "Reminder: Log out of Call Corp and Simple Script after each session",
    "Tip: Use the Discord Post button to quickly copy common messages",
    "Need help? Check the Help tab for step-by-step setup guides",
]


class TickerService:
    def __init__(self):
        self._messages: List[str] = list(DEFAULT_MESSAGES)
        self._lock = threading.Lock()
        self._timer = None
        self._running = False
        self._doc_url = ""

    @property
    def messages(self) -> List[str]:
        with self._lock:
            return list(self._messages)

    def set_doc_url(self, url: str):
        """Update the Google Doc URL (called when settings change)."""
        self._doc_url = url

    def start_polling(self, doc_url: str = "", interval: int = 60):
        """Start polling the Google Doc every `interval` seconds."""
        self._doc_url = doc_url
        self._running = True
        self._fetch_now()  # Initial fetch
        self._schedule_next(interval)

    def stop_polling(self):
        self._running = False
        if self._timer:
            self._timer.cancel()

    def _schedule_next(self, interval: int = 60):
        if not self._running:
            return
        self._timer = threading.Timer(interval, self._poll_tick, args=[interval])
        self._timer.daemon = True
        self._timer.start()

    def _poll_tick(self, interval: int = 60):
        self._fetch_now()
        self._schedule_next(interval)

    def _fetch_now(self):
        """Fetch messages from the Google Doc. Falls back to defaults on error."""
        if not self._doc_url:
            return  # Keep whatever we have (defaults)

        try:
            req = urllib.request.Request(
                self._doc_url,
                headers={"User-Agent": "MockTestingSuite/3.0"}
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                text = resp.read().decode("utf-8").strip()

            # Each non-empty line is a message
            lines = [line.strip() for line in text.splitlines() if line.strip()]

            if lines:
                with self._lock:
                    self._messages = lines
                    print(f"[ticker] Updated: {len(lines)} messages from Google Doc")
            else:
                print("[ticker] Google Doc was empty, keeping existing messages")

        except Exception as e:
            print(f"[ticker] Fetch failed (keeping existing): {e}")


# Singleton
ticker_svc = TickerService()

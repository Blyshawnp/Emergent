"""
update_checker.py — Checks a published Google Doc for new versions.

The Google Doc should be published to web as plain text and contain:
    VERSION=3.0.1
    DOWNLOAD=https://drive.google.com/file/d/xxxxx/view
    NOTES=Bug fixes and performance improvements

The app checks this on startup and exposes the result via API.
"""
import urllib.request
import threading
import time
from typing import Optional

import config


class UpdateChecker:
    def __init__(self):
        self.latest_version: Optional[str] = None
        self.download_url: Optional[str] = None
        self.release_notes: Optional[str] = None
        self.update_available: bool = False
        self.last_checked: Optional[str] = None
        self._lock = threading.Lock()

    def check(self, doc_url: str) -> dict:
        """
        Fetch the Google Doc and parse version info.
        doc_url should be the published-to-web plain text URL, e.g.:
        https://docs.google.com/document/d/{DOC_ID}/export?format=txt
        """
        if not doc_url:
            return {"update_available": False, "error": "No update check URL configured"}

        try:
            req = urllib.request.Request(doc_url, headers={"User-Agent": "MockTestingSuite/3.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                text = resp.read().decode("utf-8").strip()

            # Parse key=value lines
            data = {}
            for line in text.splitlines():
                line = line.strip()
                if "=" in line:
                    key, val = line.split("=", 1)
                    data[key.strip().upper()] = val.strip()

            remote_version = data.get("VERSION", "")
            download = data.get("DOWNLOAD", "")
            notes = data.get("NOTES", "")

            with self._lock:
                self.latest_version = remote_version
                self.download_url = download
                self.release_notes = notes
                self.update_available = (
                    remote_version != ""
                    and remote_version != config.APP_VERSION
                )
                self.last_checked = time.strftime("%I:%M %p")

            return self.get_status()

        except Exception as e:
            return {"update_available": False, "error": str(e)}

    def get_status(self) -> dict:
        with self._lock:
            return {
                "update_available": self.update_available,
                "current_version": config.APP_VERSION,
                "latest_version": self.latest_version,
                "download_url": self.download_url,
                "release_notes": self.release_notes,
                "last_checked": self.last_checked,
            }


# Singleton
update_checker = UpdateChecker()

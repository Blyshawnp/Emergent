"""Focused tutorial-video content contract checks."""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402


HEADERS = server.TUTORIAL_VIDEO_HEADERS


def row(**overrides):
    base = {header: "" for header in HEADERS}
    base.update({
        "Category": "Quick Start",
        "VideoKey": "quick-start",
        "Title": "Quick Start",
        "SortOrder": "10",
        "Active": "TRUE",
    })
    base.update(overrides)
    return base


def run():
    mts = server._normalize_tutorial_videos([
        row(),
        row(VideoKey="history", Title="History", Category="History", SortOrder="20", HelpTopicKey="history"),
        row(VideoKey="other", Title="Other", Category="Unexpected"),
        row(VideoKey="quick-start", Title="Duplicate"),
    ], "mts")
    assert [item["VideoKey"] for item in mts] == ["quick-start", "history", "other"]
    assert mts[1]["HelpTopicKey"] == "history"
    assert mts[2]["Category"] == "Other Tutorials"

    sam = server._normalize_tutorial_videos([
        row(Category="Pending Requests", VideoKey="requests", Title="Pending Requests"),
    ], "sam")
    assert sam[0]["Category"] == "Pending Requests"

    invalid_headers = server._normalize_tutorial_videos([{"Title": "Missing headers"}], "mts")
    assert invalid_headers == []
    assert server._normalize_tutorial_videos([row(YouTubeURL="https://example.com/video")], "mts") == []
    assert server._tutorial_youtube_video_id("<iframe></iframe>") == ""
    assert server._tutorial_youtube_video_id("https://youtu.be/dQw4w9WgXcQ") == "dQw4w9WgXcQ"

    setup = server._tutorial_video_required_setup()
    assert setup["mts-tutorial-videos"] == HEADERS
    assert setup["sam-tutorial-videos"] == HEADERS

    repo_root = Path(__file__).resolve().parents[1]
    training_scripts = sorted((repo_root / "docs" / "training" / "video-scripts").glob("*.md"))
    overview_scripts = sorted((repo_root / "docs" / "video-scripts").glob("*.md"))
    assert len(training_scripts) == 11
    assert len(overview_scripts) == 4

    titles = []
    video_keys = []
    combined = ""
    for path in training_scripts:
        text = path.read_text(encoding="utf-8")
        combined += "\n" + text
        title = re.search(r"^- Title: (.+)$", text, re.MULTILINE)
        video_key = re.search(r"^- VideoKey: `([^`]+)`$", text, re.MULTILINE)
        assert title, f"Missing tutorial title: {path.name}"
        assert video_key, f"Missing tutorial VideoKey: {path.name}"
        titles.append(title.group(1).strip().casefold())
        video_keys.append(video_key.group(1).strip().casefold())
        expected_prefix = "sam-" if "-SAM-" in path.name else "mts-"
        assert video_key.group(1).startswith(expected_prefix), f"Wrong app VideoKey: {path.name}"
    assert len(titles) == len(set(titles)), "Duplicate tutorial titles"
    assert len(video_keys) == len(set(video_keys)), "Duplicate tutorial VideoKeys"

    required_current_copy = [
        "Research Complete", "Save Headset", "Correct Candidate Information",
        "Resume Supervisor Transfer", "Previous Value", "Requested Value",
        "Replay Guided Walkthrough", "Ticker Speed", "VPN / Proxy Lookup Sites",
        "IP2Location", "IPinfo", "ip.teoh.io", "Copy Link",
        "MTS does not automatically verify VPN or proxy status",
    ]
    for phrase in required_current_copy:
        assert phrase in combined, f"Missing current tutorial workflow copy: {phrase}"
    assert "approved headset marks USB and Noise Cancelling Mic Yes automatically" not in combined
    assert "History waits for Google" not in combined
    assert "tutorial topics can be edited in Settings" not in combined
    stale_vpn_copy = [
        "Run safe demo check",
        "integrated result",
        "saved candidate IP",
        "configured providers",
        "click Check IP",
    ]
    for phrase in stale_vpn_copy:
        assert phrase.casefold() not in combined.casefold(), f"Stale automatic VPN tutorial copy: {phrase}"
    print("Tutorial video content contract tests passed.")


class TutorialVideoContentTests(unittest.TestCase):
    def test_content_contract(self):
        run()


if __name__ == "__main__":
    unittest.main()

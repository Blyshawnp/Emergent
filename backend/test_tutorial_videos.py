"""Focused tutorial-video content contract checks."""
import server


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
    print("Tutorial video content contract tests passed.")


if __name__ == "__main__":
    run()

from harmonia_agent.youtube import extract_video_id, iso8601_to_seconds
from harmonia_agent.stages import classify_failure
import httpx


def test_video_id_extraction():
    assert extract_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert extract_video_id("https://youtu.be/dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert extract_video_id("https://www.youtube.com/shorts/dQw4w9WgXcQ") == "dQw4w9WgXcQ"


def test_bad_url_raises():
    import pytest
    from harmonia_agent.youtube import IngestError
    with pytest.raises(IngestError):
        extract_video_id("https://vimeo.com/123")


def test_iso_duration():
    assert iso8601_to_seconds("PT4M13S") == 253
    assert iso8601_to_seconds("PT1H2M3S") == 3723


def test_transport_failures_are_transient():
    req = httpx.Request("GET", "https://api.x.com")
    assert classify_failure(httpx.ConnectTimeout("t", request=req)) is False

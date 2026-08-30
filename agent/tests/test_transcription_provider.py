from types import SimpleNamespace
from harmonia_agent import content


def test_transcription_client_uses_explicit_vertex_global_not_developer_key(monkeypatch):
    calls = []
    monkeypatch.setattr(content, "settings", lambda: SimpleNamespace(gcp_project="real-project", gemini_api_key="not-for-this-provider"))
    monkeypatch.setattr(content.genai, "Client", lambda **kwargs: calls.append(kwargs))
    content._client()
    assert calls == [{"vertexai": True, "project": "real-project", "location": "global"}]

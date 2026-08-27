from __future__ import annotations

from harmonia_agent import web_client
from harmonia_agent.operation_context import operation_scope
from harmonia_agent.tenant_context import tenant_scope


def test_artifact_client_uploads_and_reads_by_opaque_id(monkeypatch) -> None:
    calls = []

    class Response:
        status_code = 200
        text = ""

        def __init__(self, body):
            self._body = body

        def json(self):
            return self._body

    class Client:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def post(self, path, json):
            calls.append(("post", path, json))
            response = Response({"artifact": {"id": "artifact-1", "sha256": "a" * 64}})
            response.status_code = 201
            return response

        def get(self, path, params):
            calls.append(("get", path, params))
            return Response({"artifact": {"id": "artifact-1"}, "text": "tail"})

    monkeypatch.setattr(web_client, "_client", lambda: Client())
    with tenant_scope("workspace-1", "brand-1"):
        with operation_scope("job:job-1:stage:draft", 2):
            artifact = web_client.create_artifact(
                job_id="job-1",
                operation_id="job:job-1:stage:draft",
                content=b"full tool result",
                content_type="text/plain",
                trust="external_untrusted",
                producer={"kind": "tool", "id": "search", "version": "1"},
                retention_class="source",
            )
            page = web_client.read_artifact("artifact-1", line_start=4, line_count=10)

    assert artifact["id"] == "artifact-1"
    assert calls[0][1] == "/api/internal/artifacts"
    assert "dataBase64" in calls[0][2]
    assert calls[1] == (
        "get", "/api/internal/artifacts/artifact-1", {"lineStart": 4, "lineCount": 10}
    )
    assert page["text"] == "tail"

import hashlib
import io
import json
from types import SimpleNamespace

import pytest

from harmonia_agent import data_consumer as dc


class S3:
    def __init__(self, objects):
        self.objects = objects
        self.writes = []
    def get_object(self, Bucket, Key):
        body = self.objects[Key]
        return {"Body": io.BytesIO(body), "ContentLength": len(body)}
    def put_object(self, **kwargs):
        assert kwargs["IfNoneMatch"] == "*"
        self.writes.append(kwargs)
        self.objects[kwargs["Key"]] = kwargs["Body"]


@pytest.fixture
def work(monkeypatch):
    monkeypatch.setattr(dc, "settings", lambda: SimpleNamespace(media_output_bucket="bucket", aws_region="us-east-1"))
    body = b"# Evidence\n\nA real document."
    source_sha = hashlib.sha256(body).hexdigest()
    raw = json.dumps({"schemaVersion": 1, "workspaceId": "w", "brandId": "b", "processorVersion": dc.PROCESSOR,
        "items": [{"partitionIndex": 0, "sourceId": "source", "title": "Document", "mimeType": "text/markdown",
        "sourceUri": "s3://bucket/artifacts/w/b/source", "sourceDigest": source_sha}]}).encode()
    env = dc.Envelope(schemaVersion=1, workspaceId="w", brandId="b", batchId="batch", itemId="item",
        partitionIndex=0, processorVersion=dc.PROCESSOR, manifestUri="s3://bucket/artifacts/w/b/manifest",
        manifestDigest=hashlib.sha256(raw).hexdigest())
    batch = {"id": "batch", "workspaceId": "w", "brandId": "b", "processorVersion": dc.PROCESSOR,
        "state": "running", "createdAt": "2026-09-10T00:00:00Z", "manifest": {"uri": env.manifestUri,
        "sha256": env.manifestDigest, "byteCount": len(raw), "itemCount": 1}}
    item = {"id": "item", "workspaceId": "w", "brandId": "b", "batchId": "batch", "partitionIndex": 0,
        "processorVersion": dc.PROCESSOR, "sourceDigest": source_sha, "epoch": 2}
    return env, batch, item, S3({"artifacts/w/b/source": body, "artifacts/w/b/manifest": raw})


def test_normalization_is_stable_and_verified(work):
    env, batch, item, s3 = work
    first = dc._normalize(env, batch, item, s3)
    assert dc._normalize(env, batch, item, s3) == first
    output = json.loads(s3.objects[f"durable-artifacts/w/b/data-normalized/{first}.json"])
    assert output["normalizedSource"]["segments"][1]["text"] == "A real document."
    assert output["normalizedSource"]["extractedAt"] == batch["createdAt"]
    assert output["sourceDigest"] == item["sourceDigest"]


@pytest.mark.parametrize("uri", ["s3://other/artifacts/w/b/x", "s3://bucket/artifacts/foreign/b/x", "s3://bucket/artifacts/w/b/../x", "https://bucket/artifacts/w/b/x"])
def test_foreign_objects_rejected(work, uri):
    with pytest.raises(dc.InvalidDataWork):
        dc._s3_location(uri, work[0])


def test_corrupt_source_never_writes(work):
    env, batch, item, s3 = work
    s3.objects["artifacts/w/b/source"] = b"changed"
    with pytest.raises(dc.InvalidDataWork, match="source digest"):
        dc._normalize(env, batch, item, s3)
    assert not s3.writes


def test_queue_manifest_cannot_override_persisted_authority(work):
    env, batch, _, _ = work
    with pytest.raises(dc.InvalidDataWork):
        dc._validate_authority(env.model_copy(update={"manifestDigest": "a" * 64}), batch)


def test_unknown_write_never_finalizes(work, monkeypatch):
    env, batch, item, s3 = work
    monkeypatch.setattr(dc, "_get_batch", lambda _: batch)
    monkeypatch.setattr(dc.boto3, "client", lambda *a, **k: s3)
    calls = []
    def post(path, payload):
        calls.append(path)
        return {"outcome": "execute", "item": item}
    monkeypatch.setattr(dc.web_client, "post", post)
    def uncertain(**kwargs):
        raise TimeoutError("unknown write outcome")
    s3.put_object = uncertain
    with pytest.raises(TimeoutError):
        dc._process(env)
    assert len(calls) == 1


def test_success_finalizes_with_claim_epoch(work, monkeypatch):
    env, batch, item, s3 = work
    monkeypatch.setattr(dc, "_get_batch", lambda _: batch)
    monkeypatch.setattr(dc.boto3, "client", lambda *a, **k: s3)
    calls = []
    def post(path, payload):
        calls.append(payload)
        if path.endswith("/claim"):
            return {"outcome": "execute", "item": item}
        assert payload["epoch"] == 2
        assert payload["claimToken"] == calls[0]["claimToken"]
        assert len(payload["artifactIds"][0]) == 64
        return {"item": {"state": "succeeded"}}
    monkeypatch.setattr(dc.web_client, "post", post)
    assert dc._process(env)

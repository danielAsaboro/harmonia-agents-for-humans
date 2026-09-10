from types import SimpleNamespace
from datetime import datetime, timezone
import pytest
from harmonia_agent import knowledge_index as ki
from harmonia_agent.extraction.text import extract_text
from harmonia_agent.tenant_context import tenant_scope
from tests.test_data_consumer import S3


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setenv("HARMONIA_ALLOW_PAID_AWS", "true")
    monkeypatch.setenv("BEDROCK_DATA_SOURCE_ID", "DATASOURCE")
    monkeypatch.setenv("EMBEDDING_INPUT_USD_PER_MILLION", "0.02")
    monkeypatch.setenv("EMBEDDING_PRICING_VERSION", "test-only")
    monkeypatch.setattr(ki.web_client, "reserve_budget", lambda payload: None)
    monkeypatch.setattr(ki, "settings", lambda: SimpleNamespace(bedrock_knowledge_base_id="KNOWLEDGEB", media_output_bucket="bucket", aws_region="us-east-1"))
    normalized = extract_text("source", "Title", "Verified extracted text", "text/plain")
    source = {"id": "source", "workspaceId": "w", "brandId": "b", "state": "ready",
        "contentDigest": normalized.contentDigest, "rightsAuthorizationId": "rights-1", "normalizedArtifactId": "artifact-1"}
    monkeypatch.setattr(ki.web_client, "get_source", lambda _: {"source": source})
    monkeypatch.setattr(ki.web_client, "get_source_manifest", lambda _: {"sources": [source], "normalizedSources": [normalized.model_dump(mode="json")]})
    records = []
    monkeypatch.setattr(ki, "_record", lambda _: records[-1] if records else None)
    def post(path, payload):
        if payload["state"] == "prepared" and records:
            return {"record": records[-1].copy()}
        records.append({**payload, "createdAt": (records[0]["createdAt"] if records else datetime.now(timezone.utc).isoformat())})
        return {"record": records[-1].copy()}
    monkeypatch.setattr(ki.web_client, "post", post)
    s3 = S3({})
    class Bedrock:
        calls = 0
        status = "COMPLETE"
        def start_ingestion_job(self, **kwargs):
            assert records[-1]["state"] == "prepared"
            assert records[-1]["clientToken"] == kwargs["clientToken"]
            assert len(s3.objects) == 2
            self.calls += 1
            return {"ingestionJob": {"ingestionJobId": "INGESTJOB1"}}
        def get_ingestion_job(self, **kwargs):
            return {"ingestionJob": {"status": self.status, "statistics": {"numberOfDocumentsFailed": 0}}}
    bedrock = Bedrock()
    monkeypatch.setattr(ki.boto3, "client", lambda name, **_: s3 if name == "s3" else bedrock)
    return source, records, s3, bedrock


def test_index_prepares_before_provider_and_records_complete(setup):
    source, records, s3, bedrock = setup
    with tenant_scope("w", "b"):
        ki.index_job_sources("job")
        ki.index_job_sources("job")
    assert [record["state"] for record in records] == ["prepared", "submitted", "complete"]
    assert bedrock.calls == 1
    assert all(key.startswith("knowledge/w/b/source/") for key in s3.objects)


def test_pending_resumes_poll_without_second_submission(setup):
    _, records, _, bedrock = setup
    bedrock.status = "IN_PROGRESS"
    with tenant_scope("w", "b"):
        with pytest.raises(ki.KnowledgeIndexPending):
            ki.index_job_sources("job")
        assert records[-1]["state"] == "submitted"
        bedrock.status = "COMPLETE"
        ki.index_job_sources("job")
    assert bedrock.calls == 1


def test_revoked_authority_rejected_before_s3_write(setup):
    source, _, s3, _ = setup
    source["rightsAuthorizationId"] = ""
    with tenant_scope("w", "b"), pytest.raises(PermissionError):
        ki.index_job_sources("job")
    assert not s3.writes


def test_paid_gate_precedes_index_provider(setup, monkeypatch):
    monkeypatch.setenv("HARMONIA_ALLOW_PAID_AWS", "false")
    with tenant_scope("w", "b"), pytest.raises(PermissionError):
        ki.index_job_sources("job")
    assert not setup[2].writes


def test_missing_embedding_price_precedes_any_upload(setup, monkeypatch):
    monkeypatch.delenv("EMBEDDING_INPUT_USD_PER_MILLION")
    with tenant_scope("w", "b"), pytest.raises(ValueError, match="embedding price"):
        ki.index_job_sources("job")
    assert not setup[2].writes


def test_erasure_never_completes_before_provider_sync(monkeypatch):
    monkeypatch.setenv("HARMONIA_ALLOW_PAID_AWS", "true")
    monkeypatch.setenv("BEDROCK_DATA_SOURCE_ID", "DATASOURCE")
    monkeypatch.setattr(ki, "settings", lambda: SimpleNamespace(bedrock_knowledge_base_id="KNOWLEDGEB", aws_region="us-east-1"))
    record = {"id": "a" * 64, "clientToken": "a" * 64, "state": "pending"}
    transitions = []
    class Response:
        status_code = 200
        def __init__(self, value): self.value = value
        def json(self): return self.value
    class Client:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def get(self, path): return Response({"records": [dict(record)]})
        def post(self, path, json):
            transitions.append(json["state"])
            record.update(json)
            return Response({"record": dict(record)})
    monkeypatch.setattr(ki.web_client, "_client", lambda **kwargs: Client())
    class Bedrock:
        def start_ingestion_job(self, **kwargs):
            assert record["state"] == "s3_erased"
            assert kwargs["clientToken"] == "a" * 64
            return {"ingestionJob": {"ingestionJobId": "INGESTJOB1"}}
        def get_ingestion_job(self, **kwargs):
            return {"ingestionJob": {"status": "IN_PROGRESS"}}
    monkeypatch.setattr(ki.boto3, "client", lambda *args, **kwargs: Bedrock())
    assert ki.recover_knowledge_erasures()[0]["state"] == "sync_submitted"
    assert transitions == ["s3_erased", "sync_submitted"]


def test_completed_index_reused_by_second_authorized_job_without_reservation(setup, monkeypatch):
    reserved = []
    monkeypatch.setattr(ki.web_client, "reserve_budget", lambda payload: reserved.append(payload))
    with tenant_scope("w", "b"):
        ki.index_job_sources("owner-job")
        monkeypatch.setenv("EMBEDDING_INPUT_USD_PER_MILLION", "0.04")
        ki.index_job_sources("consumer-job")
    assert len(reserved) == 1
    assert setup[3].calls == 1
    assert setup[1][-1]["jobId"] == "owner-job"
    usage = setup[1][-1]["usageRecord"]
    assert usage["measurementBasis"] == "utf8_byte_token_upper_bound"
    assert usage["observedCostUnavailable"] is True
    assert "observedCostUsd" not in usage
    assert usage["estimatedCostUsd"] == reserved[0]["estimatedCostUsd"]


def test_prepared_receipt_precedes_first_object_write(setup):
    _, records, s3, _ = setup
    put = s3.put_object
    def guarded(**kwargs):
        assert records and records[0]["state"] == "prepared"
        return put(**kwargs)
    s3.put_object = guarded
    with tenant_scope("w", "b"):
        ki.index_job_sources("job")


def test_unknown_submission_retains_reservation_without_usage(setup):
    _, records, _, bedrock = setup
    def unknown(**kwargs):
        raise TimeoutError("response lost")
    bedrock.start_ingestion_job = unknown
    with tenant_scope("w", "b"), pytest.raises(TimeoutError):
        ki.index_job_sources("job")
    assert records[-1]["state"] == "prepared"
    assert not any("usageRecord" in record or "budgetOutcome" in record for record in records)


def test_provider_failure_settles_explicit_estimate(setup):
    setup[3].status = "FAILED"
    with tenant_scope("w", "b"), pytest.raises(RuntimeError, match="ingestion failed"):
        ki.index_job_sources("job")
    assert setup[1][-1]["state"] == "failed"
    assert setup[1][-1]["usageRecord"]["measurementBasis"] == "utf8_byte_token_upper_bound"


def test_known_authority_failure_before_upload_releases_reservation(setup, monkeypatch):
    source, records, s3, _ = setup
    reads = 0
    def get_source(_):
        nonlocal reads
        reads += 1
        return {"source": source if reads == 1 else {**source, "state": "excluded"}}
    monkeypatch.setattr(ki.web_client, "get_source", get_source)
    with tenant_scope("w", "b"), pytest.raises(PermissionError):
        ki.index_job_sources("job")
    assert not s3.writes
    assert records[-1]["state"] == "failed"
    assert records[-1]["budgetOutcome"] == "not_invoked"
    assert "usageRecord" not in records[-1]

"""Transcribe and Canvas actual wire shapes exercised with SDK test doubles."""
import base64
import io
import json
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from harmonia_agent import content
from harmonia_agent.usage import InvocationContext

CTX = InvocationContext(job_id="j", workspace_id="w", brand_id="b", user_id="u", stage="transcribe", operation_id="op")

def configure(monkeypatch, enabled=True):
    monkeypatch.setattr(content, "settings", lambda: SimpleNamespace(allow_paid_aws=enabled, generative_media_enabled=True, aws_region="us-east-1", media_output_bucket="private", image_max_cost_usd="0.100000"))
    monkeypatch.setenv("TRANSCRIBE_COST_PER_SECOND_USD", "0.001000")
    monkeypatch.setattr(content.youtube, "probe_audio_duration", lambda body: 10)

def test_gate_stops_both_paid_providers_before_budget(monkeypatch):
    configure(monkeypatch, False)
    reserve=Mock()
    for call in [lambda: content.transcribe_audio(b"audio", "audio/wav", invocation=CTX, budget_reserver=reserve), lambda: content.generate_image("light", invocation=CTX, budget_reserver=reserve)]:
        with pytest.raises(RuntimeError, match="disabled"): call()
    reserve.assert_not_called()

def test_transcribe_resumes_deterministic_job_and_preserves_word_timing(monkeypatch):
    configure(monkeypatch)
    transcribe=Mock(); s3=Mock(); order=[]
    transcribe.get_transcription_job.side_effect=lambda **kw: order.append("provider") or {"TranscriptionJob": {"TranscriptionJobStatus": "COMPLETED", "LanguageCode": "en-US"}}
    result={"results": {"items": [{"type": "pronunciation", "start_time": "1.25", "end_time": "1.75", "alternatives": [{"content": "Hello"}]}, {"type": "punctuation", "alternatives": [{"content": "."}]}]}}
    s3.get_object.return_value={"Body": io.BytesIO(json.dumps(result).encode())}
    monkeypatch.setattr(content.boto3, "client", lambda service, **kw: s3 if service=="s3" else transcribe)
    reports=[]
    value=content.transcribe_audio(b"audio", "audio/wav", invocation=CTX, budget_reserver=lambda p: order.append("budget"), usage_reporter=reports.append)
    assert order == ["budget", "provider"]
    assert value["segments"] == [{"id": "seg-1", "startSec": 1.25, "endSec": 1.75, "text": "Hello."}]
    assert reports[0]["unitType"] == "audio_seconds"
    assert reports[0]["estimatedCostUsd"] == "0.015000"
    transcribe.start_transcription_job.assert_not_called()

def test_canvas_budget_and_native_request(monkeypatch):
    configure(monkeypatch)
    client=Mock(); order=[]; data=b"\x89PNG\r\n\x1a\nimage"
    client.invoke_model.side_effect=lambda **kw: order.append("provider") or {"body": io.BytesIO(json.dumps({"images": [base64.b64encode(data).decode()]}).encode())}
    monkeypatch.setattr(content.boto3, "client", lambda *a, **kw: client)
    reports=[]
    assert content.generate_image("abstract light", invocation=CTX, budget_reserver=lambda p: order.append("budget"), usage_reporter=reports.append) == (data,"image/png")
    assert order == ["budget","provider"]
    body=json.loads(client.invoke_model.call_args.kwargs["body"])
    assert body["taskType"] == "TEXT_IMAGE"
    assert body["imageGenerationConfig"]["numberOfImages"] == 1
    assert reports[0]["model"] == "amazon.nova-canvas-v1:0"

def test_canvas_unknown_submission_is_quarantined(monkeypatch):
    configure(monkeypatch)
    client=Mock();client.invoke_model.side_effect=TimeoutError()
    monkeypatch.setattr(content.boto3,"client",lambda *a, **kw:client)
    resolutions=[]
    with pytest.raises(content.ImageGenError): content.generate_image("light",invocation=CTX,budget_reserver=lambda p:None,budget_resolver=resolutions.append)
    assert resolutions[0]["outcome"] == "uncertain"

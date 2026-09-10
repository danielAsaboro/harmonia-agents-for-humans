"""Native media transports: authority, requests, resumptions and uncertainty."""
import json
from unittest.mock import Mock
import pytest
from harmonia_agent.generative_media import AwsMediaTransport, NovaReelGenerator, ElevenLabsGenerator, MediaOperationPending, MediaProtocolError, MediaProviderError, validate_nova_reel_request, validate_elevenlabs_request, estimate_media_cost

VIDEO = dict(modelCapability="nova-reel", mode="text_to_video", prompt="Calm abstract light", durationSec=6, aspectRatio="16:9", resolution="720p", outputCount=1)
MUSIC = dict(modelCapability="elevenlabs-music", prompt="Quiet instrumental", instrumental=True, outputCount=1)
PREFIX = "s3://private/workspaces/w/jobs/j/claims/c/"

def test_paid_gate_prevents_client_construction(monkeypatch):
    client = Mock()
    monkeypatch.setattr("harmonia_agent.generative_media.boto3.client", client)
    with pytest.raises(MediaProviderError, match="disabled"):
        AwsMediaTransport().poll_nova_reel("arn", "model")
    client.assert_not_called()

def test_nova_native_request_has_idempotent_token(monkeypatch):
    client = Mock(); client.start_async_invoke.return_value = {"invocationArn": "arn"}
    monkeypatch.setattr("harmonia_agent.generative_media.boto3.client", lambda *a, **k: client)
    transport = AwsMediaTransport(enabled=True, generative_enabled=True)
    for _ in range(2): transport.start_nova_reel(model="amazon.nova-reel-v1:1", prompt="light", duration_sec=6, source_image=None, storage_uri=PREFIX)
    calls = client.start_async_invoke.call_args_list
    assert calls[0].kwargs == calls[1].kwargs
    assert calls[0].kwargs["modelInput"]["videoGenerationConfig"] == {"durationSeconds": 6, "fps": 24, "dimension": "1280x720"}

def test_reel_persists_before_poll_and_resumes_without_start():
    transport = Mock(); events=[]
    transport.start_nova_reel.return_value = {"invocationArn": "arn"}
    transport.poll_nova_reel.side_effect = lambda *a: events.append("poll") or {"status": "Completed", "outputDataConfig": {"s3OutputDataConfig": {"s3Uri": PREFIX + "invocation/"}}}
    transport.download_s3.return_value = b"video"
    gen = NovaReelGenerator(transport=transport)
    for existing in [None, "arn"]:
        result = gen.generate(request=VIDEO, existing_operation=existing, persist_operation=lambda arn: events.append("persist"), authorized_output_prefix=PREFIX, estimated_cost_usd="0.100000")
        assert result.data == b"video"
    assert events == ["persist", "poll", "poll"]
    assert transport.start_nova_reel.call_count == 1

def test_pending_and_foreign_output_are_not_success():
    transport = Mock(); gen = NovaReelGenerator(transport=transport)
    args = dict(request=VIDEO, existing_operation="arn", persist_operation=Mock(), authorized_output_prefix=PREFIX, estimated_cost_usd="0.100000")
    transport.poll_nova_reel.return_value = {"status": "InProgress"}
    with pytest.raises(MediaOperationPending): gen.generate(**args)
    transport.poll_nova_reel.return_value = {"status": "Completed", "outputDataConfig": {"s3OutputDataConfig": {"s3Uri": "s3://other/"}}}
    with pytest.raises(MediaProtocolError): gen.generate(**args)
    transport.download_s3.assert_not_called()

def test_music_defaults_to_thirty_and_requires_instrumental():
    assert validate_elevenlabs_request(MUSIC)["targetDurationSec"] == 30
    with pytest.raises(MediaProtocolError): validate_elevenlabs_request({**MUSIC, "instrumental": False})
    with pytest.raises(MediaProtocolError): validate_elevenlabs_request({**MUSIC, "lyricsMode": "none"})
    with pytest.raises(MediaProtocolError): validate_nova_reel_request({**VIDEO, "durationSec": 8})

def test_elevenlabs_real_http_contract(monkeypatch):
    response = Mock(status_code=200, content=b"audio", headers={"song-id": "song-1"})
    post = Mock(return_value=response); monkeypatch.setattr("harmonia_agent.generative_media.httpx.post", post)
    media = ElevenLabsGenerator(transport=AwsMediaTransport(enabled=True, generative_enabled=True, elevenlabs_api_key="test-key")).generate(request=MUSIC, estimated_cost_usd="1.000000")
    assert media.provider_id == "song-1"
    assert post.call_args.kwargs["json"] == {"model_id": "music_v1", "prompt": MUSIC["prompt"], "music_length_ms": 30000, "force_instrumental": True}

def test_pricing_has_no_silent_default():
    request = validate_nova_reel_request(VIDEO)
    with pytest.raises(MediaProtocolError): estimate_media_cost(request)
    assert estimate_media_cost(request, {"nova-reel": "0.010000"}) == "0.060000"

def test_python_serialized_provider_specs_match_typescript_contracts():
    import subprocess
    from pathlib import Path
    root = Path(__file__).resolve().parents[2]
    video = validate_nova_reel_request(VIDEO)
    music = validate_elevenlabs_request(MUSIC)
    for spec in (video, music):
        spec.pop("providerModel"); spec.pop("mediaKind")
    payload = json.dumps({"video": video, "music": music})
    script = "import {generatedVideoSpecSchema as v,generatedMusicSpecSchema as m} from './src/lib/mediaProduction.ts'; const x=JSON.parse(process.argv[1]); console.log(JSON.stringify({video:v.parse(x.video),music:m.parse(x.music)}));"
    result = subprocess.run([str(root / "node_modules/.bin/tsx"), "-e", script, payload], cwd=root, capture_output=True, text=True, check=True)
    assert json.loads(result.stdout) == json.loads(payload)

def test_multishot_native_request_and_supported_duration(monkeypatch):
    client = Mock(); client.start_async_invoke.return_value = {"invocationArn": "arn"}
    monkeypatch.setattr("harmonia_agent.generative_media.boto3.client", lambda *a, **k: client)
    request = validate_nova_reel_request({**VIDEO, "durationSec": 120, "prompt": "long narrative " * 100})
    AwsMediaTransport(enabled=True, generative_enabled=True).start_nova_reel(model=request["providerModel"], prompt=request["prompt"], duration_sec=120, source_image=None, storage_uri=PREFIX)
    body = client.start_async_invoke.call_args.kwargs["modelInput"]
    assert body["taskType"] == "MULTI_SHOT_AUTOMATED"
    assert body["multiShotAutomatedParams"] == {"text": request["prompt"]}
    assert body["videoGenerationConfig"]["durationSeconds"] == 120
    for duration in (7, 121, 0):
        with pytest.raises(MediaProtocolError): validate_nova_reel_request({**VIDEO, "durationSec": duration})

def test_paid_authorization_alone_does_not_enable_generation():
    with pytest.raises(MediaProviderError, match="disabled"):
        AwsMediaTransport(enabled=True).poll_nova_reel("arn", "model")

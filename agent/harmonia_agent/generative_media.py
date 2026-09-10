"""Approval-gated native AWS Nova Reel and ElevenLabs transports."""
from __future__ import annotations
import base64
import json
import re
from hashlib import sha256
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Callable
import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
import httpx

class MediaProtocolError(RuntimeError): pass
class MediaProviderError(RuntimeError):
    def __init__(self, message: str, *, permanent: bool = False):
        super().__init__(message)
        self.permanent = permanent
class MediaOperationPending(MediaProviderError):
    def __init__(self, operation_name: str):
        super().__init__(f"media operation pending: {operation_name}")
        self.operation_name = operation_name

NOVA_REEL_CAPABILITIES = {"nova-reel": {"model": "amazon.nova-reel-v1:1", "durations": set(range(6, 121, 6)), "resolutions": {"720p"}, "modes": {"text_to_video", "image_to_video"}, "usdPerSecond": None}}
ELEVENLABS_CAPABILITIES = {"elevenlabs-music": {"model": "music_v1", "maximumDurationSec": 600, "fixedCostUsd": None}}

def _validate_conditioning_reference(reference):
    if not isinstance(reference, dict) or set(reference) != {"artifactId", "digest", "mime", "sizeBytes", "rightsAuthorizationId"}:
        raise MediaProtocolError("conditioning artifact reference is malformed")
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", str(reference["artifactId"])) or not re.fullmatch(r"[a-f0-9]{64}", str(reference["digest"])) or reference["mime"] not in {"image/jpeg", "image/png"} or not isinstance(reference["sizeBytes"], int) or not 1 <= reference["sizeBytes"] <= 20 * 1024 * 1024 or not reference["rightsAuthorizationId"]:
        raise MediaProtocolError("conditioning artifact reference is malformed")
    return reference

def validate_nova_reel_request(request):
    value = dict(request)
    allowed = {"modelCapability", "mode", "prompt", "sourceImageArtifact", "durationSec", "aspectRatio", "resolution", "seed", "outputCount", "providerModel", "mediaKind"}
    if set(value) - allowed or value.get("modelCapability") != "nova-reel" or type(value.get("outputCount")) is not int or value.get("outputCount") != 1 or type(value.get("durationSec")) is not int or value.get("durationSec") not in range(6, 121, 6) or value.get("aspectRatio") != "16:9" or value.get("resolution") != "720p" or value.get("mode") not in {"text_to_video", "image_to_video"} or not isinstance(value.get("prompt"), str) or not 1 <= len(value["prompt"]) <= (512 if value["durationSec"] == 6 else 4000):
        raise MediaProtocolError("unsupported Nova Reel request")
    if (value["mode"] == "image_to_video") != bool(value.get("sourceImageArtifact")):
        raise MediaProtocolError("image conditioning must match mode")
    if value.get("sourceImageArtifact"):
        _validate_conditioning_reference(value["sourceImageArtifact"])
        if value["durationSec"] != 6: raise MediaProtocolError("multi-shot video cannot include an input image")
    if "seed" in value and (type(value["seed"]) is not int or not 0 <= value["seed"] <= 2147483646): raise MediaProtocolError("invalid seed")
    return {**value, "providerModel": "amazon.nova-reel-v1:1", "mediaKind": "video"}

def validate_elevenlabs_request(request):
    value = {"targetDurationSec": 30, **request}
    allowed = {"modelCapability", "prompt", "instrumental", "targetDurationSec", "outputCount", "providerModel", "mediaKind"}
    if set(value) - allowed or value.get("modelCapability") != "elevenlabs-music" or type(value.get("outputCount")) is not int or value.get("outputCount") != 1 or value.get("instrumental") is not True or type(value["targetDurationSec"]) is not int or not 3 <= value["targetDurationSec"] <= 600 or not isinstance(value.get("prompt"), str) or not 1 <= len(value["prompt"]) <= 4100:
        raise MediaProtocolError("unsupported ElevenLabs instrumental request")
    return {**value, "providerModel": "music_v1", "mediaKind": "music"}

def estimate_media_cost(request, overrides=None):
    rate = (overrides or {}).get(request["modelCapability"])
    if rate is None: raise MediaProtocolError("configured provider pricing is required")
    amount = Decimal(rate)
    if not amount.is_finite() or amount <= 0: raise MediaProtocolError("invalid provider pricing")
    return f"{amount * Decimal(request.get('durationSec', request.get('targetDurationSec', 30))):.6f}"

@dataclass(frozen=True)
class GeneratedMedia:
    data: bytes
    mime: str
    model: str
    provider_id: str
    duration_sec: int
    estimated_cost_usd: str
    provider_metadata: dict[str, Any] = field(default_factory=dict)

def _aws_call(call, **kwargs):
    try:
        return call(**kwargs)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "Unknown")
        transient = code in {"ThrottlingException", "TooManyRequestsException", "ServiceUnavailableException", "InternalServerException", "ModelNotReadyException", "RequestTimeout"}
        raise MediaProviderError(f"AWS media provider: {code}", permanent=not transient) from exc
    except BotoCoreError as exc:
        raise MediaProviderError(f"AWS media transport: {type(exc).__name__}") from exc

class AwsMediaTransport:
    def __init__(self, *, region="us-east-1", enabled=False, generative_enabled=False, elevenlabs_api_key=None):
        self.region, self.enabled, self.elevenlabs_api_key = region, enabled and generative_enabled, elevenlabs_api_key
    def _admit(self):
        if not self.enabled: raise MediaProviderError("paid provider operations disabled", permanent=True)
    def start_nova_reel(self, *, model, prompt, duration_sec, source_image, storage_uri, seed=None):
        self._admit()
        params = {"text": prompt}
        if source_image: params["images"] = [source_image]
        body = {**({"taskType": "TEXT_VIDEO", "textToVideoParams": params} if duration_sec == 6 else {"taskType": "MULTI_SHOT_AUTOMATED", "multiShotAutomatedParams": {"text": prompt}}), "videoGenerationConfig": {"durationSeconds": duration_sec, "fps": 24, "dimension": "1280x720", **({"seed": seed} if seed is not None else {})}}
        return _aws_call(boto3.client("bedrock-runtime", region_name=self.region, config=Config(retries={"max_attempts": 0})).start_async_invoke, modelId=model, modelInput=body, clientRequestToken=sha256(storage_uri.encode()).hexdigest(), outputDataConfig={"s3OutputDataConfig": {"s3Uri": storage_uri}})
    def poll_nova_reel(self, operation_name, model):
        self._admit()
        return _aws_call(boto3.client("bedrock-runtime", region_name=self.region).get_async_invoke, invocationArn=operation_name)
    def download_s3(self, uri, authorized_prefix):
        self._admit()
        if not uri.startswith(authorized_prefix) or not authorized_prefix.startswith("s3://") or not authorized_prefix.endswith("/"): raise MediaProtocolError("output outside authorized S3 prefix")
        bucket, key = uri[5:].split("/", 1)
        if ".." in key.split("/"): raise MediaProtocolError("invalid S3 key")
        return boto3.client("s3", region_name=self.region).get_object(Bucket=bucket, Key=key)["Body"].read()
    def generate_elevenlabs(self, *, model, prompt, request):
        self._admit()
        if not self.elevenlabs_api_key: raise MediaProviderError("ELEVENLABS_API_KEY required", permanent=True)
        response = httpx.post("https://api.elevenlabs.io/v1/music", params={"output_format": "mp3_44100_128"}, headers={"xi-api-key": self.elevenlabs_api_key}, json={"model_id": model, "prompt": prompt, "music_length_ms": request["targetDurationSec"] * 1000, "force_instrumental": True}, timeout=600)
        if response.status_code >= 300: raise MediaProviderError(f"ElevenLabs HTTP {response.status_code}", permanent=400 <= response.status_code < 500 and response.status_code != 429)
        identity = response.headers.get("song-id") or response.headers.get("request-id")
        if not identity or not response.content: raise MediaProtocolError("missing music bytes or provider receipt identity")
        return {"data": response.content, "id": identity}

def _decode(value: Any, *, media: str) -> bytes:
    if not isinstance(value, str) or not value:
        raise MediaProtocolError(f"{media} response is missing encoded data")
    try:
        data = base64.b64decode(value, validate=True)
    except ValueError as exc:
        raise MediaProtocolError(f"{media} response contains invalid encoded data") from exc
    if not data:
        raise MediaProtocolError(f"{media} response decoded to empty data")
    return data


_PROVENANCE_EXCLUDED_KEYS = {
    "audioContent", "bytesBase64Encoded", "bytes_base64_encoded", "data", "input", "prompt",
}


def _bounded_provenance(value: Any, *, depth: int = 0) -> Any:
    """Copy small JSON metadata while excluding prompts and encoded media payloads."""
    if depth > 4:
        return None
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:512]
    if isinstance(value, list):
        return [_bounded_provenance(item, depth=depth + 1) for item in value[:8]]
    if isinstance(value, dict):
        return {
            str(key)[:128]: _bounded_provenance(item, depth=depth + 1)
            for key, item in list(value.items())[:16]
            if str(key) not in _PROVENANCE_EXCLUDED_KEYS
        }
    return str(value)[:1000]


def _common_provider_provenance(response: dict[str, Any]) -> dict[str, Any]:
    usage = response.get("usageMetadata") or response.get("usage_metadata") or response.get("usage")
    model_status = (
        response.get("modelStatus") or response.get("model_status")
        or response.get("releaseStatus") or response.get("release_status")
    )
    cost = response.get("costMetadata") or response.get("cost_metadata")
    return {
        **({"usageMetadata": _bounded_provenance(usage)} if usage else {}),
        **({"modelStatus": _bounded_provenance(model_status)} if model_status else {}),
        **({"costMetadata": _bounded_provenance(cost)} if cost else {}),
    }


def _fit_provider_metadata(metadata: dict[str, Any], *, maximum_bytes: int = 3072) -> dict[str, Any]:
    """Keep prioritized provenance fields within the artifact transport's header budget."""
    result: dict[str, Any] = {}
    truncated = False
    for key, value in metadata.items():
        candidate = {**result, key: value}
        if len(json.dumps(candidate, separators=(",", ":")).encode("utf-8")) <= maximum_bytes:
            result[key] = value
            continue
        truncated = True
        if isinstance(value, str):
            low, high = 0, len(value)
            while low < high:
                midpoint = (low + high + 1) // 2
                candidate = {**result, key: value[:midpoint]}
                if len(json.dumps(candidate, separators=(",", ":")).encode("utf-8")) <= maximum_bytes - 32:
                    low = midpoint
                else:
                    high = midpoint - 1
            if low:
                result[key] = value[:low]
    if truncated:
        marker = {**result, "provenanceTruncated": True}
        if len(json.dumps(marker, separators=(",", ":")).encode("utf-8")) <= maximum_bytes:
            result["provenanceTruncated"] = True
    return result



class NovaReelGenerator:
    def __init__(self, *, transport): self.transport = transport
    def generate(self, *, request, existing_operation, persist_operation, authorized_output_prefix=None, conditioning_media=None, estimated_cost_usd):
        request = validate_nova_reel_request(request)
        if not authorized_output_prefix: raise MediaProtocolError("authorized S3 output prefix required")
        operation = existing_operation
        if not operation:
            image = None
            reference = request.get("sourceImageArtifact")
            if reference:
                data, mime, digest = (conditioning_media or {}).get(reference["artifactId"], (b"", "", ""))
                if not data or mime != reference["mime"] or digest != reference["digest"] or sha256(data).hexdigest() != digest or len(data) != reference["sizeBytes"]: raise MediaProtocolError("conditioning bytes do not match sealed identity")
                image = {"format": "jpeg" if mime == "image/jpeg" else "png", "source": {"bytes": base64.b64encode(data).decode()}}
            result = self.transport.start_nova_reel(model=request["providerModel"], prompt=request["prompt"], duration_sec=request["durationSec"], source_image=image, storage_uri=authorized_output_prefix, seed=request.get("seed"))
            operation = result.get("invocationArn")
            if not operation: raise MediaProtocolError("missing async invocation ARN")
            persist_operation(operation)
        result = self.transport.poll_nova_reel(operation, request["providerModel"])
        if result.get("status") == "InProgress": raise MediaOperationPending(operation)
        if result.get("status") != "Completed": raise MediaProtocolError("Nova Reel operation failed or malformed")
        prefix = result.get("outputDataConfig", {}).get("s3OutputDataConfig", {}).get("s3Uri", "")
        if not prefix.startswith(authorized_output_prefix): raise MediaProtocolError("output outside authorized prefix")
        uri = prefix.rstrip("/") + "/output.mp4"
        data = self.transport.download_s3(uri, authorized_output_prefix)
        if not data: raise MediaProtocolError("empty generated video")
        return GeneratedMedia(data, "video/mp4", request["providerModel"], operation, request["durationSec"], estimated_cost_usd, {"s3Uri": uri})

class ElevenLabsGenerator:
    def __init__(self, *, transport): self.transport = transport
    def generate(self, *, request, estimated_cost_usd):
        request = validate_elevenlabs_request(request)
        result = self.transport.generate_elevenlabs(model=request["providerModel"], prompt=request["prompt"], request=request)
        return GeneratedMedia(result["data"], "audio/mpeg", request["providerModel"], result["id"], request["targetDurationSec"], estimated_cost_usd)

"""Fenced SQS document normalization against immutable, tenant-bound S3 manifests.

normalize-document-v1 manifest: schemaVersion, workspaceId, brandId,
processorVersion, items [{partitionIndex, sourceId, title, mimeType, sourceUri,
sourceDigest}]. Outputs are content-addressed JSON in durable-artifacts, not
records in the separately governed production ArtifactStore.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import secrets
from datetime import datetime, timedelta, timezone
from io import BytesIO
from urllib.parse import urlsplit
from zipfile import ZipFile

import boto3
from botocore.exceptions import ClientError
from pydantic import BaseModel, ConfigDict, Field

from . import web_client
from .config import settings
from .tenant_context import tenant_scope
from .extraction.text import extract_text
from .extraction.documents import extract_docx, extract_pdf

MAX_BYTES = 8 * 1024 * 1024
PROCESSOR = "normalize-document-v1"
_ID = r"^[A-Za-z0-9_-]{1,128}$"
_SHA = r"^[a-f0-9]{64}$"


class InvalidDataWork(ValueError):
    """A permanent contract/content failure, safe to persist without raw content."""


class Envelope(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schemaVersion: int = Field(ge=1, le=1)
    workspaceId: str = Field(pattern=_ID)
    brandId: str = Field(pattern=_ID)
    batchId: str = Field(pattern=_ID)
    itemId: str = Field(pattern=_ID)
    partitionIndex: int = Field(ge=0)
    processorVersion: str
    manifestUri: str
    manifestDigest: str = Field(pattern=_SHA)


class ManifestItem(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    partitionIndex: int = Field(ge=0)
    sourceId: str = Field(pattern=_ID)
    title: str = Field(min_length=1, max_length=1000)
    mimeType: str
    sourceUri: str
    sourceDigest: str = Field(pattern=_SHA)


class Manifest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schemaVersion: int = Field(ge=1, le=1)
    workspaceId: str
    brandId: str
    processorVersion: str
    items: list[ManifestItem] = Field(min_length=1, max_length=1000000)


def _s3_location(uri: str, envelope: Envelope) -> tuple[str, str]:
    parts = urlsplit(uri)
    bucket = settings().media_output_bucket
    key = parts.path.removeprefix("/")
    prefixes = (f"artifacts/{envelope.workspaceId}/{envelope.brandId}/",
                f"durable-artifacts/{envelope.workspaceId}/{envelope.brandId}/")
    if (parts.scheme != "s3" or not bucket or parts.netloc != bucket or
            parts.query or parts.fragment or not key.startswith(prefixes) or
            any(piece in (".", "..", "") for piece in key.split("/"))):
        raise InvalidDataWork("unscoped S3 object")
    return bucket, key


def _read(s3, bucket: str, key: str) -> bytes:
    response = s3.get_object(Bucket=bucket, Key=key)
    stream = response["Body"]
    try:
        if response["ContentLength"] > MAX_BYTES:
            raise InvalidDataWork("object exceeds byte limit")
        body = stream.read(MAX_BYTES + 1)
    finally:
        stream.close()
    if len(body) > MAX_BYTES or len(body) != response["ContentLength"]:
        raise InvalidDataWork("invalid object size")
    return body


def _get_batch(path: str) -> dict:
    with web_client._client() as client:
        response = client.get(path)
        if response.status_code >= 400:
            raise web_client._response_error(path, response)
        return response.json()["batch"]


def _validate_authority(envelope: Envelope, batch: dict, item: dict | None = None) -> None:
    if any(batch.get(k) != getattr(envelope, k) for k in ("workspaceId", "brandId", "processorVersion")):
        raise InvalidDataWork("batch scope mismatch")
    if (batch.get("id") != envelope.batchId or
            batch["manifest"]["uri"] != envelope.manifestUri or
            batch["manifest"]["sha256"] != envelope.manifestDigest):
        raise InvalidDataWork("manifest authority mismatch")
    if item is not None and (item.get("id") != envelope.itemId or any(
            item.get(k) != getattr(envelope, k) for k in
            ("workspaceId", "brandId", "batchId", "partitionIndex", "processorVersion"))):
        raise InvalidDataWork("item authority mismatch")


def _normalize(envelope: Envelope, batch: dict, item: dict, s3) -> str:
    if envelope.processorVersion != PROCESSOR:
        raise InvalidDataWork("unsupported processor")
    raw_manifest = _read(s3, *_s3_location(envelope.manifestUri, envelope))
    if (hashlib.sha256(raw_manifest).hexdigest() != envelope.manifestDigest or
            len(raw_manifest) != batch["manifest"]["byteCount"]):
        raise InvalidDataWork("manifest digest mismatch")
    manifest = Manifest.model_validate_json(raw_manifest)
    if (any(getattr(manifest, k) != getattr(envelope, k) for k in
            ("workspaceId", "brandId", "processorVersion")) or
            len(manifest.items) != batch["manifest"]["itemCount"] or
            len({entry.partitionIndex for entry in manifest.items}) != len(manifest.items)):
        raise InvalidDataWork("manifest scope or partition mismatch")
    entries = [entry for entry in manifest.items if entry.partitionIndex == envelope.partitionIndex]
    if len(entries) != 1 or entries[0].sourceDigest != item["sourceDigest"]:
        raise InvalidDataWork("source authority mismatch")
    source = entries[0]
    body = _read(s3, *_s3_location(source.sourceUri, envelope))
    if hashlib.sha256(body).hexdigest() != source.sourceDigest:
        raise InvalidDataWork("source digest mismatch")
    receipt_id = "data-" + envelope.itemId
    if source.mimeType in ("text/plain", "text/markdown", "text/x-markdown"):
        normalized = extract_text(source.sourceId, source.title, body.decode("utf-8"), source.mimeType, receipt_id=receipt_id)
    elif source.mimeType == "application/pdf":
        normalized = extract_pdf(source.sourceId, source.title, body, receipt_id=receipt_id)
    elif source.mimeType == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        with ZipFile(BytesIO(body)) as archive:
            if sum(info.file_size for info in archive.infolist()) > 32 * MAX_BYTES:
                raise InvalidDataWork("expanded document exceeds limit")
        normalized = extract_docx(source.sourceId, source.title, body, receipt_id=receipt_id)
    else:
        raise InvalidDataWork("unsupported MIME type")
    if sum(len(segment.text) for segment in normalized.segments) > 1000000:
        raise InvalidDataWork("normalized text exceeds limit")
    # A stable authority timestamp keeps an interrupted write byte-identical on retry.
    result = {"schemaVersion": 1, "processorVersion": PROCESSOR,
              "workspaceId": envelope.workspaceId, "brandId": envelope.brandId,
              "batchId": envelope.batchId, "itemId": envelope.itemId,
              "manifestDigest": envelope.manifestDigest, "sourceDigest": source.sourceDigest,
              "normalizedSource": normalized.model_dump(mode="json")}
    result["normalizedSource"]["extractedAt"] = batch["createdAt"]
    output = json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    if len(output) > MAX_BYTES:
        raise InvalidDataWork("normalized output exceeds limit")
    digest = hashlib.sha256(output).hexdigest()
    bucket = settings().media_output_bucket
    key = f"durable-artifacts/{envelope.workspaceId}/{envelope.brandId}/data-normalized/{digest}.json"
    try:
        s3.put_object(Bucket=bucket, Key=key, Body=output, ContentType="application/json", IfNoneMatch="*")
    except ClientError as exc:
        if exc.response["Error"]["Code"] not in ("PreconditionFailed", "412"):
            raise
    if _read(s3, bucket, key) != output:
        raise RuntimeError("normalized artifact readback mismatch")
    return digest


def _process(envelope: Envelope) -> bool:
    with tenant_scope(envelope.workspaceId, envelope.brandId):
        path = f"/api/internal/data-plane/batches/{envelope.batchId}"
        batch = _get_batch(path)
        _validate_authority(envelope, batch)
        if batch["state"] in ("cancelled", "complete", "partial", "failed"):
            return True
        now = datetime.now(timezone.utc)
        token = secrets.token_urlsafe(48)
        item_path = path + f"/items/{envelope.itemId}"
        claim = web_client.post(item_path + "/claim", {"claimToken": token, "now": now.isoformat(),
            "leaseExpiresAt": (now + timedelta(minutes=10)).isoformat()})
        if claim["outcome"] in ("already_succeeded", "dead_lettered", "cancelled"):
            return True
        if claim["outcome"] != "execute":
            return False
        item = claim["item"]
        _validate_authority(envelope, batch, item)
        final = {"claimToken": token, "epoch": item["epoch"], "outcome": "succeeded", "artifactIds": []}
        try:
            s3 = boto3.client("s3", region_name=settings().aws_region)
            final["artifactIds"] = [_normalize(envelope, batch, item, s3)]
        except ValueError:
            # Only known invalid content/contracts are finalized. Transport, unknown
            # writes and unexpected parser failures retain the lease for recovery.
            final.update(outcome="failed", failureCode="invalid_data_contract")
        final["now"] = datetime.now(timezone.utc).isoformat()
        saved = web_client.post(item_path + "/finalize", final)["item"]
        return saved["state"] in ("succeeded", "dead_lettered", "cancelled")


async def handle_data(data: dict, attributes: dict, message_id: str, attempt: int) -> bool:
    envelope = Envelope.model_validate(data)
    if any(attributes.get(key) != str(getattr(envelope, key)) for key in
           ("schemaVersion", "workspaceId", "brandId", "batchId", "itemId", "processorVersion")):
        raise InvalidDataWork("queue attribute mismatch")
    return await asyncio.to_thread(_process, envelope)

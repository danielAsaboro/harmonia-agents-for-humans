"""Authorized extracted-source indexing, with persisted idempotent ingestion state."""
from __future__ import annotations
import hashlib
import json
import os
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
import boto3
from botocore.exceptions import ClientError
from . import web_client
from .aws_authority import require_paid_aws
from .config import settings
from .tenant_context import current_tenant
from .agent_models import NormalizedSource


class KnowledgeIndexPending(RuntimeError):
    def __init__(self, deadline_at: str):
        super().__init__("Knowledge ingestion pending; resume stored job polling")
        self.deadline_at = deadline_at
        self.next_poll_at = (datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat()



def _record(path):
    with web_client._client() as client:
        response = client.get(path)
    if response.status_code != 200:
        raise web_client._response_error(path, response)
    return response.json().get("record")


def _verified_put(s3, bucket, key, body, content_type):
    try:
        s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type, IfNoneMatch="*")
    except ClientError as exc:
        if exc.response["Error"]["Code"] not in ("PreconditionFailed", "412"):
            raise
    response = s3.get_object(Bucket=bucket, Key=key)
    stream = response["Body"]
    try:
        reread = stream.read(len(body) + 1)
    finally:
        stream.close()
    if reread != body:
        raise RuntimeError("Knowledge object readback mismatch")


def validate_current_source(source_id: str, digest: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", source_id) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise PermissionError("Invalid knowledge source identity")
    tenant = current_tenant()
    source = web_client.get_source(source_id)["source"]
    if (source.get("workspaceId") != tenant.workspace_id or source.get("brandId") != tenant.brand_id or
            source.get("state") != "ready" or source.get("contentDigest") != digest or
            not source.get("rightsAuthorizationId") or not source.get("normalizedArtifactId")):
        raise PermissionError("Knowledge evidence is no longer authorized/current")
    return source


def _usage(record: dict) -> dict:
    return {"id": "knowledge-index-" + record["operationId"], "jobId": record["jobId"],
        "operationId": record["operationId"], "stage": "extract_sources", "role": "knowledge_index",
        "model": "amazon.titan-embed-text-v2:0", "inputUnits": record["estimatedInputUnits"], "outputUnits": 0,
        "unitType": "tokens", "estimatedCostUsd": record["estimatedCostUsd"],
        "pricingVersion": record["pricingVersion"], "measurementBasis": "utf8_byte_token_upper_bound",
        "observedCostUnavailable": True, "traceId": record["operationId"][:32], "createdAt": record["createdAt"]}


def _identity(record: dict) -> dict:
    return {key: record[key] for key in ("jobId", "operationId", "clientToken", "sourceDigest", "objectUri",
        "estimatedInputUnits", "estimatedCostUsd", "pricingVersion")}


def _terminal(path: str, record: dict, state: str, *, error: str | None = None, not_invoked: bool = False):
    payload = {**_identity(record), "state": state}
    if record.get("ingestionJobId"):
        payload["ingestionJobId"] = record["ingestionJobId"]
    if error:
        payload["error"] = error
    if not_invoked:
        payload["budgetOutcome"] = "not_invoked"
    else:
        payload["usageRecord"] = _usage(record)
    return web_client.post(path, payload)["record"]


def index_job_sources(job_id: str) -> None:
    config = settings()
    if not config.bedrock_knowledge_base_id:
        return
    require_paid_aws("index authorized source knowledge")
    data_source = os.environ.get("BEDROCK_DATA_SOURCE_ID")
    if not data_source or not config.media_output_bucket:
        raise ValueError("BEDROCK_DATA_SOURCE_ID and MEDIA_OUTPUT_BUCKET required")
    tenant = current_tenant()
    package = web_client.get_source_manifest(job_id)
    authorized = {source["id"] for source in package.get("sources", []) if source.get("state") == "ready"}
    price = Decimal(os.environ.get("EMBEDDING_INPUT_USD_PER_MILLION", "NaN"))
    pricing_version = os.environ.get("EMBEDDING_PRICING_VERSION", "")
    if not price.is_finite() or price <= 0 or not pricing_version:
        raise ValueError("Verified embedding price and pricing version required")
    candidates = []
    pending_deadlines = []
    # Acquire canonical source authority and reserve all candidates before uploads.
    for raw in package.get("normalizedSources", []):
        normalized = NormalizedSource.model_validate(raw)
        if normalized.sourceId not in authorized:
            raise PermissionError("Normalized source absent from authoritative manifest")
        source = validate_current_source(normalized.sourceId, normalized.contentDigest)
        text = "\n\n".join(segment.text for segment in normalized.segments).encode()
        if not 0 < len(text) <= 8 * 1024 * 1024:
            raise ValueError("Knowledge source exceeds text bound")
        token = hashlib.sha256("\0".join(("knowledge-index", tenant.workspace_id, tenant.brand_id, normalized.sourceId, normalized.contentDigest)).encode()).hexdigest()
        key = f"knowledge/{tenant.workspace_id}/{tenant.brand_id}/{normalized.sourceId}/{normalized.contentDigest}.txt"
        path = f"/api/internal/sources/{normalized.sourceId}/knowledge-index"
        previous = _record(path + "?sourceDigest=" + normalized.contentDigest)
        estimate = format((Decimal(len(text)) * price / Decimal(1000000)).quantize(Decimal("0.000001"), rounding="ROUND_CEILING"), "f")
        proposed = {"jobId": job_id, "operationId": token, "clientToken": token,
            "sourceDigest": normalized.contentDigest, "objectUri": f"s3://{config.media_output_bucket}/{key}",
            "estimatedInputUnits": len(text), "estimatedCostUsd": estimate, "pricingVersion": pricing_version}
        if previous:
            for field in ("estimatedInputUnits", "estimatedCostUsd", "pricingVersion"):
                proposed[field] = previous[field]
        # POST revalidates the caller's own manifest and returns an existing owner
        # unchanged. Recording prepared first lets erasure track any later writes.
        record = web_client.post(path, {**proposed, "state": "prepared"})["record"]
        if any(record.get(k) != proposed[k] for k in ("operationId", "clientToken", "sourceDigest", "objectUri")):
            raise PermissionError("Knowledge submission authority changed")
        if record["state"] == "complete":
            continue
        if record["state"] == "failed":
            raise RuntimeError("Knowledge ingestion previously failed; reconciliation required")
        deadline = datetime.fromisoformat(record["createdAt"].replace("Z", "+00:00")) + timedelta(minutes=30)
        if record["jobId"] != job_id:
            pending_deadlines.append(deadline)
            continue  # Its original owner's independent recovery owns submission.
        try:
            web_client.reserve_budget({"jobId": record["jobId"], "operationId": token, "stage": "extract_sources",
                "role": "knowledge_index", "model": "amazon.titan-embed-text-v2:0",
                "estimatedCostUsd": record["estimatedCostUsd"], "pricingVersion": record["pricingVersion"]})
        except Exception:
            # No upload has occurred in this pass. Only newly prepared reservations
            # are known not dispatched; old prepared rows may represent a lost call.
            for prior in candidates:
                if prior[4]:
                    _terminal(prior[2], prior[3], "failed", error="pre_dispatch_budget_failure", not_invoked=True)
            raise
        candidates.append((normalized, text, path, record, previous is None, key))
    s3 = boto3.client("s3", region_name=config.aws_region)
    bedrock = boto3.client("bedrock-agent", region_name=config.aws_region)
    for normalized, text, path, record, newly_prepared, key in candidates:
        deadline = datetime.fromisoformat(record["createdAt"].replace("Z", "+00:00")) + timedelta(minutes=30)
        if datetime.now(timezone.utc) >= deadline:
            # A prior prepared call can have an unknown outcome, so keep its funds.
            raise TimeoutError("Knowledge ingestion exceeded deadline; reconciliation required")
        if record["state"] == "prepared":
            try:
                source = validate_current_source(normalized.sourceId, normalized.contentDigest)
                if _record(path + "?sourceDigest=" + normalized.contentDigest) is None:
                    raise PermissionError("Knowledge rights authority revoked")
            except (PermissionError, ValueError):
                if newly_prepared:
                    _terminal(path, record, "failed", error="pre_dispatch_authority_failure", not_invoked=True)
                raise
            metadata = {"metadataAttributes": {"workspaceId": tenant.workspace_id, "brandId": tenant.brand_id,
                "sourceId": normalized.sourceId, "sourceDigest": normalized.contentDigest,
                "rightsAuthorizationId": source["rightsAuthorizationId"], "title": normalized.title[:300]}}
            _verified_put(s3, config.media_output_bucket, key, text, "text/plain")
            _verified_put(s3, config.media_output_bucket, key + ".metadata.json",
                json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode(), "application/json")
            validate_current_source(normalized.sourceId, normalized.contentDigest)
            if _record(path + "?sourceDigest=" + normalized.contentDigest) is None:
                raise PermissionError("Knowledge rights authority revoked before ingestion")
            try:
                result = bedrock.start_ingestion_job(knowledgeBaseId=config.bedrock_knowledge_base_id,
                    dataSourceId=data_source, clientToken=record["clientToken"], description=f"Harmonia source {normalized.sourceId}"[:200])
            except ClientError as exc:
                if exc.response["Error"]["Code"] != "ConflictException":
                    raise
                pending_deadlines.append(deadline)
                continue
            record = web_client.post(path, {**_identity(record), "state": "submitted",
                "ingestionJobId": result["ingestionJob"]["ingestionJobId"]})["record"]
        result = bedrock.get_ingestion_job(knowledgeBaseId=config.bedrock_knowledge_base_id,
            dataSourceId=data_source, ingestionJobId=record["ingestionJobId"])["ingestionJob"]
        status = result["status"]
        if status == "COMPLETE" and not result.get("statistics", {}).get("numberOfDocumentsFailed", 0):
            _terminal(path, record, "complete")
        elif status in ("FAILED", "STOPPED", "COMPLETE"):
            _terminal(path, record, "failed", error="provider_ingestion_failed")
            raise RuntimeError("Knowledge ingestion failed")
        else:
            pending_deadlines.append(deadline)
    if pending_deadlines:
        raise KnowledgeIndexPending(min(pending_deadlines).isoformat())


def recover_pending_indexes() -> list[dict]:
    if not settings().bedrock_knowledge_base_id:
        return []
    require_paid_aws("recover authorized knowledge ingestion")
    path = "/api/internal/knowledge-index/pending?limit=20"
    with web_client._client() as client:
        response = client.get(path)
    if response.status_code != 200:
        raise web_client._response_error(path, response)
    results = []
    for job_id in dict.fromkeys(record["jobId"] for record in response.json()["records"]):
        try:
            index_job_sources(job_id)
            results.append({"jobId": job_id, "status": "complete"})
        except KnowledgeIndexPending:
            results.append({"jobId": job_id, "status": "pending"})
    return results


def recover_knowledge_erasures() -> list[dict]:
    """Recover deletion outbox outside tenant enumeration, including deleted workspaces."""
    config = settings()
    if not config.bedrock_knowledge_base_id:
        return []
    require_paid_aws("reconcile authorized knowledge erasure")
    data_source = os.environ.get("BEDROCK_DATA_SOURCE_ID")
    if not data_source:
        raise ValueError("BEDROCK_DATA_SOURCE_ID required")
    path = "/api/internal/knowledge-erasure"
    def request(method, payload=None):
        with web_client._client(tenant_required=False) as client:
            response = client.get(path) if method == "GET" else client.post(path, json=payload)
        if response.status_code != 200:
            raise web_client._response_error(path, response)
        return response.json()
    records = request("GET")["records"][:20]
    bedrock = boto3.client("bedrock-agent", region_name=config.aws_region)
    results = []
    for record in records:
        if record["state"] == "pending":
            record = request("POST", {"id": record["id"], "state": "s3_erased"})["record"]
        if record["state"] == "s3_erased":
            try:
                job = bedrock.start_ingestion_job(knowledgeBaseId=config.bedrock_knowledge_base_id,
                    dataSourceId=data_source, clientToken=record["clientToken"], description="Harmonia authorized source erasure")["ingestionJob"]
            except ClientError as exc:
                if exc.response["Error"]["Code"] != "ConflictException":
                    raise
                results.append({"id": record["id"], "state": "pending"})
                continue
            record = request("POST", {"id": record["id"], "state": "sync_submitted",
                "ingestionJobId": job["ingestionJobId"]})["record"]
        if record["state"] == "sync_submitted":
            job = bedrock.get_ingestion_job(knowledgeBaseId=config.bedrock_knowledge_base_id,
                dataSourceId=data_source, ingestionJobId=record["ingestionJobId"])["ingestionJob"]
            if job["status"] == "COMPLETE" and not job.get("statistics", {}).get("numberOfDocumentsFailed", 0):
                record = request("POST", {"id": record["id"], "state": "complete",
                    "ingestionJobId": record["ingestionJobId"]})["record"]
            elif job["status"] in ("FAILED", "STOPPED", "COMPLETE"):
                raise RuntimeError("Knowledge erasure sync failed; reconciliation required")
        results.append({"id": record["id"], "state": record["state"]})
    return results

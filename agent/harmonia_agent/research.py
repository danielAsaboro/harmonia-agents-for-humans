"""Host-bound research via IAM-authenticated AgentCore Gateway and Bedrock KB."""
from __future__ import annotations
import hashlib
import json
import os
from urllib.parse import urlsplit
import boto3
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
import httpx
from strands import tool
from .aws_authority import require_paid_aws
from .tenant_context import current_tenant


def _gateway_search(query: str) -> tuple[list[dict], dict]:
    require_paid_aws('AgentCore Gateway web search')
    if len(query) > 200:
        raise ValueError('Gateway WebSearch query must be at most 200 characters')
    url = os.environ.get('AGENTCORE_GATEWAY_URL', '')
    name = os.environ.get('AGENTCORE_GATEWAY_SEARCH_TOOL', '')
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or not name:
        raise ValueError('Gateway HTTPS URL and exact registered search tool are required')
    session = boto3.Session()
    credentials = session.get_credentials()
    if credentials is None:
        raise PermissionError('AWS signing credentials unavailable')
    body = json.dumps({'jsonrpc': '2.0', 'id': hashlib.sha256(query.encode()).hexdigest(),
        'method': 'tools/call', 'params': {'name': name, 'arguments': {'query': query, 'maxResults': 8}}})
    request = AWSRequest(method='POST', url=url, data=body, headers={'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'})
    SigV4Auth(credentials.get_frozen_credentials(), 'bedrock-agentcore', os.environ.get('AWS_REGION', 'us-east-1')).add_auth(request)
    with httpx.Client(timeout=30, follow_redirects=False) as client:
        response = client.post(url, content=body, headers=dict(request.headers))
        response.raise_for_status()
    value = response.json()
    if value.get('error') or (value.get('result') or {}).get('isError'):
        raise RuntimeError('Gateway search failed')
    result = value['result']
    data = result.get('structuredContent')
    if data is None:
        texts = [item['text'] for item in result.get('content', []) if item.get('type') == 'text']
        if len(texts) != 1:
            raise ValueError('Gateway must return one structured search result')
        data = json.loads(texts[0])
    # The deployed Gateway target contract is explicit; schema mismatches fail visibly.
    sources = data.get('results')
    if not isinstance(sources, list) or not 1 <= len(sources) <= 8:
        raise ValueError('Gateway search requires 1..8 source results')
    sources = [{'title': item.get('title') or item.get('url'), 'url': item.get('url'), 'content': item.get('text')} for item in sources]
    return sources, {'provider': 'agentcore_gateway', 'requestId': response.headers.get('x-amzn-requestid'),
                     'tool': name, 'query': query, 'responseSha256': hashlib.sha256(response.content).hexdigest()}


def _knowledge_search(query: str, knowledge_base_id: str) -> tuple[list[dict], dict]:
    require_paid_aws('Bedrock Knowledge Bases retrieval')
    tenant = current_tenant()
    response = boto3.client('bedrock-agent-runtime', region_name=os.environ.get('AWS_REGION', 'us-east-1')).retrieve(
        knowledgeBaseId=knowledge_base_id, retrievalQuery={'text': query},
        retrievalConfiguration={'vectorSearchConfiguration': {'numberOfResults': 8, 'filter': {'andAll': [
            {'equals': {'key': 'workspaceId', 'value': tenant.workspace_id}},
            {'equals': {'key': 'brandId', 'value': tenant.brand_id}},
        ]}}})
    sources = []
    for item in response.get('retrievalResults', []):
        metadata = item.get('metadata') or {}
        if metadata.get('workspaceId') != tenant.workspace_id or metadata.get('brandId') != tenant.brand_id:
            raise PermissionError('Knowledge base returned cross-tenant evidence')
        from .knowledge_index import validate_current_source, _record
        source = validate_current_source(str(metadata.get('sourceId') or ''), str(metadata.get('sourceDigest') or ''))
        index = _record(f"/api/internal/sources/{source['id']}/knowledge-index?sourceDigest={source['contentDigest']}")
        if not index or index.get('state') != 'complete':
            raise PermissionError('Knowledge source ingestion is not complete')
        if metadata.get('rightsAuthorizationId') != source['rightsAuthorizationId']:
            raise PermissionError('Knowledge rights authorization changed')
        location = item.get('location') or {}
        url = (location.get('s3Location') or {}).get('uri') or (location.get('webLocation') or {}).get('url')
        expected_key = f"knowledge/{tenant.workspace_id}/{tenant.brand_id}/{source['id']}/{source['contentDigest']}.txt"
        from .config import settings
        if url != f"s3://{settings().media_output_bucket}/{expected_key}":
            raise PermissionError('Knowledge source location does not match authoritative source')
        sources.append({'title': metadata.get('title') or url, 'url': url, 'content': (item.get('content') or {}).get('text')})
    if not sources:
        raise ValueError('Knowledge base returned no supporting evidence')
    raw = json.dumps(response, sort_keys=True, default=str).encode()
    return sources, {'provider': 'bedrock_knowledge_base', 'requestId': response.get('ResponseMetadata', {}).get('RequestId'),
                     'knowledgeBaseId': knowledge_base_id, 'query': query, 'responseSha256': hashlib.sha256(raw).hexdigest()}


def research_tool(name: str, kind: str, knowledge_base_id: str | None = None):
    @tool(name=name, description='Execute the exact host-authorized typed research request once. Return provider-backed source evidence.')
    def search(request: dict) -> dict:
        """Read provider evidence for the exact request. Args: request: Host-issued typed research request."""
        query = request.get('question')
        if not isinstance(query, str) or not query.strip() or len(query) > 500:
            raise ValueError('Research request requires bounded question')
        sources, receipt = _knowledge_search(query, knowledge_base_id) if knowledge_base_id else _gateway_search(query)
        output = []
        for item in sources:
            title, url, content = item.get('title'), item.get('url'), item.get('content')
            if not all(isinstance(v, str) and v.strip() for v in (title, url, content)):
                raise ValueError('Provider source must contain title, URL and supporting content')
            if not url.startswith(('https://', 'http://', 's3://')):
                raise ValueError('Unsupported research evidence URI')
            prefix = 'analysis-search-' if kind == 'analysis' else 'search-'
            output.append({'evidenceId': prefix + hashlib.sha256((url + content).encode()).hexdigest()[:24],
                           'title': title[:300], 'url': url, 'supportedText': content[:1000]})
        receipt['sources'] = output
        result = {'query': query, 'sources': output, '_providerEvidence': receipt}
        result['briefId' if kind == 'writing' else 'requestId'] = request.get('briefId') if kind == 'writing' else request.get('id')
        if kind == 'analysis': result['mode'] = request.get('mode')
        return result
    return search


def validate_provider_sources(metadata: dict, sources: list, *, mode: str = 'public_web') -> None:
    expected = 'bedrock_knowledge_base' if mode == 'private_index' else 'agentcore_gateway'
    if not isinstance(metadata, dict) or metadata.get('provider') != expected or not metadata.get('responseSha256'):
        raise ValueError('Research requires the actual AWS provider response receipt')
    recorded = metadata.get('sources') or []
    for source in sources:
        value = source.model_dump(mode='json') if hasattr(source, 'model_dump') else source
        if value not in recorded:
            raise ValueError('Research source is absent from the actual provider response')

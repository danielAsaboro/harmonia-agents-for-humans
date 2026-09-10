import os
import json

os.environ.setdefault('WEB_INTERNAL_URL', 'http://localhost:3000')
os.environ.setdefault('INTERNAL_API_TOKEN', 'test-token-not-a-secret')
os.environ.setdefault('GITHUB_TOKEN', 'ghp_fake-token-for-unit-tests')
os.environ.setdefault('AWS_REGION', 'us-east-1')
os.environ.setdefault('AWS_EC2_METADATA_DISABLED', 'true')
os.environ.setdefault('AGENTCORE_RUNTIME_ARN', 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/harmonia-test')
# Offline accounting fixture rates, never deployment rates or live price evidence.
os.environ.setdefault('BEDROCK_TEXT_PRICING_JSON', json.dumps({key: {'input': 1, 'output': 5} for key in (
    'us.anthropic.claude-sonnet-4-6', 'us.anthropic.claude-haiku-4-5-20251001-v1:0', 'us.amazon.nova-2-lite-v1:0',
    'gemini-3.7-flash', 'gemini-test', 'test-model',
)}))

"""Read-only AWS access checks. Does not deploy, invoke models, or generate media."""
import json
import os
import sys
import boto3

REGION = os.environ.get('AWS_REGION', 'us-east-1')
MODELS = (
    'anthropic.claude-haiku-4-5-20251001-v1:0',
    'anthropic.claude-sonnet-4-6', 'amazon.nova-2-lite-v1:0',
    'amazon.nova-canvas-v1:0', 'amazon.nova-reel-v1:1',
    'amazon.titan-embed-text-v2:0',
)

def main():
    result = {'region': REGION, 'readOnly': True, 'models': [], 'ok': False}
    try:
        identity = boto3.client('sts', region_name=REGION).get_caller_identity()
        result['account'] = identity['Account']
        bedrock = boto3.client('bedrock', region_name=REGION)
        for model in MODELS:
            value = bedrock.get_foundation_model_availability(modelId=model)
            result['models'].append({key: value.get(key) for key in (
                'modelId', 'agreementAvailability', 'authorizationStatus',
                'entitlementAvailability', 'regionAvailability')})
        result['ok'] = all(
            item.get('authorizationStatus') == 'AUTHORIZED'
            and item.get('entitlementAvailability') == 'AVAILABLE'
            and item.get('regionAvailability') == 'AVAILABLE'
            and (item.get('agreementAvailability') or {}).get('status') == 'AVAILABLE'
            for item in result['models'])
    except Exception as error:
        # Credential/provider text can contain sensitive paths or request details.
        result['errorClass'] = type(error).__name__
    print(json.dumps(result, indent=2))
    return 0 if result['ok'] else 1

if __name__ == '__main__':
    sys.exit(main())

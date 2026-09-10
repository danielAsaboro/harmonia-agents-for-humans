"""Authenticated AgentCore Runtime entry point for the native Strands team."""
import os
import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from pydantic import BaseModel, ConfigDict, Field
from .agents import build_agent_team
from .team_runtime import LocalStrandsTeamRuntime
from .tenant_context import tenant_scope
from .aws_authority import require_paid_aws

app = BedrockAgentCoreApp()

class Invocation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    specialist: str
    payload: dict
    userId: str = Field(min_length=1)
    sessionKey: str = Field(min_length=1)
    workspaceId: str
    brandId: str

@app.entrypoint
async def invoke(payload, context):
    # IAM authorizes this runtime endpoint. The worker sends the same validated tenant
    # envelope as its durable operation; model output never supplies these fields.
    request = Invocation.model_validate(payload)
    require_paid_aws('AgentCore cognition')
    if not os.environ.get('INTERNAL_API_TOKEN'):
        secret_arn = os.environ.get('INTERNAL_API_TOKEN_SECRET_ARN')
        if not secret_arn:
            raise PermissionError('internal API token secret ARN required')
        secret = boto3.client('secretsmanager', region_name=os.environ.get('AWS_REGION','us-east-1')).get_secret_value(SecretId=secret_arn)
        token = secret.get('SecretString')
        if not isinstance(token, str) or not token:
            raise PermissionError('internal API token secret is empty')
        os.environ['INTERNAL_API_TOKEN'] = token
    if not request.userId.startswith(request.workspaceId + ':'):
        raise PermissionError('runtime actor is outside workspace')
    with tenant_scope(request.workspaceId, request.brandId):
        state = await LocalStrandsTeamRuntime(build_agent_team()).invoke(
            specialist=request.specialist, payload=request.payload,
            user_id=request.userId, session_key=request.sessionKey)
    return {'state': state}

if __name__ == '__main__':
    app.run()

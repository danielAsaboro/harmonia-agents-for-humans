"""Reproducible deployment entry point for Harmonia's managed cognitive team."""

from __future__ import annotations

import argparse
import os
from typing import Any, Mapping

from .agent_engine_app import build_agent_engine_app

_FORWARDED_ENV = {
    "COORDINATOR_MODEL_ID",
    "STRATEGIST_MODEL_ID",
    "ANALYST_MODEL_ID",
    "COPYWRITER_MODEL_ID",
    "EDITOR_MODEL_ID",
    "PLANNER_MODEL_ID",
    "PRESENTER_MODEL_ID",
    "HARMONIA_TELEMETRY_ENABLED",
    "HARMONIA_TELEMETRY_SAMPLE_RATE",
    "OTEL_SERVICE_NAME",
    "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
    "ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS",
    "WEB_INTERNAL_URL",
}


def build_deployment_config(
    *,
    staging_bucket: str,
    service_account: str,
    environment: Mapping[str, str],
) -> dict[str, Any]:
    if not staging_bucket.startswith("gs://"):
        raise ValueError("staging bucket must be a gs:// URI")
    if "@" not in service_account:
        raise ValueError("service account must be a full email address")
    return {
        "display_name": "harmonia-cognitive-team",
        "description": "Typed Harmonia ADK coordinator and specialist hierarchy",
        "requirements": [
            "google-cloud-aiplatform[agent_engines,adk]==1.165.1",
            "google-adk==2.7.1",
            "cloudpickle>=3.1,<4",
            "pydantic>=2.8,<3",
            "fastapi>=0.115",
            "httpx>=0.27",
            "beautifulsoup4>=4.12",
            "google-cloud-firestore>=2.19",
            "google-cloud-pubsub>=2.21",
            "opentelemetry-api>=1.36,<2",
            "opentelemetry-sdk>=1.36,<2",
            "opentelemetry-exporter-otlp-proto-grpc>=1.42,<2",
            "opentelemetry-instrumentation-fastapi>=0.57b0,<1",
            "opentelemetry-instrumentation-httpx>=0.57b0,<1",
        ],
        # The SDK archives relative paths at the package root. Absolute paths
        # retain workstation parents and are not importable under /code.
        "extra_packages": ["harmonia_agent"],
        "staging_bucket": staging_bucket,
        "service_account": service_account,
        "env_vars": {
            key: value for key, value in environment.items()
            if key in _FORWARDED_ENV and value
        } | {
            # Gemini 3.5 is verified on Vertex's global endpoint. Pin both the
            # provider and location so Agent Engine's regional runtime defaults
            # cannot silently move model traffic or consume Developer API quota.
            "GOOGLE_GENAI_USE_VERTEXAI": "true",
            "GEMINI_VERTEX_LOCATION": "global",
            "INTERNAL_API_TOKEN": {"secret": "internal-api-token", "version": "latest"},
            "GEMINI_API_KEY": {"secret": "gemini-api-key", "version": "latest"},
        },
    }


def deploy(*, project: str, location: str, staging_bucket: str, service_account: str) -> str:
    try:
        import vertexai
    except ImportError as exc:  # pragma: no cover - deployment-only dependency
        raise RuntimeError("install the agent requirements before deployment") from exc
    client = vertexai.Client(project=project, location=location)
    remote = client.agent_engines.create(
        agent=build_agent_engine_app(vertex_location="global"),
        config=build_deployment_config(
            staging_bucket=staging_bucket,
            service_account=service_account,
            environment=os.environ,
        ),
    )
    name = getattr(getattr(remote, "api_resource", None), "name", None)
    if not name:
        raise RuntimeError("Agent Engine deployment returned no resource name")
    return str(name)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--location", default="us-central1")
    parser.add_argument("--staging-bucket", required=True)
    parser.add_argument("--service-account", required=True)
    args = parser.parse_args()
    print(deploy(
        project=args.project,
        location=args.location,
        staging_bucket=args.staging_bucket,
        service_account=args.service_account,
    ))


if __name__ == "__main__":
    main()

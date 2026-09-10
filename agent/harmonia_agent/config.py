"""Harmonia AWS worker service configuration (12-factor environment)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from .model_catalog import PRICING_VERSION


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing required environment variable: {name}")
    return value


def _bool_env(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    web_internal_url: str
    internal_api_token: str
    model_id: str
    aws_region: str
    allow_paid_aws: bool
    elevenlabs_api_key: str | None
    transcribe_cost_per_second_usd: str | None
    github_token: str | None
    pricing_version: str
    telemetry_enabled: bool
    telemetry_sample_rate: float
    otel_service_name: str
    image_max_cost_usd: str
    agentcore_runtime_arn: str
    agentcore_gateway_url: str | None
    bedrock_knowledge_base_id: str | None
    memory_bank_enabled: bool
    agentcore_memory_id: str | None
    generative_media_enabled: bool
    media_output_bucket: str | None
    durable_recovery_limit: int
    durable_recovery_deadline_seconds: int
    durable_recovery_max_retries: int
    durable_recovery_max_cost_usd: str

    @classmethod
    def load(cls) -> "Settings":
        pricing_version = os.environ.get("MODEL_PRICING_VERSION", PRICING_VERSION)
        if pricing_version != PRICING_VERSION:
            raise RuntimeError(
                f"unsupported MODEL_PRICING_VERSION: {pricing_version}; expected {PRICING_VERSION}"
            )
        telemetry_sample_rate = float(os.environ.get("HARMONIA_TELEMETRY_SAMPLE_RATE", "1.0"))
        if not 0 <= telemetry_sample_rate <= 1:
            raise RuntimeError("HARMONIA_TELEMETRY_SAMPLE_RATE must be between 0 and 1")
        image_max_cost_usd = os.environ.get("IMAGE_MAX_COST_USD", "0.500000")
        try:
            image_max_cost_usd = f"{Decimal(image_max_cost_usd):.6f}"
            if Decimal(image_max_cost_usd) <= 0:
                raise ValueError
        except (InvalidOperation, ValueError) as exc:
            raise RuntimeError("IMAGE_MAX_COST_USD must be a positive decimal") from exc
        recovery_limit = int(os.environ.get("DURABLE_RECOVERY_LIMIT", "20"))
        recovery_deadline = int(os.environ.get("DURABLE_RECOVERY_DEADLINE_SECONDS", "15"))
        recovery_retries = int(os.environ.get("DURABLE_RECOVERY_MAX_RETRIES", "3"))
        recovery_cost = os.environ.get("DURABLE_RECOVERY_MAX_COST_USD", "0.250000")
        if not 1 <= recovery_limit <= 100:
            raise RuntimeError("DURABLE_RECOVERY_LIMIT must be between 1 and 100")
        if not 1 <= recovery_deadline <= 60:
            raise RuntimeError("DURABLE_RECOVERY_DEADLINE_SECONDS must be between 1 and 60")
        if not 0 <= recovery_retries <= 20:
            raise RuntimeError("DURABLE_RECOVERY_MAX_RETRIES must be between 0 and 20")
        try:
            recovery_cost = f"{Decimal(recovery_cost):.6f}"
            if Decimal(recovery_cost) < 0:
                raise ValueError
        except (InvalidOperation, ValueError) as exc:
            raise RuntimeError("DURABLE_RECOVERY_MAX_COST_USD must be a nonnegative decimal") from exc
        return cls(
            web_internal_url=_require("WEB_INTERNAL_URL").rstrip("/"),
            internal_api_token=_require("INTERNAL_API_TOKEN"),
            model_id=os.environ.get("MODEL_ID", "us.anthropic.claude-sonnet-4-6"),
            aws_region=os.environ.get("AWS_REGION", "us-east-1"),
            allow_paid_aws=_bool_env("HARMONIA_ALLOW_PAID_AWS"),
            elevenlabs_api_key=os.environ.get("ELEVENLABS_API_KEY") or None,
            transcribe_cost_per_second_usd=os.environ.get("TRANSCRIBE_COST_PER_SECOND_USD") or None,
            github_token=os.environ.get("GITHUB_TOKEN"),
            pricing_version=pricing_version,
            telemetry_enabled=_bool_env("HARMONIA_TELEMETRY_ENABLED"),
            telemetry_sample_rate=telemetry_sample_rate,
            otel_service_name=os.environ.get("OTEL_SERVICE_NAME", "harmonia-agent"),
            image_max_cost_usd=image_max_cost_usd,
            agentcore_runtime_arn=os.environ.get("AGENTCORE_RUNTIME_ARN", ""),
            agentcore_gateway_url=os.environ.get("AGENTCORE_GATEWAY_URL") or None,
            bedrock_knowledge_base_id=os.environ.get("BEDROCK_KNOWLEDGE_BASE_ID") or None,
            memory_bank_enabled=_bool_env("MEMORY_BANK_ENABLED"),
            agentcore_memory_id=os.environ.get("AGENTCORE_MEMORY_ID") or None,
            generative_media_enabled=_bool_env("GENERATIVE_MEDIA_ENABLED"),
            media_output_bucket=os.environ.get("MEDIA_OUTPUT_BUCKET") or os.environ.get("S3_BUCKET") or None,
            durable_recovery_limit=recovery_limit,
            durable_recovery_deadline_seconds=recovery_deadline,
            durable_recovery_max_retries=recovery_retries,
            durable_recovery_max_cost_usd=recovery_cost,
        )


_settings: Settings | None = None


def settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings.load()
    return _settings


def reset_settings_for_tests() -> None:
    global _settings
    _settings = None

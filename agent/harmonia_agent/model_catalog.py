"""Versioned model pricing used for estimates and budget reservations."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from decimal import ROUND_HALF_UP, Decimal

PRICING_VERSION = "aws-configured-2026-09-10"
RATE_SOURCE = "https://aws.amazon.com/bedrock/pricing/"
MILLION = Decimal("1000000")


class UnknownModelPrice(ValueError):
    """Raised when a model has no budget-authorized catalog entry."""


@dataclass(frozen=True)
class PricingEntry:
    model: str
    input_usd_per_million: Decimal
    output_usd_per_million: Decimal
    version: str = PRICING_VERSION
    source: str = RATE_SOURCE


MEDIA_CATALOG = {
    "amazon.nova-canvas-v1:0": {"unit": "generation", "price": None},
    "amazon.nova-reel-v1:1": {"unit": "second", "price": None},
    "amazon-transcribe": {"unit": "second", "price": None},
    "music_v1": {"unit": "generation", "price": None},
}


def lookup_pricing(model_id: str) -> PricingEntry:
    try:
        rates = json.loads(os.environ.get("BEDROCK_TEXT_PRICING_JSON", "{}"))[model_id]
        input_rate, output_rate = Decimal(str(rates["input"])), Decimal(str(rates["output"]))
        if not input_rate.is_finite() or not output_rate.is_finite() or min(input_rate, output_rate) <= 0:
            raise ValueError("rates must be positive finite values")
        return PricingEntry(model=model_id, input_usd_per_million=input_rate, output_usd_per_million=output_rate)
    except (KeyError, ValueError, TypeError) as exc:
        raise UnknownModelPrice(f"deployment pricing is required for Bedrock model: {model_id}") from exc



def estimate_text_cost(model_id: str, input_tokens: int, output_tokens: int) -> Decimal:
    if input_tokens < 0 or output_tokens < 0:
        raise ValueError("token counts must be non-negative")
    entry = lookup_pricing(model_id)
    total = (
        Decimal(input_tokens) * entry.input_usd_per_million
        + Decimal(output_tokens) * entry.output_usd_per_million
    ) / MILLION
    return total.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)


def lookup_media_price(
    model_id: str, *, duration_sec: int, configured_price: str | None = None,
) -> Decimal:
    try:
        entry = MEDIA_CATALOG[model_id]
    except KeyError as exc:
        raise UnknownModelPrice(f"no media price configured for model: {model_id}") from exc
    price = Decimal(configured_price) if configured_price is not None else entry["price"]
    if price is None:
        raise UnknownModelPrice(f"deployment price is required for preview model: {model_id}")
    if not price.is_finite() or price <= 0:
        raise UnknownModelPrice("media price must be positive and finite")
    if duration_sec <= 0:
        raise ValueError("media duration must be positive")
    amount = price * duration_sec if entry["unit"] == "second" else price
    return amount.quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)

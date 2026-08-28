from decimal import Decimal

import pytest

from harmonia_agent.model_catalog import (
    PRICING_VERSION,
    UnknownModelPrice,
    estimate_text_cost,
    lookup_pricing,
    lookup_media_price,
)


def test_flash_cost_uses_decimal_rates():
    assert PRICING_VERSION == "2026-08-23"
    entry = lookup_pricing("gemini-3.5-flash")
    assert entry.input_usd_per_million == Decimal("1.50")
    assert entry.output_usd_per_million == Decimal("9.00")
    assert estimate_text_cost("gemini-3.5-flash", 100_000, 10_000) == Decimal("0.240000")


def test_unknown_model_price_is_not_treated_as_free():
    with pytest.raises(UnknownModelPrice):
        estimate_text_cost("unpriced-model", 100, 100)


def test_media_catalog_prices_by_real_billing_unit_and_never_guesses_preview_price():
    assert lookup_media_price("veo-3.1-fast-generate-001", duration_sec=4) == Decimal("0.320000")
    assert lookup_media_price("lyria-002", duration_sec=30) == Decimal("0.060000")
    with pytest.raises(UnknownModelPrice, match="deployment price"):
        lookup_media_price("lyria-3-clip-preview", duration_sec=30)
    assert lookup_media_price("lyria-3-clip-preview", duration_sec=30, configured_price="0.120000") == Decimal("0.120000")

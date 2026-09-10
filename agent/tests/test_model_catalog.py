from decimal import Decimal
import json
import pytest
from harmonia_agent.model_catalog import PRICING_VERSION, UnknownModelPrice, estimate_text_cost, lookup_pricing, lookup_media_price

MODEL='us.anthropic.claude-sonnet-4-6'

def test_bedrock_cost_uses_explicit_decimal_rates(monkeypatch):
    monkeypatch.setenv('BEDROCK_TEXT_PRICING_JSON',json.dumps({MODEL:{'input':'3','output':'15'}}))
    assert PRICING_VERSION=='aws-configured-2026-09-10'
    assert estimate_text_cost(MODEL,100000,10000)==Decimal('0.450000')

@pytest.mark.parametrize('rate',['0','-1','NaN','Infinity'])
def test_nonpositive_nonfinite_prices_are_not_budget_authorized(monkeypatch,rate):
    monkeypatch.setenv('BEDROCK_TEXT_PRICING_JSON',json.dumps({MODEL:{'input':rate,'output':'15'}}))
    with pytest.raises(UnknownModelPrice):lookup_pricing(MODEL)

def test_missing_deployment_price_is_not_guessed(monkeypatch):
    monkeypatch.delenv('BEDROCK_TEXT_PRICING_JSON',raising=False)
    with pytest.raises(UnknownModelPrice):lookup_pricing(MODEL)

def test_unknown_model_price_is_not_treated_as_free():
    with pytest.raises(UnknownModelPrice):estimate_text_cost('unpriced',100,100)

def test_media_catalog_uses_actual_unit_and_explicit_price():
    assert lookup_media_price('amazon.nova-reel-v1:1',duration_sec=6,configured_price='.08')==Decimal('.480000')
    assert lookup_media_price('music_v1',duration_sec=30,configured_price='.10')==Decimal('.100000')
    with pytest.raises(UnknownModelPrice):lookup_media_price('amazon.nova-canvas-v1:0',duration_sec=1)

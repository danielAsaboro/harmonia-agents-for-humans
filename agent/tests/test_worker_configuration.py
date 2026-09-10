import json
import pytest
from harmonia_agent.worker_entrypoint import load_runtime_environment


def test_provider_settings_cannot_grant_paid_authority(monkeypatch):
    monkeypatch.setenv('HARMONIA_ALLOW_PAID_AWS', 'false')
    monkeypatch.setenv('HARMONIA_PROVIDER_SETTINGS_JSON', json.dumps({'HARMONIA_ALLOW_PAID_AWS': 'true'}))
    with pytest.raises(ValueError, match='Unsupported'):
        load_runtime_environment()
    import os
    assert os.environ['HARMONIA_ALLOW_PAID_AWS'] == 'false'


def test_image_cap_is_configurable_and_settings_blob_removed(monkeypatch):
    monkeypatch.setenv('HARMONIA_PROVIDER_SETTINGS_JSON', json.dumps({'IMAGE_MAX_COST_USD': '0.25'}))
    monkeypatch.setenv('HARMONIA_INTEGRATION_SECRETS_JSON', '{}')
    load_runtime_environment()
    import os
    assert os.environ['IMAGE_MAX_COST_USD'] == '0.25'
    assert 'HARMONIA_PROVIDER_SETTINGS_JSON' not in os.environ
    monkeypatch.delenv('IMAGE_MAX_COST_USD')

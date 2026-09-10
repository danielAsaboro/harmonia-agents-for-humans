"""Expand operator-owned settings before importing the worker application."""
import json
import os

ALLOWED = frozenset('EMBEDDING_INPUT_USD_PER_MILLION EMBEDDING_PRICING_VERSION IMAGE_MAX_COST_USD ELEVENLABS_API_KEY TRANSCRIBE_COST_PER_SECOND_USD NOVA_REEL_COST_PER_SECOND_USD ELEVENLABS_MUSIC_COST_PER_SECOND_USD PRODUCTION_PLANNER_MAX_COST_USD DREAM_MAX_COST_USD GENERATIVE_MEDIA_ENABLED HARMONIA_ENABLE_RESIDENT_AUTONOMY X_CLIENT_ID X_CLIENT_SECRET LINKEDIN_CLIENT_ID LINKEDIN_CLIENT_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET YOUTUBE_API_KEY YOUTUBE_REFRESH_TOKEN TIKTOK_CLIENT_KEY TIKTOK_CLIENT_SECRET INSTAGRAM_APP_ID INSTAGRAM_APP_SECRET FACEBOOK_APP_ID FACEBOOK_APP_SECRET'.split())

def load_runtime_environment():
    for source in ('HARMONIA_PROVIDER_SETTINGS_JSON','HARMONIA_INTEGRATION_SECRETS_JSON'):
        values = json.loads(os.environ.pop(source, '{}'))
        if not isinstance(values, dict): raise ValueError('Invalid runtime settings')
        for key,value in values.items():
            if key not in ALLOWED or not isinstance(value,str): raise ValueError('Unsupported runtime setting')
            os.environ[key] = value

if __name__ == '__main__':
    load_runtime_environment()
    import uvicorn
    uvicorn.run('harmonia_agent.main:app', host='0.0.0.0', port=int(os.environ.get('PORT','8080')), loop='asyncio')

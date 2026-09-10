'use strict';
// Only deployment-owned configuration keys may be expanded into the process.
const allowed = new Set(['EMBEDDING_INPUT_USD_PER_MILLION','EMBEDDING_PRICING_VERSION','IMAGE_MAX_COST_USD','ELEVENLABS_API_KEY','TRANSCRIBE_COST_PER_SECOND_USD','NOVA_REEL_COST_PER_SECOND_USD','ELEVENLABS_MUSIC_COST_PER_SECOND_USD','PRODUCTION_PLANNER_MAX_COST_USD','DREAM_MAX_COST_USD','GENERATIVE_MEDIA_ENABLED','HARMONIA_ENABLE_RESIDENT_AUTONOMY','X_CLIENT_ID','X_CLIENT_SECRET','LINKEDIN_CLIENT_ID','LINKEDIN_CLIENT_SECRET','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','YOUTUBE_API_KEY','YOUTUBE_REFRESH_TOKEN','TIKTOK_CLIENT_KEY','TIKTOK_CLIENT_SECRET','INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','FACEBOOK_APP_ID','FACEBOOK_APP_SECRET']);
for (const source of ['HARMONIA_PROVIDER_SETTINGS_JSON','HARMONIA_INTEGRATION_SECRETS_JSON']) {
  const values = JSON.parse(process.env[source] || '{}');
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid runtime settings');
  for (const [key,value] of Object.entries(values)) {
    if (!allowed.has(key) || typeof value !== 'string') throw new Error('Unsupported runtime setting');
    process.env[key] = value;
  }
  delete process.env[source];
}

import os

os.environ.setdefault("WEB_INTERNAL_URL", "http://localhost:3000")
os.environ.setdefault("INTERNAL_API_TOKEN", "test-token-not-a-secret")
os.environ.setdefault("GEMINI_API_KEY", "fake-key-for-unit-tests")
os.environ.setdefault("GITHUB_TOKEN", "ghp_fake-token-for-unit-tests")
os.environ.setdefault(
    "GEMMA_VERTEX_ENDPOINT",
    "projects/test/locations/us-central1/endpoints/123",
)

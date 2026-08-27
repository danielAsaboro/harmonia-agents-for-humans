FROM python:3.12-slim@sha256:09f7da3bc104798d0afb40bc08d23ab2da20a76130cec1f2ef170848f5d85217

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# ffmpeg powers clip rendering; fonts give libass a fallback for burned captions.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.lock .
RUN pip install --no-cache-dir -r requirements.lock

COPY harmonia_agent ./harmonia_agent

RUN useradd -m worker
USER worker

EXPOSE 8080
CMD exec uvicorn harmonia_agent.main:app --host 0.0.0.0 --port ${PORT:-8080}

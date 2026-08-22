FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY closefold_agent ./closefold_agent

RUN useradd -m worker
USER worker

EXPOSE 8080
CMD exec uvicorn closefold_agent.main:app --host 0.0.0.0 --port ${PORT:-8080}

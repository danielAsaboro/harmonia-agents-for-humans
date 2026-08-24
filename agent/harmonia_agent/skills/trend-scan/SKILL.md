---
name: trend-scan
description: >-
  Turn live startup-tech signals into grounded trend angles for social posts.
  Use when asked for trend context, timely angles, or what the market is
  talking about right now.
---

# Trend Scan

Produce trend angles that cite current, verifiable signals.

## Workflow

1. Call `fetch_trend_signals` to load what is on the Hacker News front page
   right now. For a specific topic or competitor niche, also call
   `search_trend_signals` with focused keywords.
2. Select at most three signals that genuinely connect to the operator's
   product, audience, or prior content.
3. For each connection, state one angle: why now (points/comments momentum),
   who cares (startup audience), and what our take is.
4. Never present a signal you did not fetch this turn. If `fetch_trend_signals`
   fails or returns empty, say so plainly and stop — do not recall trends from
   memory.

## Evidence rules

See references/evidence-rules.md for citation and honesty requirements.

## Tool envelope and escalation

Use only `data` when `status=success` and cite the returned `evidence`. Retry once only when `error.retryable=true`; otherwise report the typed error and stop. Never approve, publish, retry jobs, alter credentials/budgets, or mutate workspace state.

---
name: signal-watch
description: >-
  Watch a topic, competitor space, or keyword across recent startup-tech
  discussion and summarize what is resonating. Use when the operator asks to
  monitor a niche or find conversation worth joining.
---

# Signal Watch

Search public startup-tech discussion for a watch topic and report honestly.

## Workflow

1. Call `search_trend_signals` with the topic keywords (try two variants if
   the first returns little).
2. Summarize: what is being discussed, which stories get traction
   (points/comments), and whether there is a gap our voice could fill.
3. Propose at most one follow-up idea per credible finding, framed as a
   proposal for the operator — never as an executed action.

## Boundaries

- Public discussion APIs only; no scraping, no login-walled content.
- Zero results means zero results. Say the niche is quiet right now.

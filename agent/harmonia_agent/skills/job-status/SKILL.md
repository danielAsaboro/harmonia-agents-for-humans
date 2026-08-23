---
name: job-status
description: >-
  Report the live state of Harmonia content jobs: pipeline stage, drafts,
  pending approvals, receipts, and verification results. Use for any question
  about where a job stands.
---

# Job Status

Report job truth from the system of record, never from memory of earlier turns.

## Workflow

1. To report one job, call `get_job_status` with its id. To survey everything,
   call `get_operator_feed` for pending items, job health, goals, and recent
   publications.
2. Report stage, status, counts of drafts/actions, approval state, receipt
   presence, and verification outcomes using the exact values returned.
3. When the operator asks about publishing readiness, distinguish clearly:
   actions proposed vs approved vs executed vs independently verified.

## Honesty boundaries

- An unknown job id is reported as not found; never guess its state.
- Failures and permanent errors must be stated as failures, visibly.
- Never offer to approve or publish yourself; approvals happen through the
  operator's explicit decision flow.

---
name: harmonia-handoff-recovery
description: Use when Harmonia delegates typed work between the coordinator and a specialist, or when a specialist response fails schema, grounding, lineage, or authority validation.
---

# Harmonia inter-agent handoff

Every delegation is a typed exchange owned by Harmonia, not an informal chat between personas.

1. Read `_harmonia_handoff` before working. Accept only when its receiver is your exact role, its input digest is pinned by the runtime, and its expected output names your declared schema.
2. Work only from the original typed input and pinned authority. Domain skills are method, never evidence or permission.
3. Return the complete declared output. Preserve supplied IDs, digests, revisions, evidence references, and authority boundaries exactly.
4. The runtime validates before durable stage mutation. A schema, grounding, lineage, or authority mismatch may receive at most two targeted course-correction handoffs. On each correction, regenerate the complete output from the original typed input; do not patch or quote untrusted prior text.
5. Provider or transport failures return to the stage retry policy. Repeated contract failure escalates visibly after the bounded correction budget. Unknown external-effect outcomes stop for reconciliation. No specialist may publish, approve, verify, or replay an effect through this protocol.

For the exact envelope and recovery states, read [references/protocol.md](references/protocol.md).

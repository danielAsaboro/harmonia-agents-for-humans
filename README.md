# Harmonia — Strands and AWS edition

Harmonia is a governed content operation for startups. Give it authorized source material and an outcome: its specialists analyze the evidence, propose a strategy, plan and draft content, request approval, execute approved effects, and independently verify the result.

This edition replaces the original Google backend with Strands Agents SDK and AWS while preserving the dashboard, conversational interface, specialist roles, official integrations, and human approval boundaries. It is being prepared for the Agents for Humans Professional Agents track.

**Evidence status:** the AWS edition is under local verification. No AWS deployment or paid provider rehearsal has been performed. The earlier Google edition's receipts do not prove this implementation. Paid calls are disabled by default.

## Architecture

```mermaid
flowchart LR
  UI[Dashboard / chat / Telegram] --> WEB[Next.js on Fargate + Cognito]
  WEB --> DB[(DynamoDB state + transactional outbox)]
  DB --> QUEUE[SQS]
  QUEUE --> WORK[Python Fargate worker]
  WORK --> CORE[Strands specialists on AgentCore]
  CORE --> MODELS[Bedrock Claude / Nova]
  CORE --> SEARCH[AgentCore Gateway / Knowledge Base]
  CORE --> MEMORY[AgentCore Memory]
  WORK --> SPEECH[Amazon Transcribe]
  WORK --> MEDIA[Nova Canvas / Reel / ElevenLabs]
  WORK --> EFFECT[Approved official API effects / content packs]
  EFFECT --> VERIFY[Independent read-back verification]
  VERIFY --> DB
  WORK --> S3[(S3 sources and artifacts)]
  TIMER[EventBridge Scheduler] --> QUEUE
```

Harmonia routes intent; Nimi analyzes; Ryan strategizes; Temi plans; Noni writes; Dara reviews; Maya presents; Nova explains status. The host owns tenant identity, prerequisites, budgets, approval, idempotency, and verification. A model cannot grant itself authority.

## Local checks without spending

Requirements: Node 22+, Python 3.12+, and npm. Docker is required to build deployment images. No provider credentials are needed for isolated unit tests.

```bash
npm ci
python3 -m venv agent/.venv
agent/.venv/bin/pip install -r agent/requirements.lock
npm test
npm run test:agent
npm run lint
npm run build
npm run infra:synth
```

Database integration tests use official DynamoDB Local, not a production simulation. Set `AWS_LOCAL_ENDPOINT` to its loopback URL, `DYNAMODB_TABLE` to a fresh pk/sk table, and local-only AWS test credentials before running the integration suite.

For an interactive server, copy `.env.example` to `.env.local`, configure Cognito and the AWS services, and run `npm run dev`. There is no fake-login or fake-provider route. A complete content run requires explicit authorization of paid provider validation.

## Deployment

The CDK application in `infra/aws/` provisions an isolated VPC, Fargate services, DynamoDB, S3, SQS, Cognito, AgentCore, research resources, and scheduled wakes. `infra/setup.sh` and `infra/deploy.sh` refuse to run until `HARMONIA_ALLOW_PAID_DEPLOYMENT=true` is set after budget authorization.

The deployment requires an HTTPS origin and matching regional ACM certificate, Google federation credentials, and an ECR ARM64 cognition image pinned by digest. Build that image from `agent/Dockerfile.agentcore`; web and worker images are CDK assets. See [deployment documentation](docs/deployment.mdx) for parameter names and release validation.

`HARMONIA_ALLOW_PAID_AWS=false` prevents cognitive and generative provider work. Configured prices, integration credentials, capability enablement, and live verification are separate prerequisites. Never reuse old approval records to enable new effects.

## Product coverage and boundaries

- Authorized uploads, pasted text, documents, web sources, YouTube, and connected brand libraries.
- Strategy approval, editorial planning, typed content, review, clips, images, music, and content packs.
- Official X and LinkedIn publishing, scoped Google Drive/Calendar connections, and allow-listed Telegram.
- Memory, research, Heartbeat, Micro-reflections, Dream, Wakeup, bounded experiments, and rollback.
- Immutable receipts, digest verification, tenant isolation, and reconciliation of uncertain effects.

Integration presence does not imply authenticated production proof. A rejected publication is not a published post; an exported pack is an exported pack.

## Provenance

This repository derives from the team's Harmonia implementation, including its UI, deterministic workflow, content contracts, and tests. This branch replaces its agent and cloud infrastructure and extends media production. The original history is retained. Submission materials must disclose incorporated pre-existing work and distinguish this edition's new work and evidence.

## Workflow authority

The pipeline uses collect · extract · understand · strategy · strategy approval · plan · draft · publish · verify handlers. Effect approval precedes execution. Strands supplies bounded judgment; deterministic host code selects stages, enforces policy, and owns state transitions. Memory remains advisory.

```mermaid
flowchart LR
  STATE[Validated state transition] -- one transaction --> OUTBOX[Durable outbox]
  OUTBOX --> SQS[SQS]
  SQS --> CLAIM[Fenced worker claim]
  CLAIM --> RECEIPT[Execution and independent verification receipts]
```

Duplicate suppression returns `already_applied` with the original receipt identity; it does not invent a new execution receipt. Unknown external outcomes require reconciliation. Only explicit operator replay persists a replay observation.

Unknown observation reads retain their reservation until an administrator records an evidence-bound resolution through the [learning reconciliation API](docs/learning-reconciliation.md).

The console uses Vercel AI SDK 7 (`ai` 7.0.97 and `@ai-sdk/react` 4.0.100). Maya proposes reference-only layouts; the server hydrates them from authoritative records into validated `data-harmonia-surface` UI message parts. Durable DynamoDB event sequences support replay and reconnect, while approval controls remain server-owned. Telegram routes ordinary allow-listed messages through the canonical chat router and the same decision service. This AWS edition is not live-evidenced yet.

## License

Harmonia application code is available under the [MIT License](LICENSE). Third-party dependencies and external media retain their own licenses and permissions.

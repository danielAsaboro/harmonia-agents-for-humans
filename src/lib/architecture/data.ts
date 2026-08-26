import type { ArchitectureNode } from "./schema";
import { validateArchitecture } from "./validate";

const node = (value: Partial<ArchitectureNode> & Pick<ArchitectureNode, "id" | "name" | "kind" | "layer" | "summary">): ArchitectureNode => ({
  statuses: ["implemented"], authorities: ["none"], dataScope: "none", stateLifetime: "stateless", ...value,
});
const group = (id: string, name: string, layer: ArchitectureNode["layer"], summary: string, defaultExpanded = false) => node({ id, name, kind: "group", layer, summary, defaultExpanded });

const nodes: ArchitectureNode[] = [
  group("group-surfaces", "Operator surfaces", "surfaces", "Authenticated ways operators inspect and direct Harmonia.", true),
  node({ id: "surface-dashboard", name: "Editorial Studio Dashboard", kind: "surface", layer: "surfaces", parentId: "group-surfaces", summary: "Jobs, proposals, calendar, filtered agent activity, settings, and receipts.", authorities: ["read", "write"], dataScope: "workspace", runtime: "Next.js / Cloud Run", sourceFiles: ["src/components/DashboardFrame.tsx", "src/components/monitoring/AgentActivityView.tsx"] }),
  node({ id: "surface-console", name: "Conversational Console + A2UI", kind: "surface", layer: "surfaces", parentId: "group-surfaces", summary: "Natural-language job and status surface with a validated living canvas.", authorities: ["read", "write"], dataScope: "workspace", sourceFiles: ["src/components/ChatConsole.tsx"], docs: ["a2ui-console"] }),
  node({ id: "surface-telegram", name: "Telegram Bot", kind: "surface", layer: "surfaces", parentId: "group-surfaces", summary: "Allow-listed Bot API surface; approvals require callback taps.", statuses: ["implemented", "approval-gated"], authorities: ["read", "write"], dataScope: "tenant", sourceFiles: ["agent/harmonia_agent/telegram_bot.py"] }),
  node({ id: "surface-auth", name: "Google Sign-In / Identity Platform", kind: "surface", layer: "trust", parentId: "group-surfaces", summary: "Verified identity establishes workspace membership and tenant scope.", authorities: ["read"], dataScope: "tenant", sourceFiles: ["src/lib/auth.ts"] }),

  group("group-control", "Next.js control plane", "control", "Authenticated web control plane on Cloud Run."),
  ...[
    ["chat", "Chat intent + runs", "Gemini structured intent, durable run events, and replay."],
    ["upload", "Resumable upload broker", "Tenant-scoped upload sessions with server-side metadata verification."],
    ["decision", "Decision engine", "One policy and approval boundary for dashboard, chat, and Telegram."],
    ["calendar", "Calendar sync", "Explicit browser-session sync to an app-created Google calendar."],
    ["authentication", "Authentication + tenancy", "Server-derived workspace and brand membership."],
    ["a2ui", "A2UI renderer", "Validated declarative components; no generated JavaScript or arbitrary callbacks."],
    ["streaming", "NDJSON event streaming", "Persist-before-delivery transport with monotonic sequence replay."],
  ].map(([id, name, summary]) => node({ id: `control-${id}`, name, kind: "service", layer: "control", parentId: "group-control", summary, authorities: ["read", "write"], dataScope: "workspace", runtime: "Next.js / Cloud Run" })),

  group("group-apis", "API route families", "apis", "Browser-authenticated and service-authenticated route boundaries."),
  node({ id: "api-auth", name: "Auth + tenancy routes", kind: "route", layer: "apis", parentId: "group-apis", summary: "Session and workspace-scoped settings.", authorities: ["read", "write"], dataScope: "tenant", representativeRoutes: ["/api/auth/session", "/api/settings/*"], sourceFiles: ["src/app/api/auth/session/route.ts"] }),
  node({ id: "api-jobs", name: "Jobs + decisions", kind: "route", layer: "apis", parentId: "group-apis", summary: "Create/read jobs and record action-specific decisions, retry, or replay observations.", statuses: ["implemented", "approval-gated"], authorities: ["read", "write", "approve"], dataScope: "workspace", representativeRoutes: ["/api/jobs", "/api/jobs/{id}", "/api/jobs/{id}/actions/{actionId}/decision", "/api/jobs/{id}/retry", "/api/jobs/{id}/actions/{actionId}/replay"] }),
  node({ id: "api-chat", name: "Chat + A2UI", kind: "route", layer: "apis", parentId: "group-apis", summary: "Chat, transport streaming, replay, attachments, and registered-operation decisions.", authorities: ["read", "write"], dataScope: "workspace", representativeRoutes: ["/api/chat", "/api/chat/stream", "/api/chat/runs/{id}/events", "/api/chat/attachments/*", "/api/chat/operations/{id}/decision"] }),
  node({ id: "api-content", name: "Content + monitoring", kind: "route", layer: "apis", parentId: "group-apis", summary: "Content items, proposals, assets, events, receipts, metrics, and notifications.", authorities: ["read", "write"], dataScope: "workspace", representativeRoutes: ["/api/content-items", "/api/proposals", "/api/assets", "/api/events", "/api/receipts", "/api/metrics", "/api/notifications"] }),
  node({ id: "api-calendar", name: "Calendar + OAuth", kind: "route", layer: "apis", parentId: "group-apis", summary: "Operator-only Calendar sync and official OAuth connections.", statuses: ["implemented", "approval-gated"], authorities: ["read", "write"], dataScope: "workspace", representativeRoutes: ["/api/calendar", "/api/calendar/google", "/api/oauth/{platform}/*"] }),
  node({ id: "api-internal", name: "Internal worker boundary", kind: "route", layer: "apis", parentId: "group-apis", summary: "Service-authenticated worker callbacks; never browser-selected tenant scope.", authorities: ["read", "write"], dataScope: "tenant", representativeRoutes: ["/api/internal/ingest", "/api/internal/transcript", "/api/internal/analysis", "/api/internal/drafts", "/api/internal/effect-claim", "/api/internal/receipt", "/api/internal/verification", "/api/internal/usage", "/api/internal/agent-state"], sourceFiles: ["src/lib/internalHandler.ts"] }),

  group("group-workflow", "Durable workflow", "workflow", "Firestore-persisted, Pub/Sub-triggered resumable content pipeline.", true),
  ...[
    ["ingest", "1 · Ingest", "Resolve an authorized YouTube source or uploaded media."],
    ["transcribe", "2 · Transcribe", "Gemini transcription with timed segments."],
    ["analyze", "3 · Analyze", "Ground clip moments in transcript and video evidence."],
    ["strategize", "4 · Strategize", "Ryan proposes a grounded four-week strategy and content briefs."],
    ["strategy-approval", "5 · Approve strategy", "Human approval bound to the exact strategy digest."],
    ["plan", "6 · Plan", "Temi proposes a complete plan; deterministic code validates, persists, and selects one eligible item."],
    ["draft", "7 · Draft & review", "Noni and Dara produce the exact selected item in a bounded revision loop."],
    ["await-approval", "8 · Await effect approval", "Hard human gate before every external effect."],
    ["publish-render", "9 · Publish / export / render", "Claim and execute only approved actions."],
    ["verify", "10 · Verify", "Independently re-fetch providers or re-read artifact digests."],
    ["learn", "11 · Learn", "Persist measured outcomes and eligible takeaways."],
  ].map(([id, name, summary]) => node({ id: `stage-${id}`, name, kind: id === "await-approval" || id === "strategy-approval" ? "gate" : id === "verify" ? "verification" : "stage", layer: "workflow", parentId: "group-workflow", summary, statuses: id === "await-approval" || id === "strategy-approval" ? ["approval-gated"] : ["implemented"], authorities: id === "await-approval" || id === "strategy-approval" ? ["approve"] : id === "verify" ? ["verify"] : ["write"], dataScope: "workspace", stateLifetime: "durable", sourceFiles: ["agent/harmonia_agent/stages.py"], docs: ["pipeline"] })),

  group("group-worker", "ADK worker", "control", "FastAPI Cloud Run worker consumes stages and persists results."),
  ...[["dispatcher", "Stage dispatcher"], ["scheduler", "Scheduler dispatcher"], ["proactive", "Proactive agent"], ["media", "Direct media operations"], ["ffmpeg", "ffmpeg skills"], ["providers", "Provider clients"], ["tenant", "Tenant-context validation"]].map(([id, name]) => node({ id: `worker-${id}`, name, kind: "service", layer: "control", parentId: "group-worker", summary: `${name} inside the service-authenticated worker boundary.`, authorities: ["read", "write"], dataScope: "workspace-brand", runtime: "FastAPI / Cloud Run" })),

  group("group-agent-engine", "Vertex AI Agent Engine", "agents", "Managed cognitive runtime; never durable workflow ownership."),
  node({ id: "agent-engine", name: "Vertex AI Agent Engine", kind: "runtime", layer: "agents", parentId: "group-agent-engine", summary: "Ephemeral cognitive runtime with one managed invocation session.", statuses: ["pending-live"], authorities: ["delegate"], dataScope: "workspace-brand", stateLifetime: "ephemeral", runtime: "Vertex AI", sourceFiles: ["agent/harmonia_agent/agent_engine_app.py"], docs: ["agent-platform", "session-memory"], limitations: ["Authenticated live evidence pending."] }),
  node({ id: "memory-bank", name: "Memory Bank", kind: "store", layer: "data", parentId: "group-agent-engine", summary: "Exact workspace_id + brand_id retrieval of eligible typed facts only.", statuses: ["pending-live"], authorities: ["read", "write"], dataScope: "workspace-brand", stateLifetime: "durable", sourceFiles: ["agent/harmonia_agent/memory_bank.py"], limitations: ["Excludes raw sources, transcripts, prompts, drafts, errors, and unverified claims."] }),

  group("group-agent-team", "Agent team + delegation", "agents", "Bounded ADK roles with no effect authority."),
  node({ id: "agent-harmonia", name: "Harmonia coordinator", kind: "agent", layer: "agents", parentId: "group-agent-team", summary: "Routes exactly one bounded specialist; cannot answer the task, approve, or publish.", statuses: ["offline-verified", "pending-live"], authorities: ["delegate"], dataScope: "workspace-brand", stateLifetime: "ephemeral", model: { name: "Gemini 3.5 Flash-Lite" }, promptResponsibility: "Exact one-specialist routing and delegation only.", sourceFiles: ["agent/harmonia_agent/agents.py"] }),
  node({ id: "agent-ryan", name: "Ryan strategist", kind: "agent", layer: "agents", parentId: "group-agent-team", summary: "Produces provenance-linked four-week strategy and content briefs for human approval.", statuses: ["offline-verified", "approval-gated", "pending-live"], authorities: ["propose", "read"], dataScope: "workspace-brand", stateLifetime: "ephemeral", model: { name: "Gemini 3.5 Flash" }, promptResponsibility: "Agentic strategy from closed-world evidence using one allow-listed filesystem method skill and an optional isolated request-bound grounded-search agent; no direct search, scheduling, approval, or effects.", skills: ["ryan-strategy-skills"] }),
  node({ id: "agent-nimi", name: "Nimi multimodal analyst", kind: "agent", layer: "agents", parentId: "group-agent-team", summary: "Proposes strict source analysis with quote/time/frame and evidence-kind provenance; deterministic code validates and digests it.", statuses: ["offline-verified", "pending-live"], authorities: ["propose"], dataScope: "workspace-brand", stateLifetime: "ephemeral", model: { name: "Gemini 3.5 Flash" }, promptResponsibility: "Exact grounded moments, qualified source/performance/memory angles, assumptions, confidence, and explicit references; no strategy, copy, or effect authority." }),
  group("workflow-writing-review", "Writing and review loop", "agents", "Deterministic orchestration of separate typed Noni and Dara calls for one selected item."),
  node({ id: "agent-noni", name: "Noni copywriter", kind: "agent", layer: "agents", parentId: "workflow-writing-review", summary: "Creates one grounded platform-native draft and at most one issue-bound revision from the selected item, exact Ryan brief, referenced Nimi evidence, and provenance-bound research.", statuses: ["offline-verified", "pending-live"], authorities: ["read", "propose"], dataScope: "workspace-brand", stateLifetime: "ephemeral", model: { name: "Gemini 3.5 Flash" }, promptResponsibility: "Load noni-writing-skills and relevant writing references, optionally read verified prior publications or brief-scoped public sources, then produce strict claim-led copy with exact evidence lineage; no Memory Bank, strategy, approval, or effect authority.", skills: ["noni-writing-skills"] }),
  node({ id: "agent-dara", name: "Dara editor", kind: "agent", layer: "agents", parentId: "workflow-writing-review", summary: "Returns all seven editorial checks plus a bounded accept/revise assessment; deterministic code assigns review metadata, permits at most one revision, and requires complete issue resolution.", statuses: ["offline-verified", "pending-live"], authorities: ["propose"], dataScope: "workspace-brand", stateLifetime: "ephemeral", model: { name: "Gemini 3.5 Flash" }, promptResponsibility: "Load one allow-listed editing method reference, then assess grounding, brief alignment, brand voice, platform constraints, CTA, safety, and clarity with supplied provenance; no workflow metadata, replacement copy, facts, or effects.", skills: ["dara-editing-skills"] }),
  node({ id: "agent-temi", name: "Temi editorial planner", kind: "agent", layer: "agents", parentId: "group-agent-team", summary: "Agentically operationalizes the approved Ryan strategy as a complete typed editorial plan.", statuses: ["offline-verified", "pending-live"], authorities: ["propose"], dataScope: "workspace-brand", stateLifetime: "ephemeral", model: { name: "Gemini 3.5 Flash-Lite" }, promptResponsibility: "Editorial sequencing, cadence, supported channel/format choices, windows, deadlines, dependencies, and priorities; no tools, final copy, external scheduling, approval, or effects." }),
  node({ id: "agent-maya", name: "Maya A2UI presenter", kind: "agent", layer: "agents", parentId: "group-agent-team", summary: "Produces exact-context reference graphs; deterministic validators bind every entity before host hydration.", statuses: ["offline-verified", "pending-live"], authorities: ["propose"], dataScope: "workspace-brand", stateLifetime: "ephemeral", model: { name: "Gemini 3.5 Flash" }, promptResponsibility: "Choose bounded domain components, exact entity references, and hierarchy; no lifecycle placeholders, authority, or inline truth." }),
  node({ id: "agent-nova", name: "Nova read-only liaison", kind: "agent", layer: "agents", parentId: "group-agent-team", summary: "Returns strict answers bound to the actual skill-first tool trace and exact evidence IDs.", statuses: ["offline-verified", "pending-live", "read-only"], authorities: ["read"], dataScope: "workspace", stateLifetime: "ephemeral", model: { name: "Gemini 3.5 Flash" }, promptResponsibility: "Skill selection, grounded synthesis, explicit uncertainty, and typed read errors.", skills: ["trend-scan", "signal-watch", "engagement-insights", "job-status", "posting-schedule"] }),

  group("group-skills", "Runtime skills + bounded tools", "skills", "Noni's writing guidance, Dara's editing guidance, and Nova's read-only intelligence skills."),
  node({ id: "skill-noni-writing-skills", name: "noni-writing-skills", kind: "skill", layer: "skills", parentId: "group-skills", summary: "Filesystem ADK skill with ten original writing-method references for grounded content production.", statuses: ["offline-verified", "read-only"], authorities: ["read"], dataScope: "public", stateLifetime: "stateless", sourceFiles: ["agent/harmonia_agent/skills/noni-writing-skills/SKILL.md"] }),
  node({ id: "skill-dara-editing-skills", name: "dara-editing-skills", kind: "skill", layer: "skills", parentId: "group-skills", summary: "Filesystem ADK skill with seven project-owned editing-method references for bounded editorial assessment.", statuses: ["offline-verified", "read-only"], authorities: ["read"], dataScope: "public", stateLifetime: "stateless", sourceFiles: ["agent/harmonia_agent/skills/dara-editing-skills/SKILL.md"] }),
  ...["trend-scan", "signal-watch", "engagement-insights", "job-status", "posting-schedule"].map((name) => node({ id: `skill-${name}`, name, kind: "skill", layer: "skills", parentId: "group-skills", summary: `Filesystem ADK skill: ${name}.`, statuses: ["offline-verified", "read-only"], authorities: ["read"], dataScope: name.includes("trend") || name === "signal-watch" ? "public" : "workspace", stateLifetime: "stateless", sourceFiles: [`agent/harmonia_agent/skills/${name}/SKILL.md`] })),
  ...[
    ["fetch-trend-signals", "fetch_trend_signals", "public"], ["search-trend-signals", "search_trend_signals", "public"],
    ["get-engagement-insights", "get_engagement_insights", "workspace"], ["get-operator-feed", "get_operator_feed", "workspace"],
    ["get-job-status", "get_job_status", "workspace"], ["suggest-posting-windows", "suggest_posting_windows", "workspace"],
  ].map(([id, name, scope]) => node({ id: `tool-${id}`, name, kind: "tool", layer: "skills", parentId: "group-skills", summary: `Read-only ${scope}-scoped tool.`, statuses: ["offline-verified", "read-only"], authorities: ["read"], dataScope: scope as "public" | "workspace", stateLifetime: "stateless", sourceFiles: ["agent/harmonia_agent/skills_runtime.py"] })),
  node({ id: "tool-search-verified-publications", name: "search_verified_publications", kind: "tool", layer: "skills", parentId: "group-skills", summary: "Tenant-scoped read of prior posts with applied receipts, successful verification, and canonical URLs.", statuses: ["offline-verified", "read-only"], authorities: ["read"], dataScope: "workspace", stateLifetime: "durable", sourceFiles: ["agent/harmonia_agent/noni_skills.py", "src/app/api/internal/published-content/route.ts"] }),
  node({ id: "tool-google-search-grounding", name: "google_search", kind: "tool", layer: "skills", parentId: "group-skills", summary: "Native ADK Google Search grounding isolated behind Noni's brief-bound and Ryan's strategy-request-bound research agents; chunks and supports are validated before claims are accepted.", statuses: ["offline-verified", "read-only", "pending-live"], authorities: ["read"], dataScope: "public", stateLifetime: "stateless", sourceFiles: ["agent/harmonia_agent/noni_skills.py", "agent/harmonia_agent/ryan_skills.py", "agent/harmonia_agent/team_runtime.py"] }),

  group("group-state", "Data stores + state ownership", "data", "Durable business state, scoped memory, assets, usage, and evidence."),
  node({ id: "firestore", name: "Firestore", kind: "store", layer: "data", parentId: "group-state", summary: "Durable source of truth for jobs, complete editorial plans, digests, and selected item lifecycle under workspaces/{workspaceId}/…", authorities: ["read", "write"], dataScope: "workspace", stateLifetime: "durable", sourceFiles: ["src/lib/firestore.ts"], docs: ["state-ownership"] }),
  node({ id: "pubsub", name: "Pub/Sub", kind: "service", layer: "workflow", parentId: "group-state", summary: "Asynchronous stage delivery and retry; payload and attributes repeat tenant scope.", authorities: ["write"], dataScope: "workspace-brand", stateLifetime: "durable", sourceFiles: ["src/lib/pubsub.ts"] }),
  node({ id: "asset-store", name: "Cloud Storage / local artifacts", kind: "store", layer: "data", parentId: "group-state", summary: "Workspace- and brand-scoped content packs and generated media.", authorities: ["read", "write"], dataScope: "workspace-brand", stateLifetime: "durable", sourceFiles: ["src/lib/storage.ts"] }),
  ...[["budget", "Budget reservations"], ["usage", "Immutable usage ledger"], ["claims", "Effect claims"], ["receipts", "Immutable receipts"], ["verifications", "Verification records"]].map(([id, name]) => node({ id: `state-${id}`, name, kind: "store", layer: id === "budget" || id === "usage" ? "observability" : "data", parentId: "group-state", summary: `${name} persisted transactionally in workspace-scoped Firestore.`, authorities: ["read", "write"], dataScope: "workspace", stateLifetime: "durable" })),

  group("group-effect-safety", "Human approval + effect safety", "effects", "Action-specific human approval, idempotent execution, and independent truth checks."),
  node({ id: "approval-receipt", name: "Action-specific approval receipt", kind: "gate", layer: "effects", parentId: "group-effect-safety", summary: "Records who approved exactly which action and payload.", statuses: ["approval-gated"], authorities: ["approve"], dataScope: "workspace", stateLifetime: "durable", approval: "Required before every external effect." }),
  ...[["idempotency-key", "SHA-256 idempotency key"], ["effect-claim", "Atomic Firestore effect claim"], ["execution-receipt", "Immutable execution receipt"], ["independent-readback", "Independent provider/digest read-back"], ["verification-record", "Immutable verification record"]].map(([id, name]) => node({ id, name, kind: id.includes("verification") || id.includes("readback") ? "verification" : "control", layer: "effects", parentId: "group-effect-safety", summary: `${name} in the deterministic effect-safety lifecycle.`, statuses: ["implemented"], authorities: id.includes("verification") || id.includes("readback") ? ["verify"] : ["write"], dataScope: "workspace", stateLifetime: "durable" })),
  node({ id: "uncertain-claim", name: "UNCERTAIN · operator reconciliation", kind: "control", layer: "effects", parentId: "group-effect-safety", summary: "Expired unresolved claims never auto-retry unsafely.", statuses: ["implemented"], authorities: ["none"], dataScope: "workspace", stateLifetime: "durable", limitations: ["Requires explicit operator reconciliation."] }),
  ...[["publish-x", "Publish X post"], ["export-pack", "Export content pack"], ["generate-image", "Generate image"], ["render-media", "Render clip / reel"], ["generate-veo", "Generate Veo b-roll"], ["generate-lyria", "Generate Lyria soundtrack"], ["schedule-content", "Schedule due content"]].map(([id, name]) => node({ id: `effect-${id}`, name, kind: "effect", layer: "effects", parentId: "group-effect-safety", summary: `${name} only after an action-specific approval receipt.`, statuses: ["approval-gated"], authorities: ["execute-effect"], dataScope: "external", stateLifetime: "external", approval: "Required", idempotency: "Deterministic SHA-256 operation key", verification: "Independent re-fetch or digest read-back" })),

  group("group-external", "External services", "external", "Official APIs and Google model services."),
  ...[
    ["youtube", "YouTube / oEmbed / yt-dlp", "implemented"], ["x", "X API v2", "approval-gated"], ["calendar", "Google Calendar API", "approval-gated"],
    ["hn", "Hacker News / Algolia", "read-only"], ["gemini", "Gemini transcription + analysis", "pending-live"],
    ["veo", "Veo 3.1 Fast", "pending-live"], ["lyria", "Lyria 3 Clip", "pending-live"], ["image", "Gemini image generation", "pending-live"],
  ].map(([id, name, status]) => node({ id: `external-${id}`, name, kind: "integration", layer: "external", parentId: "group-external", summary: `${name} integration through an official or authorized boundary.`, statuses: [status as ArchitectureNode["statuses"][number]], authorities: status === "read-only" ? ["read"] : ["none"], dataScope: id === "hn" || id === "youtube" ? "public" : "external", stateLifetime: "external" })),

  group("group-observability", "Observability + cost", "observability", "Metadata-only trace correlation and deterministic cost accounting."),
  ...[["trace", "W3C trace propagation"], ["spans", "Native ADK logs, metrics, and traces"], ["activity", "Tenant-scoped activity projection"], ["cost", "Role/model cost accounting"], ["budgets", "Workspace + job budget guards"]].map(([id, name]) => node({ id: `observe-${id}`, name, kind: "control", layer: "observability", parentId: "group-observability", summary: `${name}; no prompts, responses, transcripts, drafts, media, or chain-of-thought.`, statuses: id === "trace" || id === "spans" ? ["offline-verified", "pending-live"] : ["offline-verified"], authorities: ["read"], dataScope: "metadata-only", stateLifetime: "durable", sourceFiles: id === "activity" ? ["src/lib/observability/repository.ts", "src/components/monitoring/AgentActivityView.tsx"] : ["agent/harmonia_agent/telemetry.py"], docs: ["observability", "models-cost-evaluation"] })),
];

const workflowIds = ["ingest", "transcribe", "analyze", "strategize", "strategy-approval", "plan", "draft", "await-approval", "publish-render", "verify", "learn"].map((id) => `stage-${id}`);
const effectIds = nodes.filter((item) => item.kind === "effect").map((item) => item.id);
const edges = [
  ...workflowIds.slice(0, -1).map((source, index) => {
    const target = workflowIds[index + 1];
    const isApproval = source === "stage-strategy-approval" || source === "stage-await-approval";
    const isVerification = source === "stage-publish-render" && target === "stage-verify";
    return {
      id: `flow-${index + 1}`, source, target,
      kind: isApproval ? "approval" as const : isVerification ? "verification" as const : "workflow" as const,
      label: isApproval ? "Human approval" : isVerification ? "Independent verification" : "Durable transition",
    };
  }),
  { id: "delegate-ryan", source: "agent-harmonia", target: "agent-ryan", kind: "delegation" as const, label: "Delegate strategy" },
  { id: "delegate-nimi", source: "agent-harmonia", target: "agent-nimi", kind: "delegation" as const, label: "Delegate analysis" },
  { id: "delegate-writing", source: "agent-harmonia", target: "workflow-writing-review", kind: "delegation" as const, label: "typed specialist calls" },
  { id: "plan-temi", source: "stage-plan", target: "agent-temi", kind: "delegation" as const, label: "Typed approved strategy" },
  { id: "temi-plan-state", source: "agent-temi", target: "firestore", kind: "workflow" as const, label: "Validate, digest, persist" },
  { id: "delegate-maya", source: "agent-harmonia", target: "agent-maya", kind: "delegation" as const, label: "Delegate presentation" },
  { id: "delegate-nova", source: "agent-harmonia", target: "agent-nova", kind: "delegation" as const, label: "Delegate insight" },
  { id: "flo-1", source: "firestore", target: "agent-noni", kind: "workflow" as const, label: "Selected item + exact Ryan brief + referenced Nimi evidence" },
  { id: "flo-2", source: "agent-noni", target: "agent-dara", kind: "workflow" as const, label: "Draft for review" },
  { id: "flo-3", source: "agent-dara", target: "agent-noni", kind: "workflow" as const, label: "Bounded revision loop" },
  { id: "memory", source: "memory-bank", target: "agent-harmonia", kind: "memory" as const, label: "Exact-scope facts" },
  { id: "state-pubsub", source: "firestore", target: "pubsub", kind: "workflow" as const, label: "Persist then publish" },
  ...effectIds.flatMap((effectId) => [
    { id: `approval-${effectId}`, source: "approval-receipt", target: effectId, kind: "approval" as const, label: "Human approval" },
    { id: `verification-${effectId}`, source: effectId, target: "verification-record", kind: "verification" as const, label: "Independent read-back" },
  ]),
  { id: "claim-uncertain", source: "effect-claim", target: "uncertain-claim", kind: "blocked" as const, label: "Expired unresolved claim" },
  { id: "telemetry-worker", source: "group-worker", target: "group-observability", kind: "telemetry" as const, label: "Trace context" },
  { id: "retrieval-hn", source: "external-hn", target: "agent-nova", kind: "retrieval" as const, label: "Read-only public signals" },
];

export const architectureDefinition = validateArchitecture({
  version: "2026-08-26",
  nodes,
  edges,
  presets: [
    { id: "overview", name: "System overview", expanded: ["group-surfaces", "group-workflow"], layers: [], statuses: [], focusNodeIds: ["group-workflow"] },
    { id: "agents", name: "Agent team", expanded: ["group-agent-engine", "group-agent-team", "workflow-writing-review", "group-skills"], layers: ["agents", "skills", "models", "prompts", "data"], statuses: [], focusNodeIds: ["agent-harmonia"] },
    { id: "workflow", name: "Content workflow", expanded: ["group-workflow", "group-worker"], layers: ["workflow", "control", "effects"], statuses: [], focusNodeIds: ["stage-ingest"] },
    { id: "effect-safety", name: "Approval and effect safety", expanded: ["group-effect-safety"], layers: ["effects", "external", "data"], statuses: [], focusNodeIds: ["approval-receipt"] },
    { id: "state", name: "State ownership", expanded: ["group-state", "group-agent-engine"], layers: ["data", "workflow", "agents"], statuses: [], focusNodeIds: ["firestore"] },
    { id: "apis", name: "APIs and integrations", expanded: ["group-control", "group-apis", "group-external"], layers: ["control", "apis", "external"], statuses: [], focusNodeIds: ["group-apis"] },
    { id: "observability", name: "Observability and cost", expanded: ["group-observability", "group-state"], layers: ["observability", "data"], statuses: [], focusNodeIds: ["group-observability"] },
  ],
});

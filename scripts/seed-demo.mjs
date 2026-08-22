/**
 * Demo data seeder — populates the local Firestore emulator with a complete,
 * realistic Harmonia history so every UI surface has something true-to-shape
 * to show: calendar, monitoring charts, chat cards, approvals, failures.
 *
 * Assets are REAL files rendered locally with ffmpeg and served through the
 * same storage backend the pipeline uses (.data/artifacts).
 *
 * Run while dev stack is up:  npm run seed
 * Everything lives only in your local emulator — nothing here is shipped.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8081";
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "harmonia-local";

const { Firestore, Timestamp } = await import("@google-cloud/firestore");
const db = new Firestore({ projectId: PROJECT });

const ARTIFACT_DIR = path.join(process.cwd(), ".data", "artifacts");
mkdirSync(ARTIFACT_DIR, { recursive: true });

function daysAgo(n, h = 10) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(h, 24 % 60, 0, 0);
  return d;
}
function iso(d) {
  return d.toISOString();
}
function ts(d) {
  return Timestamp.fromDate(d);
}
function digest(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
function ffmpeg(args) {
  execSync(`ffmpeg -hide_banner -loglevel error -y ${args}`, { stdio: "pipe" });
}

// ---------- asset generation (real bytes) ----------
function genImage(jobId, actionId, variant = "smptebars") {
  const key = `${jobId}_${actionId}`;
  const p = path.join(ARTIFACT_DIR, key);
  if (variant === "color") {
    ffmpeg(`-f lavfi -i "color=c=0x7c3aed:s=1080x1350:d=1" -frames:v 1 -f image2 "${p}"`);
  } else {
    ffmpeg(`-f lavfi -i "testsrc2=s=1080x1080:rate=1:duration=1" -frames:v 1 -f image2 "${p}"`);
  }
  const bytes = readBytes(p);
  return { key, mime: "image/png", digest: digest(bytes), size: bytes.length };
}
function genClip(jobId, actionId, seconds) {
  const key = `${jobId}_${actionId}`;
  const p = path.join(ARTIFACT_DIR, key);
  ffmpeg(
    `-f lavfi -i "testsrc2=size=1080x1920:rate=24:duration=${seconds}" -f lavfi -i "sine=frequency=330:duration=${seconds}" -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart -f mp4 "${p}"`,
  );
  const bytes = readBytes(p);
  return { key, mime: "video/mp4", digest: digest(bytes), size: bytes.length };
}
import { readFileSync as readBytes, writeFileSync } from "node:fs";

// ---------- document builders ----------
const SEGMENTS = [
  { id: "s1", startSec: 0, endSec: 6, text: "Everyone told us onboarding had to take two weeks." },
  { id: "s2", startSec: 6, endSec: 14, text: "We mapped every step and found eleven that were pure ceremony." },
  { id: "s3", startSec: 14, endSec: 23, text: "Deleting them cut activation time from nine days to forty hours." },
  { id: "s4", startSec: 23, endSec: 32, text: "The lesson: speed of time-to-value beats feature count." },
];

const MOMENTS = [
  { id: "m1", title: "Eleven ceremonial steps", startSec: 6, endSec: 14, hook: "Most onboarding steps exist because someone once asked.", quote: "eleven that were pure ceremony" },
  { id: "m2", title: "Nine days to forty hours", startSec: 14, endSec: 23, hook: "Activation time collapsed when we deleted instead of added.", quote: "nine days to forty hours" },
];
const ANGLES = [
  { id: "a1", kind: "trend", title: "Deletion as strategy", rationale: "Founders love 'we removed things' stories; contrarian vs feature-dump launches." },
  { id: "a2", kind: "meme", title: "Onboarding obstacle course meme", rationale: "Relatable joke format about 14-step signups with a confetti screen." },
];

function draft(id, text, extra = {}) {
  return { id, platform: "x", text, valid: text.length <= 280, validationNote: `${text.length}/280 chars`, ...extra };
}
function action(a) {
  return { jobId: "", risk: "low", ...a };
}

async function seedJob(doc, { events = [], receipts = [], verifications = [], engagement = null, learnings = null, packet = null }) {
  const batch = db.batch();
  const ref = db.collection("jobs").doc(doc.id);
  batch.set(ref, doc.docData);
  for (const e of events) {
    batch.set(ref.collection("events").doc(e.id), { jobId: doc.id, at: ts(e.at), stage: e.stage, message: e.message, actor: e.actor });
    batch.set(db.collection("event_log").doc(`demo-${doc.id}-${e.id}`), { jobId: doc.id, at: ts(e.at), stage: e.stage, message: e.message, actor: e.actor });
  }
  for (const r of receipts) {
    batch.set(ref.collection("receipts").doc(r.id), r.data);
  }
  if (packet) batch.update(ref, { packet });
  if (verifications) batch.update(ref, { verifications });
  if (engagement) batch.update(ref, { engagement });
  if (learnings) batch.update(ref, { learnings });
  await batch.commit();
}

async function wipeDemo() {
  const snap = await db.collection("jobs").where("id", ">=", "demo-").where("id", "<=", "demo-\uffff").get();
  const del = [];
  snap.forEach((d) => {
    del.push(
      Promise.all([
        d.ref.collection("events").get().then((s) => Promise.all(s.docs.map((x) => x.ref.delete()))),
        d.ref.collection("receipts").get().then((s) => Promise.all(s.docs.map((x) => x.ref.delete()))),
        d.ref.delete(),
      ]),
    );
    del.push(db.collection("assets").where("jobId", "==", d.id).get().then((s) => Promise.all(s.docs.map((x) => x.ref.delete()))));
  });
  await Promise.all(del);
  return snap.size;
}

async function wipeCollection(name) {
  const snap = await db.collection(name).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function wipeChats() {
  const snap = await db.collection("chat_messages").get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
  return snap.size;
}

// ---------- dataset ----------
async function main() {
  const removed = await wipeDemo();
  console.log(`cleared ${removed} previous demo job(s)`);

  // 1) COMPLETE — brief job, published + learned (12 days ago)
  {
    const id = "demo-onboarding";
    const created = daysAgo(12, 9);
    const actPost = "act-pub-1";
    const actPack = "act-content-pack";
    const d = draft("d1", "We deleted 11 onboarding steps and activation went from 9 days to 40 hours. Subtraction is a growth strategy.");
    const docData = {
      createdAt: iso(created), updatedAt: iso(daysAgo(11, 15)),
      status: "complete", stage: "complete",
      config: { brief: "Share how deleting onboarding steps cut our activation time. Position subtraction as strategy.", platforms: ["x"] },
      videoId: "brief", ingestedTitle: "Subtraction as strategy (demo)", ingestedChannel: "operator", ingestedDurationSec: 0,
      summary: "Deletion-led onboarding redesign story.",
      transcriptSegments: [],
      moments: [{ id: "m1", title: "9 days to 40 hours", startSec: 0, endSec: 0, hook: "Time-to-value collapse", quote: "nine days to forty hours" }],
      angles: ANGLES,
      drafts: [d],
      actions: [
        action({ id: actPost, jobId: id, type: "publish_x_post", title: d.text.slice(0, 48), description: "Publish drafted post to X after operator approval.", payload: { type: "publish_x_post", text: d.text }, requiresApproval: true, approvalState: "approved", state: "executed" }),
        action({ id: actPack, jobId: id, type: "export_content_pack", title: "Assemble content pack", description: "Bundle moments, angles and drafts into an exportable markdown pack.", payload: { type: "export_content_pack" }, requiresApproval: false, approvalState: "not_required", state: "executed" }),
      ],
    };
    await seedJob(
      { id, docData },
      {
        events: [
          { id: "e1", at: created, stage: "understand", message: "concept job created from operator brief", actor: "operator" },
          { id: "e2", at: daysAgo(12, 9, ), stage: "draft", message: "1 draft(s); 0 auto action(s), 1 awaiting approval", actor: "agent" },
          { id: "e3", at: daysAgo(11, 14), stage: "awaiting_approval", message: "approved action 'We deleted 11 onboarding steps…' (publish_x_post)", actor: "operator" },
          { id: "e4", at: daysAgo(11, 14, 30), stage: "publish", message: "applied: We deleted 11 onboarding steps…", actor: "agent" },
          { id: "e5", at: daysAgo(11, 16), stage: "learn", message: "1 post(s) measured; 2 takeaway(s) stored for future ideation", actor: "agent" },
        ],
        receipts: [
          { id: "r1", data: { id: "r1", jobId: id, actionId: actPost, actionType: "publish_x_post", idempotencyKey: "demo0000000000000000000001", performedAt: iso(daysAgo(11, 14, 30)), outcome: "applied", artifact: { kind: "x_api", url: "https://x.com/i/web/status/1800000000000001", fetchedAt: iso(daysAgo(11, 14, 31)) }, detail: { id: "1800000000000001", url: "https://x.com/i/web/status/1800000000000001" } } },
          { id: "r3", data: { id: "r3", jobId: id, actionId: actPost, actionType: "publish_x_post", idempotencyKey: "demo0000000000000000000001", performedAt: iso(daysAgo(10, 9)), outcome: "failed", detail: { error: "X_BEARER_TOKEN was rotated mid-run; retried successfully afterwards" } } },
          { id: "r2", data: { id: "r2", jobId: id, actionId: actPack, actionType: "export_content_pack", idempotencyKey: "demo0000000000000000000002", performedAt: iso(daysAgo(11, 14, 31)), outcome: "already_applied", artifact: { kind: "firestore_doc", url: "/api/internal/job/" + id, fetchedAt: iso(daysAgo(11, 14, 31)), digest: "packdigest00000000000000000000000000001" }, detail: { digest: "packdigest00000000000000000000000000001" } } },
        ],
        verifications: [
          { rubricItemId: "x:1800000000000001", verified: true, method: "independent_refetch:x_api", evidence: { url: "https://x.com/i/web/status/1800000000000001", digest: null, fetchedAt: iso(daysAgo(11, 15)) }, checkedAt: iso(daysAgo(11, 15)), note: "re-fetched from X API" },
        ],
        engagement: [{ actionId: actPost, postId: "1800000000000001", url: "https://x.com/i/web/status/1800000000000001", likes: 214, replies: 18, reposts: 41, quotes: 6, impressions: 15230, checkedAt: iso(daysAgo(10)) }],
        learnings: { summary: "1 published post measured; top post earned 214 likes / 41 reposts", notes: ["deletion/subtraction framing outperformed product-feature framings"], generatedAt: iso(daysAgo(10)) },
      },
    );
  }

  // 2) COMPLETE — video job with REAL generated image + clip assets (8 days ago)
  {
    const id = "demo-clips";
    const created = daysAgo(8, 11);
    const imgAct = "act-img-demo01";
    const clipAct = "act-clip-demo1";
    const reelAct = "act-reel-top2";
    const img = genImage(id, imgAct);
    const clip = genClip(id, clipAct, 4);
    const reel = genClip(id, reelAct, 7);
    const assets = [img, clip, reel];
    const d1 = draft("d1", "Your signup flow is an obstacle course. Ours was too — until we treated every step as a suspect.");
    const docData = {
      createdAt: iso(created), updatedAt: iso(daysAgo(7, 18)),
      status: "complete", stage: "complete",
      config: { youtubeUrl: "https://www.youtube.com/watch?v=jNQXAC9IVRw", platforms: ["x"] },
      videoId: "jNQXAC9IVRw", ingestedTitle: "How we rebuilt onboarding around time-to-value (demo)", ingestedChannel: "Harmonia demo channel", ingestedDurationSec: 19,
      summary: "Onboarding teardown with measurable activation gains.",
      transcriptSegments: SEGMENTS.filter((s) => s.endSec <= 23 || s.startSec < 23),
      moments: MOMENTS, angles: ANGLES, drafts: [d1],
      actions: [
        action({ id: "act-content-pack", jobId: id, type: "export_content_pack", title: "Assemble content pack", description: "Bundle moments, angles and drafts into an exportable markdown pack.", payload: { type: "export_content_pack" }, requiresApproval: false, approvalState: "not_required", state: "executed" }),
        action({ id: imgAct, jobId: id, type: "generate_image", title: "Generate meme image: Onboarding obstacle course", description: "Generates an internal image asset with Gemini; review before any use.", angleId: "a2", payload: { type: "generate_image", prompt: "Social media meme image: onboarding as an obstacle course, clean vector style" }, requiresApproval: false, approvalState: "not_required", state: "executed" }),
        action({ id: clipAct, jobId: id, type: "render_clip", title: "Cut clip: Nine days to forty hours", description: "Renders a captioned vertical short from this moment with ffmpeg; internal asset.", momentId: "m2", payload: { type: "render_clip", momentId: "m2", format: "vertical", captions: true }, requiresApproval: false, approvalState: "not_required", state: "executed" }),
        action({ id: reelAct, jobId: id, type: "render_reel", title: "Stitch highlight reel (top 2 moments)", description: "Concatenates the top moments into one vertical reel with ffmpeg; internal asset.", payload: { type: "render_reel", momentIds: ["m1", "m2"], format: "vertical", captions: true }, requiresApproval: false, approvalState: "not_required", state: "executed" }),
        action({ id: "act-pub-x", jobId: id, type: "publish_x_post", title: d1.text.slice(0, 48), description: "Publish drafted post to X after operator approval.", payload: { type: "publish_x_post", text: d1.text }, requiresApproval: true, approvalState: "rejected", state: "skipped" }),
      ],
    };
    await seedJob(
      { id, docData },
      {
        events: [
          { id: "e0a", at: daysAgo(8, 11, 5), stage: "ingest", message: "ingested video jNQXAC9IVRw (19s, audio 214 KB)", actor: "agent" },
          { id: "e0b", at: daysAgo(8, 11, 40), stage: "transcribe", message: "transcription attempt failed: GEMINI_API_KEY is not configured", actor: "system" },
          { id: "e1", at: created, stage: "queued", message: "job created for video jNQXAC9IVRw", actor: "operator" },
          { id: "e2", at: daysAgo(8, 11, 20), stage: "transcribe", message: "transcribed 4 segment(s)", actor: "agent" },
          { id: "e3", at: daysAgo(8, 12), stage: "draft", message: "1 draft(s); 3 auto action(s), 1 awaiting approval", actor: "agent" },
          { id: "e4", at: daysAgo(7, 17), stage: "verify", message: "verification re-checked artifacts: 3/3 confirmed", actor: "agent" },
          { id: "e5", at: daysAgo(7, 18), stage: "learn", message: "assets verified; insights queued", actor: "agent" },
        ],
        receipts: [
          { id: "r1", data: { id: "r1", jobId: id, actionId: "act-content-pack", actionType: "export_content_pack", idempotencyKey: "demo0000000000000000000011", performedAt: iso(daysAgo(7, 16)), outcome: "applied", artifact: { kind: "firestore_doc", url: `/api/internal/job/${id}`, fetchedAt: iso(daysAgo(7, 16)), digest: "clippack000000000000000000000000000002" }, detail: { digest: "clippack000000000000000000000000000002" } } },
          { id: "r2", data: { id: "r2", jobId: id, actionId: imgAct, actionType: "generate_image", idempotencyKey: "demo0000000000000000000012", performedAt: iso(daysAgo(7, 16, 5)), outcome: "applied", artifact: { kind: "asset_store", url: `/api/jobs/${id}/assets/${imgAct}`, fetchedAt: iso(daysAgo(7, 16, 5)), digest: img.digest }, detail: { digest: img.digest, mime: img.mime, bytes: img.size } } },
          { id: "r3", data: { id: "r3", jobId: id, actionId: clipAct, actionType: "render_clip", idempotencyKey: "demo0000000000000000000013", performedAt: iso(daysAgo(7, 16, 10)), outcome: "applied", artifact: { kind: "asset_store", url: `/api/jobs/${id}/assets/${clipAct}`, fetchedAt: iso(daysAgo(7, 16, 10)), digest: clip.digest }, detail: { digest: clip.digest, mime: clip.mime, bytes: clip.size, format: "vertical" } } },
          { id: "r4", data: { id: "r4", jobId: id, actionId: reelAct, actionType: "render_reel", idempotencyKey: "demo0000000000000000000014", performedAt: iso(daysAgo(7, 16, 15)), outcome: "applied", artifact: { kind: "asset_store", url: `/api/jobs/${id}/assets/${reelAct}`, fetchedAt: iso(daysAgo(7, 16, 15)), digest: reel.digest }, detail: { digest: reel.digest, mime: reel.mime, bytes: reel.size, format: "vertical" } } },
        ],
        verifications: [
          { rubricItemId: `asset:${imgAct}`, verified: true, method: "independent_refetch:asset_store", evidence: { kind: "asset_store", url: `/api/jobs/${id}/assets/${imgAct}`, digest: img.digest, fetchedAt: iso(daysAgo(7, 17)) }, checkedAt: iso(daysAgo(7, 17)), note: "stored asset digest matches receipt" },
          { rubricItemId: `asset:${clipAct}`, verified: true, method: "independent_refetch:asset_store", evidence: { kind: "asset_store", url: `/api/jobs/${id}/assets/${clipAct}`, digest: clip.digest, fetchedAt: iso(daysAgo(7, 17)) }, checkedAt: iso(daysAgo(7, 17)), note: "stored asset digest matches receipt" },
          { rubricItemId: `asset:${reelAct}`, verified: true, method: "independent_refetch:asset_store", evidence: { kind: "asset_store", url: `/api/jobs/${id}/assets/${reelAct}`, digest: reel.digest, fetchedAt: iso(daysAgo(7, 17)) }, checkedAt: iso(daysAgo(7, 17)), note: "stored asset digest matches receipt" },
        ],
        engagement: [],
        learnings: { summary: "No published posts measured yet (operator rejected the draft); assets verified 3/3.", notes: ["meme image + clips ready for reuse in future jobs"], generatedAt: iso(daysAgo(7, 18)) },
      },
    );
    for (const a of assets) {
      await db.collection("assets").doc(`${id}_${a.key.split("_")[1]}`).set({
        jobId: id, actionId: a.key.split("_")[1], mime: a.mime, digest: a.digest, sizeBytes: a.size, storageUri: `file://artifacts/${a.key}`, createdAt: iso(daysAgo(7, 16)),
      });
    }
    // extra meme image for item-meme-slot (its own visual)
    {
      const img2 = genImage(id, "act-img-meme2", "color");
      await db.collection("assets").doc(`${id}_act-img-meme2`).set({
        jobId: id, actionId: "act-img-meme2", mime: img2.mime, digest: img2.digest, sizeBytes: img2.size,
        storageUri: `file://artifacts/${img2.key}`, createdAt: iso(daysAgo(6)),
      });
    }
  }

  // 3) AWAITING APPROVAL — live approval exercise (today)
  {
    const id = "demo-launch";
    const created = daysAgo(0, 8);
    const d1 = draft("d1", "Shipping today: usage-based billing for agent workloads. Pay for outcomes, not idle tokens. Launch post incoming 🚀");
    await seedJob(
      { id, docData: {
        createdAt: iso(created), updatedAt: iso(created),
        status: "waiting_for_approval", stage: "awaiting_approval",
        config: { brief: "Announce usage-based billing launch for our AI agent platform. Outcome-oriented framing.", platforms: ["x"] },
        videoId: "brief", ingestedTitle: "Usage-based billing launch (demo)", ingestedChannel: "operator", ingestedDurationSec: 0,
        summary: "Billing launch announcement.",
        transcriptSegments: [], moments: [], angles: ANGLES.slice(0, 1),
        drafts: [d1],
        actions: [
          action({ id: "act-pub-launch", jobId: id, type: "publish_x_post", title: d1.text.slice(0, 48), description: "Publish drafted post to X after operator approval.", payload: { type: "publish_x_post", text: d1.text }, risk: "high", requiresApproval: true, approvalState: "pending", state: "planned" }),
          action({ id: "act-pack-launch", jobId: id, type: "export_content_pack", title: "Assemble content pack", description: "Bundle moments, angles and drafts into an exportable markdown pack.", payload: { type: "export_content_pack" }, requiresApproval: false, approvalState: "not_required", state: "planned" }),
        ],
      } },
      { events: [
        { id: "e1", at: created, stage: "understand", message: "concept job created from operator brief", actor: "operator" },
        { id: "e2", at: daysAgo(0, 8, 30), stage: "draft", message: "1 draft(s); 1 auto action(s), 1 awaiting approval", actor: "agent" },
      ] },
    );
  }

  // 4) RUNNING — at understand (right now)
  {
    const id = "demo-podcast";
    const created = daysAgo(0, 9);
    await seedJob(
      { id, docData: {
        createdAt: iso(created), updatedAt: iso(created),
        status: "running", stage: "understand",
        config: { brief: "React to the new EU AI Act timelines for startups. Practical compliance checklist angle.", platforms: ["x"] },
        videoId: "brief", ingestedTitle: "EU AI Act playbook (demo)", ingestedChannel: "operator", ingestedDurationSec: 0,
        transcriptSegments: [], moments: [], angles: [], drafts: [], actions: [],
      } },
      { events: [{ id: "e1", at: created, stage: "understand", message: "concept job created from operator brief", actor: "operator" }] },
    );
  }

  // 5) FAILED — permanent Gemini auth error (yesterday)
  {
    const id = "demo-failed";
    const created = daysAgo(1, 13);
    await seedJob(
      { id, docData: {
        createdAt: iso(created), updatedAt: iso(daysAgo(1, 13, 20)),
        status: "failed", stage: "failed",
        config: { youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", platforms: ["x"] },
        videoId: "dQw4w9WgXcQ", ingestedTitle: "Founder interview archive clip (demo)", ingestedChannel: "Harmonia demo channel", ingestedDurationSec: 213,
        transcriptSegments: [], moments: [], angles: [], drafts: [], actions: [],
        failure: { stage: "transcribe", error: "GEMINI_API_KEY is not configured", permanent: true, at: iso(daysAgo(1, 13, 20)) },
      } },
      { events: [
        { id: "e1", at: created, stage: "queued", message: "job created for video dQw4w9WgXcQ", actor: "operator" },
        { id: "e2", at: daysAgo(1, 13, 20), stage: "transcribe", message: "permanent failure: GEMINI_API_KEY is not configured", actor: "system" },
      ] },
    );
  }

  // ---------- demo content items (calendar) + notifications ----------
  await wipeCollection("content_items");
  await wipeCollection("notifications");

  const future = new Date();
  future.setDate(future.getDate() + 2);
  future.setHours(10, 30, 0, 0);
  const future2 = new Date();
  future2.setDate(future2.getDate() + 4);
  future2.setHours(17, 0, 0, 0);

  const items = [
    {
      id: "item-act-pub-1", jobId: "demo-onboarding", draftId: "d1",
      text: "We deleted 11 onboarding steps and activation went from 9 days to 40 hours. Subtraction is a growth strategy.",
      platforms: ["x"], status: "published", publishMode: "auto",
      publishedPostId: "1800000000000001",
      publishedUrl: "https://x.com/i/web/status/1800000000000001",
      publishedAt: iso(daysAgo(11, 14, 30)),
      createdAt: iso(daysAgo(12, 9)), updatedAt: iso(daysAgo(10)),
    },
    {
      id: "item-launch", jobId: "demo-launch",
      text: "Shipping today: usage-based billing for agent workloads. Pay for outcomes, not idle tokens.",
      platforms: ["x"], status: "scheduled", publishMode: "approval",
      scheduledFor: iso(future),
      createdAt: iso(daysAgo(1)), updatedAt: iso(daysAgo(1)),
    },
    {
      id: "item-clips-thread", jobId: "demo-clips",
      assetActionIds: ["act-clip-demo1"],
      text: "Your signup flow is an obstacle course. Ours was too — until we treated every step as a suspect. Thread on what we cut 🧵",
      platforms: ["x"], status: "awaiting_final_review", publishMode: "approval",
      scheduledFor: iso(new Date(Date.now() - 3600_000)),
      createdAt: iso(daysAgo(2)), updatedAt: iso(daysAgo(1)),
    },
    {
      id: "item-meme-slot", jobId: "demo-clips",
      text: "POV: your onboarding has a step that just says \"wait\". We removed it and activation doubled.",
      platforms: ["x"], status: "draft", publishMode: "approval",
      assetActionIds: ["act-img-meme2"],
      createdAt: iso(daysAgo(1)), updatedAt: iso(daysAgo(1)),
    },
    {
      id: "item-podcast-takeaway", jobId: "demo-podcast",
      text: "The EU AI Act in plain terms for startups: what ships in August, what you can ignore until 2027.",
      platforms: ["x"], status: "scheduled", publishMode: "auto",
      scheduledFor: iso(future2),
      createdAt: iso(daysAgo(0, 9)), updatedAt: iso(daysAgo(0, 9)),
    },
  ];
  for (const it of items) {
    await db.collection("content_items").doc(it.id).set(it);
  }

  const notifications = [
    {
      kind: "final_review_needed", title: "Final review needed",
      body: '"Your signup flow is an obstacle course…" is due for x. Approve to publish.',
      severity: "warning", refType: "content_item", refId: "item-clips-thread",
      href: "/dashboard/calendar", createdAt: iso(daysAgo(0, 8)), readAt: null,
    },
    {
      kind: "job_failed", title: "Job failed",
      body: "Job demo-failed failed permanently at \'transcribe\': GEMINI_API_KEY is not configured",
      severity: "critical", refType: "job", refId: "demo-failed",
      href: "/dashboard/monitoring", createdAt: iso(daysAgo(1, 13, 21)), readAt: null,
    },
    {
      kind: "learnings_ready", title: "Learnings ready",
      body: "demo-onboarding completed — top post earned 214 likes / 41 reposts.",
      severity: "info", refType: "job", refId: "demo-onboarding",
      href: "/dashboard/monitoring", createdAt: iso(daysAgo(10, 16)), readAt: iso(daysAgo(9)),
    },
  ];
  let nid = 0;
  for (const n of notifications) {
    await db.collection("notifications").doc(`demo-notif-${++nid}`).set(n);
  }
  console.log(`seeded ${items.length} content items + ${notifications.length} notifications`);

  // ---------- demo chat history ----------
  await wipeChats();
  const chats = [
    { at: daysAgo(2, 9, 12), surface: "dashboard", role: "user", text: "create posts about our usage-based billing launch" },
    { at: daysAgo(2, 9, 12, 20), surface: "dashboard", role: "assistant", text: "Created concept job demo-launch from your brief. Running research + ideation + drafting — I'll pause at the approval gate before anything is published.", data: { intent: "create_job", reply: "", jobId: "demo-launch", job: { id: "demo-launch", stage: "awaiting_approval", status: "waiting_for_approval", title: "Usage-based billing launch (demo)" } } },
    { at: daysAgo(2, 10, 2), surface: "dashboard", role: "user", text: "show drafts for demo-clips" },
    { at: daysAgo(2, 10, 2, 15), surface: "dashboard", role: "assistant", text: '1 drafted post(s) for "How we rebuilt onboarding around time-to-value (demo)":', data: { intent: "list_drafts", reply: "", jobId: "demo-clips", drafts: [{ id: "d1", platform: "x", text: "Your signup flow is an obstacle course. Ours was too — until we treated every step as a suspect.", valid: true }] } },
    { at: daysAgo(1, 14, 30), surface: "telegram", role: "user", text: "status" },
    { at: daysAgo(1, 14, 30, 25), surface: "telegram", role: "assistant", text: "4 recent job(s), newest first:", data: { intent: "status", reply: "", jobs: [
      { id: "demo-podcast", stage: "understand", status: "running" },
      { id: "demo-launch", stage: "awaiting_approval", status: "waiting_for_approval" },
      { id: "demo-failed", stage: "failed", status: "failed", failure: { stage: "transcribe", error: "GEMINI_API_KEY is not configured", permanent: true } },
      { id: "demo-clips", stage: "complete", status: "complete" },
    ] } },
    { at: daysAgo(1, 16, 45), surface: "dashboard", role: "user", text: "approve job demo-onboarding" },
    { at: daysAgo(1, 16, 45, 18), surface: "dashboard", role: "assistant", text: "Approved 'We deleted 11 onboarding steps…' for job demo-onboarding. Approved. Publishing dispatched (publish).", data: { intent: "approve", reply: "", jobId: "demo-onboarding", outcome: { ok: true, triggered: "publish" } } },
    { at: daysAgo(0, 8, 55), surface: "dashboard", role: "user", text: "turn https://www.youtube.com/watch?v=jNQXAC9IVRw into clips" },
    { at: daysAgo(0, 8, 55, 20), surface: "dashboard", role: "assistant", text: "Created job demo-clips for video jNQXAC9IVRw. Pipeline ran end to end: 2 captioned vertical clips + a stitched reel are ready — here they are:", data: { intent: "create_job", reply: "", jobId: "demo-clips", job: { id: "demo-clips", stage: "complete", status: "complete", title: "How we rebuilt onboarding around time-to-value (demo)" }, assets: [
      { actionId: "act-clip-demo1", mime: "video/mp4" },
      { actionId: "act-reel-top2", mime: "video/mp4" },
      { actionId: "act-img-demo01", mime: "image/png" },
    ] } },
    { at: daysAgo(0, 9, 40), surface: "dashboard", role: "user", text: "show drafts for demo-clips" },
    { at: daysAgo(0, 9, 40, 15), surface: "dashboard", role: "assistant", text: '1 drafted post(s) for "How we rebuilt onboarding around time-to-value (demo)":', data: { intent: "list_drafts", reply: "", jobId: "demo-clips", drafts: [{ id: "d1", platform: "x", text: "Your signup flow is an obstacle course. Ours was too — until we treated every step as a suspect.", valid: true }], assets: [
      { actionId: "act-img-demo01", mime: "image/png" },
      { actionId: "act-clip-demo1", mime: "video/mp4" },
    ] } },
  ];
  for (let i = 0; i < chats.length; i++) {
    // guarantee strictly ascending timestamps for stable history order
    const at = new Date(chats[i].at.getTime() + i * 41_000);
    await db.collection("chat_messages").add({ ...chats[i], at: ts(at) });
  }
  console.log(`seeded ${chats.length} chat messages (dashboard + telegram history)`);

  console.log("seeded 5 demo jobs (2 complete w/ engagement, 1 complete w/ assets, 1 awaiting approval, 1 running, 1 failed)");
  console.log("assets written to .data/artifacts (image, clip, reel)");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

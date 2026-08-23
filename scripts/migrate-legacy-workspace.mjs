/**
 * One-way, non-destructive migration of pre-SaaS root collections into one
 * owner workspace. Source documents remain untouched for recovery; current
 * application code cannot read them because it only resolves workspace paths.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Firestore } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";

const ownerUserId = process.env.LEGACY_OWNER_UID;
if (!ownerUserId) throw new Error("LEGACY_OWNER_UID is required");
const stableId = (prefix, value) => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
const workspaceId = process.env.LEGACY_WORKSPACE_ID || stableId("ws", ownerUserId);
const brandId = process.env.LEGACY_BRAND_ID || stableId("brand", `${ownerUserId}:default`);
const firestore = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
const workspace = firestore.collection("workspaces").doc(workspaceId);
const collections = [
  "jobs", "event_log", "assets", "content_items", "notifications", "proposals",
  "agent_state", "connections", "chat_messages", "config",
];

async function copyDocument(source, target, patch = {}) {
  const snapshot = await source.get();
  if (!snapshot.exists) return;
  await target.set({ ...snapshot.data(), ...patch }, { merge: false });
  for (const child of await source.listCollections()) {
    const children = await child.listDocuments();
    for (const childDocument of children) {
      await copyDocument(childDocument, target.collection(child.id).doc(childDocument.id));
    }
  }
}

async function main() {
  const now = new Date().toISOString();
  await workspace.set({
    id: workspaceId,
    name: process.env.LEGACY_WORKSPACE_NAME || "Legacy Harmonia workspace",
    ownerUserId,
    defaultBrandId: brandId,
    createdAt: now,
    updatedAt: now,
    budget: {
      estimatedUsd: "0.00", observedUsd: "0.00", reservedUsd: "0.00",
      limitUsd: process.env.DEFAULT_WORKSPACE_BUDGET_USD || "100.00",
      approvalThresholdUsd: process.env.DEFAULT_JOB_APPROVAL_THRESHOLD_USD || "0.25",
    },
  }, { merge: true });
  await workspace.collection("members").doc(ownerUserId).set({ userId: ownerUserId, role: "owner", createdAt: now });
  await workspace.collection("brands").doc(brandId).set({ id: brandId, name: "Default brand", createdAt: now, updatedAt: now }, { merge: true });
  await firestore.collection("users").doc(ownerUserId).set({ defaultWorkspaceId: workspaceId, defaultBrandId: brandId }, { merge: true });

  for (const collectionName of collections) {
    const source = firestore.collection(collectionName);
    for (const document of await source.listDocuments()) {
      const patch = collectionName === "jobs"
        ? { workspaceId, brandId, createdByUserId: ownerUserId }
        : {};
      await copyDocument(document, workspace.collection(collectionName).doc(document.id), patch);
    }
  }

  const assets = await firestore.collection("assets").get();
  const bucketName = process.env.GCS_BUCKET;
  if (bucketName) {
    const bucket = new Storage({ projectId: process.env.GOOGLE_CLOUD_PROJECT }).bucket(bucketName);
    for (const asset of assets.docs) {
      const data = asset.data();
      const key = `${data.jobId}_${data.actionId}`;
      const source = bucket.file(`artifacts/${key}`);
      const [exists] = await source.exists();
      if (exists) await source.copy(bucket.file(`artifacts/${workspaceId}/${brandId}/${key}`));
    }
  } else {
    const root = path.join(process.cwd(), ".data", "artifacts");
    const destination = path.join(root, workspaceId, brandId);
    await mkdir(destination, { recursive: true });
    for (const asset of assets.docs) {
      const data = asset.data();
      const key = `${data.jobId}_${data.actionId}`;
      await copyFile(path.join(root, key), path.join(destination, key)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  console.log(JSON.stringify({ workspaceId, brandId, sourceRetained: true }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

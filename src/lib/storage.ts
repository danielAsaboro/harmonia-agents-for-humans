/**
 * Binary artifact storage. Cloud: GCS bucket (GCS_BUCKET). Local dev: files
 * under .data/artifacts/. Firestore keeps only metadata; bytes live here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getConfig } from "./config";

const LOCAL_ROOT = path.join(process.cwd(), ".data", "artifacts");

function localPath(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(LOCAL_ROOT, safe);
}

export async function putArtifact(key: string, bytes: Uint8Array, mime: string): Promise<string> {
  const bucket = process.env.GCS_BUCKET;
  if (bucket) {
    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage({ projectId: getConfig().GOOGLE_CLOUD_PROJECT });
    const file = storage.bucket(bucket).file(`artifacts/${key}`);
    await file.save(bytes, { contentType: mime, resumable: false });
    return `gs://${bucket}/artifacts/${key}`;
  }
  mkdirSync(LOCAL_ROOT, { recursive: true });
  writeFileSync(localPath(key), bytes);
  return `file://artifacts/${key}`;
}

export async function getArtifact(key: string): Promise<Buffer | null> {
  const bucket = process.env.GCS_BUCKET;
  if (bucket) {
    const { Storage } = await import("@google-cloud/storage");
    const storage = new Storage({ projectId: getConfig().GOOGLE_CLOUD_PROJECT });
    const file = storage.bucket(bucket).file(`artifacts/${key}`);
    try {
      const [exists] = await file.exists();
      if (!exists) return null;
      const [contents] = await file.download();
      return contents;
    } catch {
      return null;
    }
  }
  const p = localPath(key);
  if (!existsSync(p)) return null;
  return readFileSync(p);
}

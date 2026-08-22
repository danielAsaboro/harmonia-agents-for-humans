import { context, propagation } from "@opentelemetry/api";

const CONTENT_FIELDS = new Set([
  "body",
  "content",
  "media",
  "prompt",
  "response",
  "text",
  "transcript",
]);

export function injectTraceContext(carrier: Record<string, string>): void {
  propagation.inject(context.active(), carrier);
}

export function safeTraceAttributes(
  values: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(values)) {
    const segments = key.toLowerCase().replaceAll("-", "_").replaceAll("/", ".").split(".");
    if (segments.some((segment) => CONTENT_FIELDS.has(segment))) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
    }
  }
  return safe;
}

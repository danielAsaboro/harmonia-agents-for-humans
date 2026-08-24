import { context, createContextKey, propagation, trace } from "@opentelemetry/api";

const INBOUND_TRACE_ID = createContextKey("harmonia.inbound-trace-id");

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

export function extractedTraceContext(headers: Headers) {
  const extracted = propagation.extract(context.active(), Object.fromEntries(headers.entries()));
  const match = headers.get("traceparent")?.match(/^00-([a-f0-9]{32})-[a-f0-9]{16}-[a-f0-9]{2}$/i);
  return match ? extracted.setValue(INBOUND_TRACE_ID, match[1].toLowerCase()) : extracted;
}

export function currentTraceId(): string {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  if (spanContext?.traceId && /^[a-f0-9]{32}$/.test(spanContext.traceId)) return spanContext.traceId;
  const inboundTraceId = context.active().getValue(INBOUND_TRACE_ID);
  return typeof inboundTraceId === "string" ? inboundTraceId : "0".repeat(32);
}

export function withTraceContext<T>(headers: Headers, work: () => T): T {
  return context.with(extractedTraceContext(headers), work);
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

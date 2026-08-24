import { describe, expect, it } from "vitest";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import { currentTraceId, withTraceContext } from "@/lib/telemetry";

describe("trace context extraction", () => {
  it("activates a valid inbound W3C traceparent", () => {
    new NodeTracerProvider().register();
    const traceId = "0123456789abcdef0123456789abcdef";
    const headers = new Headers({ traceparent: `00-${traceId}-0123456789abcdef-01` });

    expect(withTraceContext(headers, () => currentTraceId())).toBe(traceId);
  });

  it("does not fabricate an authenticated trace ID when context is absent", () => {
    expect(withTraceContext(new Headers(), () => currentTraceId())).toBe("0".repeat(32));
  });
});

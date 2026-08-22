import { describe, expect, it } from "vitest";
import { trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { buildStageMessage } from "@/lib/pubsub";

describe("trace propagation", () => {
  it("adds W3C trace context without placing content in attributes", async () => {
    const provider = new NodeTracerProvider();
    provider.register();
    const tracer = trace.getTracer("harmonia.test");

    await tracer.startActiveSpan("root", async (span) => {
      const message = buildStageMessage("j1", "understand", 0);
      expect(message.attributes.traceparent).toMatch(/^00-/);
      expect(message.attributes).toMatchObject({ jobId: "j1", stage: "understand" });
      expect(JSON.stringify(message.attributes)).not.toContain("prompt");
      span.end();
    });
  });
});

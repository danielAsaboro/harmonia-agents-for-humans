import { installServerClock } from "@/lib/serverClock";

export async function register(): Promise<void> {
  installServerClock();
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!/^(1|true|yes|on)$/i.test(process.env.HARMONIA_TELEMETRY_ENABLED ?? "")) return;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT required when telemetry is enabled");
  const [otlp, sdk] = await Promise.all([
    import("@opentelemetry/exporter-trace-otlp-grpc"),
    import("@opentelemetry/sdk-trace-node"),
  ]);
  const exporter = new otlp.OTLPTraceExporter({ url: endpoint });
  const provider = new sdk.NodeTracerProvider({
    spanProcessors: [new sdk.BatchSpanProcessor(exporter)],
  });
  provider.register();
}

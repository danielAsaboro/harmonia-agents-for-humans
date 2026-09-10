export async function GET() {
  return Response.json({
    ok: true,
    service: "harmonia-web",
    project: process.env.AWS_ACCOUNT_ID ?? "unconfigured",
    region: process.env.AWS_REGION ?? "us-east-1",
    mode: process.env.HARMONIA_PREVIEW_MODE === "1" ? "preview" : "full",
    durableRuntime: {
      protocolVersion: 1,
      stateStore: "dynamodb",
      wakeTransport: "sqs",
      contextCompiler: "harmonia-context/v1",
    },
  });
}

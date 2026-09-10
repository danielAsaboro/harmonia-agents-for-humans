import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
export function awsConnection(service?: "s3") {
  const endpoint =
    service === "s3"
      ? (process.env.AWS_S3_LOCAL_ENDPOINT ?? process.env.AWS_LOCAL_ENDPOINT)
      : process.env.AWS_LOCAL_ENDPOINT;
  if (
    endpoint &&
    !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(endpoint)
  )
    throw new Error("AWS_LOCAL_ENDPOINT must be loopback");
  if (!endpoint && process.env.HARMONIA_ALLOW_PAID_AWS !== "true")
    throw new Error(
      "AWS operations disabled: HARMONIA_ALLOW_PAID_AWS must be true",
    );
  return { region: process.env.AWS_REGION ?? "us-east-1", endpoint };
}
export async function sendQueueMessage(
  queueUrl: string | undefined,
  message: { data: Buffer; attributes: Record<string, string> },
): Promise<string> {
  if (!queueUrl) throw new Error("SQS queue URL is not configured");
  const result = await new SQSClient(awsConnection()).send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        data: JSON.parse(message.data.toString("utf8")),
        attributes: message.attributes,
      }),
    }),
  );
  if (!result.MessageId)
    throw new Error("SQS send outcome is unknown: no message id");
  return result.MessageId;
}

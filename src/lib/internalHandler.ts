import { z } from "zod";
import { TransitionError } from "./stages";
import { withInternalTenant } from "./internalAuth";

export async function internalRoute<S extends z.ZodType>(
  req: Request,
  schema: S,
  handler: (body: z.infer<S>) => Promise<Response | void>,
): Promise<Response> {
  const bodyJson = await req.json().catch(() => null);
  const parsed = schema.safeParse(bodyJson);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid payload", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  try {
    const result = await withInternalTenant(req, () => handler(parsed.data));
    return result ?? Response.json({ ok: true });
  } catch (err) {
    if (err instanceof TransitionError) {
      return Response.json({ error: err.message }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}

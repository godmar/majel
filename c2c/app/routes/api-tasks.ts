import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Route } from "./+types/api-tasks";
import { requireBearer } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { agentDefinitions } from "~/lib/schema.server";
import { createTask } from "~/lib/tasks.server";

const createSchema = z.object({
  agent: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().optional(),
});

/**
 * Machine API for creating tasks programmatically — the entry point for
 * external event triggers (webhooks, schedulers, other services).
 */
export async function action({ request }: Route.ActionArgs) {
  requireBearer(request);
  if (request.method !== "POST") throw new Response("Method not allowed", { status: 405 });

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const agent = await db.query.agentDefinitions.findFirst({
    where: eq(agentDefinitions.name, parsed.data.agent),
  });
  if (!agent || !agent.enabled) {
    return Response.json({ error: `Unknown or disabled agent "${parsed.data.agent}"` }, { status: 404 });
  }

  const task = await createTask({
    agentDefinitionId: agent.id,
    prompt: parsed.data.prompt,
    modelOverride: parsed.data.model ?? null,
    triggerSource: "api",
  });

  return Response.json({ id: task.id, status: task.status }, { status: 201 });
}

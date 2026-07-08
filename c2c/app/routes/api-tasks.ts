import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Route } from "./+types/api-tasks";
import { requireBearer } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { agentDefinitions, users } from "~/lib/schema.server";
import { createTask } from "~/lib/tasks.server";

const createSchema = z.object({
  agent: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().optional(),
  // API keys are per user, so every task runs on someone's behalf.
  user: z.string().min(1),
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

  const onBehalfOf = await db.query.users.findFirst({
    where: eq(users.username, parsed.data.user.toLowerCase()),
  });
  if (!onBehalfOf || !onBehalfOf.enabled) {
    return Response.json({ error: `Unknown or disabled user "${parsed.data.user}"` }, { status: 404 });
  }

  try {
    const task = await createTask({
      agentDefinitionId: agent.id,
      prompt: parsed.data.prompt,
      modelOverride: parsed.data.model ?? null,
      createdBy: onBehalfOf.id,
      triggerSource: "api",
    });
    return Response.json({ id: task.id, status: task.status }, { status: 201 });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to create task" },
      { status: 422 },
    );
  }
}

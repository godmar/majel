import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Route } from "./+types/api-runner-events";
import { requireBearer } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { tasks } from "~/lib/schema.server";
import { addTaskEvent, isTerminal } from "~/lib/tasks.server";

const eventSchema = z.object({
  type: z.string().min(1).max(64),
  message: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/** Runner: lifecycle events. Some event types drive status transitions. */
export async function action({ request, params }: Route.ActionArgs) {
  requireBearer(request);
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, params.taskId) });
  if (!task) throw new Response("Not found", { status: 404 });

  const parsed = eventSchema.safeParse(await request.json());
  if (!parsed.success) throw new Response("Bad request", { status: 400 });
  const event = parsed.data;

  if (!isTerminal(task.status)) {
    if (event.type === "runner_started") {
      await db
        .update(tasks)
        .set({ status: "running", startedAt: task.startedAt ?? new Date() })
        .where(eq(tasks.id, task.id));
    } else if (event.type === "session_created" && typeof event.data?.sessionID === "string") {
      await db
        .update(tasks)
        .set({ opencodeSessionId: event.data.sessionID })
        .where(eq(tasks.id, task.id));
    }
  }

  await addTaskEvent(task.id, event.type, event.message, event.data);
  return Response.json({ ok: true });
}

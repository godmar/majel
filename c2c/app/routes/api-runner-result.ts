import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Route } from "./+types/api-runner-result";
import { requireBearer } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { tasks } from "~/lib/schema.server";
import { addTaskEvent, isTerminal } from "~/lib/tasks.server";

const resultSchema = z.object({
  ok: z.boolean(),
  resultText: z.string().optional(),
  transcript: z.array(z.unknown()).optional(),
  error: z.string().optional(),
});

/** Runner: final outcome. Terminal statuses (e.g. canceled) are not overwritten. */
export async function action({ request, params }: Route.ActionArgs) {
  requireBearer(request);
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, params.taskId) });
  if (!task) throw new Response("Not found", { status: 404 });

  const parsed = resultSchema.safeParse(await request.json());
  if (!parsed.success) throw new Response("Bad request", { status: 400 });
  const result = parsed.data;

  if (isTerminal(task.status)) {
    return Response.json({ ok: true, ignored: true });
  }

  await db
    .update(tasks)
    .set({
      status: result.ok ? "succeeded" : "failed",
      resultText: result.resultText ?? null,
      ...(result.transcript ? { transcript: result.transcript } : {}),
      error: result.ok ? null : (result.error ?? "Agent failed without details"),
      finishedAt: new Date(),
    })
    .where(eq(tasks.id, task.id));

  await addTaskEvent(
    task.id,
    result.ok ? "completed" : "error",
    result.ok ? "Agent completed the task" : (result.error ?? "Agent failed"),
  );
  return Response.json({ ok: true });
}

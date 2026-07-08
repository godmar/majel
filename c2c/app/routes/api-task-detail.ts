import { eq } from "drizzle-orm";
import type { Route } from "./+types/api-task-detail";
import { requireBearer } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { listTaskFiles } from "~/lib/files.server";
import { tasks } from "~/lib/schema.server";

/** Machine API: task status and result. */
export async function loader({ request, params }: Route.LoaderArgs) {
  requireBearer(request);
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, params.taskId) });
  if (!task) throw new Response("Not found", { status: 404 });
  const files = await listTaskFiles(task.id);
  return Response.json({
    id: task.id,
    status: task.status,
    prompt: task.prompt,
    resultText: task.resultText,
    error: task.error,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    files,
  });
}

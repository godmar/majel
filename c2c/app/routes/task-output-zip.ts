import { and, asc, eq } from "drizzle-orm";
import type { Route } from "./+types/task-output-zip";
import { requireUser } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { taskFiles, tasks } from "~/lib/schema.server";
import { buildZip } from "~/lib/zip.server";

/** Every file the agent left in its workspace, as one .zip download. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, params.taskId) });
  if (!task) throw new Response("Not found", { status: 404 });
  if (user.role !== "admin" && task.createdBy !== user.id) {
    throw new Response("Forbidden", { status: 403 });
  }

  const files = await db
    .select({ filename: taskFiles.filename, content: taskFiles.content, createdAt: taskFiles.createdAt })
    .from(taskFiles)
    .where(and(eq(taskFiles.taskId, task.id), eq(taskFiles.kind, "output")))
    .orderBy(asc(taskFiles.filename));
  if (files.length === 0) throw new Response("This task has no output files", { status: 404 });

  const zip = buildZip(
    files.map((f) => ({ name: f.filename, content: f.content, modified: f.createdAt })),
  );
  return new Response(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zip.length),
      "Content-Disposition": `attachment; filename="task-${task.id.slice(0, 8)}-files.zip"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}

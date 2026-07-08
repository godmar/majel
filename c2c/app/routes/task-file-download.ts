import { eq } from "drizzle-orm";
import type { Route } from "./+types/task-file-download";
import { requireUser } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { getTaskFile } from "~/lib/files.server";
import { tasks } from "~/lib/schema.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, params.taskId) });
  if (!task) throw new Response("Not found", { status: 404 });
  if (user.role !== "admin" && task.createdBy !== user.id) {
    throw new Response("Forbidden", { status: 403 });
  }

  const file = await getTaskFile(params.taskId, Number(params.fileId));
  if (!file) throw new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(file.content), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(file.sizeBytes),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}

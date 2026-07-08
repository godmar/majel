import { eq } from "drizzle-orm";
import type { Route } from "./+types/api-runner-result-file";
import { requireBearer } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { FileTooLargeError, MAX_FILE_BYTES, saveTaskFile } from "~/lib/files.server";
import { tasks } from "~/lib/schema.server";

/**
 * Runner: upload one output file per request (raw body; filename in the
 * URI-encoded X-Filename header) so memory stays bounded on both sides.
 */
export async function action({ request, params }: Route.ActionArgs) {
  requireBearer(request);
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, params.taskId) });
  if (!task) throw new Response("Not found", { status: 404 });

  const rawName = request.headers.get("X-Filename");
  if (!rawName) throw new Response("X-Filename header required", { status: 400 });
  const filename = decodeURIComponent(rawName);

  const content = Buffer.from(await request.arrayBuffer());
  if (content.length === 0 || content.length > MAX_FILE_BYTES) {
    throw new Response("Payload empty or too large", { status: 413 });
  }

  try {
    const id = await saveTaskFile({
      taskId: task.id,
      kind: "output",
      filename,
      mimeType: request.headers.get("Content-Type") ?? undefined,
      content,
    });
    return Response.json({ ok: true, id });
  } catch (err) {
    if (err instanceof FileTooLargeError) {
      throw new Response(err.message, { status: 413 });
    }
    throw err;
  }
}

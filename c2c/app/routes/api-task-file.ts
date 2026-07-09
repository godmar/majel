import type { Route } from "./+types/api-task-file";
import { requireBearer } from "~/lib/auth.server";
import { getTaskFile } from "~/lib/files.server";

/** Machine API: raw bytes of one task file (input or output). */
export async function loader({ request, params }: Route.LoaderArgs) {
  requireBearer(request);
  const file = await getTaskFile(params.taskId, Number(params.fileId));
  if (!file) throw new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(file.content), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(file.sizeBytes),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    },
  });
}

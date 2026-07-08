import type { Route } from "./+types/api-runner-file";
import { requireBearer } from "~/lib/auth.server";
import { getTaskFile } from "~/lib/files.server";

/** Runner: raw bytes of one input file. */
export async function loader({ request, params }: Route.LoaderArgs) {
  requireBearer(request);
  const file = await getTaskFile(params.taskId, Number(params.fileId));
  if (!file) throw new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(file.content), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(file.sizeBytes),
    },
  });
}

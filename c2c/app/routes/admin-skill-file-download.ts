import { and, eq } from "drizzle-orm";
import type { Route } from "./+types/admin-skill-file-download";
import { requireAdmin } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { skillFiles } from "~/lib/schema.server";

/** One supporting file of a skill, as stored. */
export async function loader({ request, params }: Route.LoaderArgs) {
  await requireAdmin(request);
  const file = await db.query.skillFiles.findFirst({
    where: and(eq(skillFiles.id, Number(params.fileId)), eq(skillFiles.skillId, Number(params.skillId))),
  });
  if (!file) throw new Response("Not found", { status: 404 });

  const filename = file.path.slice(file.path.lastIndexOf("/") + 1);
  return new Response(new Uint8Array(file.content), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.sizeBytes),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "private, no-store",
    },
  });
}

import { eq } from "drizzle-orm";
import type { Route } from "./+types/api-runner-input";
import { requireBearer } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { listTaskFiles } from "~/lib/files.server";
import { agentDefinitions, tasks } from "~/lib/schema.server";

/** Runner: task prompt (with input-file preamble) and input file metadata. */
export async function loader({ request, params }: Route.LoaderArgs) {
  requireBearer(request);
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, params.taskId) });
  if (!task) throw new Response("Not found", { status: 404 });

  const agent = await db.query.agentDefinitions.findFirst({
    where: eq(agentDefinitions.id, task.agentDefinitionId),
  });

  const files = (await listTaskFiles(task.id)).filter((f) => f.kind === "input");
  const preamble =
    files.length > 0
      ? `The following input files are available in your working directory:\n${files
          .map((f) => `- ${f.filename}`)
          .join("\n")}\n\n`
      : "";

  return Response.json({
    taskId: task.id,
    prompt: preamble + task.prompt,
    agent: agent?.name,
    timeoutSeconds: agent?.timeoutSeconds ?? 1800,
    files: files.map((f) => ({
      id: f.id,
      filename: f.filename,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
    })),
  });
}

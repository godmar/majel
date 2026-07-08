import { eq } from "drizzle-orm";
import type { Route } from "./+types/api-runner-transcript";
import { requireBearer } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { tasks } from "~/lib/schema.server";

// Transcripts can get large; matches the task output cap.
const MAX_TRANSCRIPT_BYTES = 20 * 1024 * 1024;

/**
 * Runner: periodic full-snapshot transcript sync (PUT, idempotent) that
 * powers the live activity view.
 */
export async function action({ request, params }: Route.ActionArgs) {
  requireBearer(request);
  if (request.method !== "PUT") throw new Response("Method not allowed", { status: 405 });

  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, params.taskId) });
  if (!task) throw new Response("Not found", { status: 404 });

  const body = await request.text();
  if (body.length > MAX_TRANSCRIPT_BYTES) {
    throw new Response("Payload too large", { status: 413 });
  }
  let transcript: unknown;
  try {
    transcript = JSON.parse(body);
  } catch {
    throw new Response("Bad request", { status: 400 });
  }
  if (!Array.isArray(transcript)) throw new Response("Bad request", { status: 400 });

  await db.update(tasks).set({ transcript }).where(eq(tasks.id, task.id));
  return Response.json({ ok: true });
}

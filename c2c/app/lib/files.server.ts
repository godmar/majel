import { and, eq, sum } from "drizzle-orm";
import { db } from "./db.server";
import { taskFiles } from "./schema.server";

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
export const MAX_TASK_BYTES = 100 * 1024 * 1024; // 100 MB per task and kind

export class FileTooLargeError extends Error {}

/**
 * Store one task file (input or output) in Postgres. Abstracts the storage
 * backend so a later move to a volume or object store is contained here.
 */
export async function saveTaskFile(opts: {
  taskId: string;
  kind: "input" | "output";
  filename: string;
  mimeType?: string;
  content: Buffer;
}): Promise<number> {
  if (opts.content.length > MAX_FILE_BYTES) {
    throw new FileTooLargeError(
      `${opts.filename} is ${opts.content.length} bytes; limit is ${MAX_FILE_BYTES}`,
    );
  }
  const [{ total }] = await db
    .select({ total: sum(taskFiles.sizeBytes) })
    .from(taskFiles)
    .where(and(eq(taskFiles.taskId, opts.taskId), eq(taskFiles.kind, opts.kind)));
  if (Number(total ?? 0) + opts.content.length > MAX_TASK_BYTES) {
    throw new FileTooLargeError(`total ${opts.kind} file size for task exceeds ${MAX_TASK_BYTES}`);
  }

  const [row] = await db
    .insert(taskFiles)
    .values({
      taskId: opts.taskId,
      kind: opts.kind,
      filename: opts.filename,
      mimeType: opts.mimeType ?? "application/octet-stream",
      sizeBytes: opts.content.length,
      content: opts.content,
    })
    .returning({ id: taskFiles.id });
  return row.id;
}

/** File metadata only — never pulls bytea content into list views. */
export async function listTaskFiles(taskId: string) {
  return db
    .select({
      id: taskFiles.id,
      kind: taskFiles.kind,
      filename: taskFiles.filename,
      mimeType: taskFiles.mimeType,
      sizeBytes: taskFiles.sizeBytes,
      createdAt: taskFiles.createdAt,
    })
    .from(taskFiles)
    .where(eq(taskFiles.taskId, taskId));
}

export async function getTaskFile(taskId: string, fileId: number) {
  return db.query.taskFiles.findFirst({
    where: and(eq(taskFiles.id, fileId), eq(taskFiles.taskId, taskId)),
  });
}

import { eq } from "drizzle-orm";
import { db } from "./db.server";
import { saveTaskFile } from "./files.server";
import { agentDefinitions, taskEvents, tasks, type Task } from "./schema.server";

export interface CreateTaskInput {
  agentDefinitionId: number;
  prompt: string;
  createdBy?: number | null;
  triggerSource: "web" | "api";
  modelOverride?: string | null;
  files?: { filename: string; mimeType?: string; content: Buffer }[];
}

/**
 * Single funnel for task creation — the web UI action and the machine API
 * (and any future external event source) all go through here.
 */
export async function createTask(input: CreateTaskInput): Promise<Task> {
  const agent = await db.query.agentDefinitions.findFirst({
    where: eq(agentDefinitions.id, input.agentDefinitionId),
  });
  if (!agent || !agent.enabled) {
    throw new Error("Unknown or disabled agent");
  }

  const [task] = await db
    .insert(tasks)
    .values({
      agentDefinitionId: agent.id,
      createdBy: input.createdBy ?? null,
      triggerSource: input.triggerSource,
      prompt: input.prompt,
      modelOverride: input.modelOverride ?? null,
    })
    .returning();

  for (const file of input.files ?? []) {
    await saveTaskFile({
      taskId: task.id,
      kind: "input",
      filename: file.filename,
      mimeType: file.mimeType,
      content: file.content,
    });
  }

  await addTaskEvent(task.id, "created", `Task created via ${input.triggerSource}`);

  // Launch on the cluster (fire-and-forget; the reconciler and task detail
  // page surface launch failures).
  const { launchTask } = await import("./k8s.server");
  launchTask(task.id).catch(async (err) => {
    console.error(`launch failed for task ${task.id}:`, err);
    await failTask(task.id, `Failed to launch agent job: ${err instanceof Error ? err.message : err}`);
  });

  return task;
}

export async function addTaskEvent(
  taskId: string,
  type: string,
  message?: string,
  data?: unknown,
): Promise<void> {
  await db.insert(taskEvents).values({ taskId, type, message, data });
}

export async function failTask(taskId: string, error: string): Promise<void> {
  await db
    .update(tasks)
    .set({ status: "failed", error, finishedAt: new Date() })
    .where(eq(tasks.id, taskId));
  await addTaskEvent(taskId, "error", error);
}

const TERMINAL: Task["status"][] = ["succeeded", "failed", "timeout", "canceled"];

export function isTerminal(status: Task["status"]): boolean {
  return TERMINAL.includes(status);
}

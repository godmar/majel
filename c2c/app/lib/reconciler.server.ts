import { eq, inArray } from "drizzle-orm";
import { db } from "./db.server";
import { readJob } from "./k8s.server";
import { agentDefinitions, tasks } from "./schema.server";
import { addTaskEvent } from "./tasks.server";

const INTERVAL_MS = 30_000;
// How long a finished/vanished Job may lag before the task is failed; covers
// the window where the runner is still uploading its result.
const REPORT_GRACE_MS = 2 * 60_000;
// Extra wall-clock allowance beyond the agent timeout before force-timeout.
const TIMEOUT_SLACK_MS = 5 * 60_000;

declare global {
  var __reconcilerStarted: boolean | undefined;
}

async function finishTask(
  taskId: string,
  status: "failed" | "timeout",
  message: string,
): Promise<void> {
  await db
    .update(tasks)
    .set({ status, error: message, finishedAt: new Date() })
    .where(eq(tasks.id, taskId));
  await addTaskEvent(taskId, "reconciler", message);
}

/**
 * Safety net behind the runner's callbacks: fails tasks whose Job died,
 * vanished, or overran before the runner could report.
 */
async function reconcile(): Promise<void> {
  const active = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      k8sJobName: tasks.k8sJobName,
      createdAt: tasks.createdAt,
      timeoutSeconds: agentDefinitions.timeoutSeconds,
    })
    .from(tasks)
    .innerJoin(agentDefinitions, eq(tasks.agentDefinitionId, agentDefinitions.id))
    .where(inArray(tasks.status, ["pending", "scheduled", "running"]));

  const now = Date.now();

  for (const task of active) {
    const age = now - new Date(task.createdAt).getTime();

    try {
      if (!task.k8sJobName) {
        // Launch never completed (crash between insert and Job creation).
        if (age > REPORT_GRACE_MS + 60_000) {
          await finishTask(task.id, "failed", "Agent job was never created");
        }
        continue;
      }

      if (age > task.timeoutSeconds * 1000 + TIMEOUT_SLACK_MS) {
        await finishTask(
          task.id,
          "timeout",
          `Task exceeded its ${task.timeoutSeconds}s time budget`,
        );
        const { cancelTask } = await import("./k8s.server");
        await cancelTask(task.id);
        continue;
      }

      const job = await readJob(task.k8sJobName);
      if (!job) {
        if (age > REPORT_GRACE_MS) {
          await finishTask(task.id, "failed", `Job ${task.k8sJobName} no longer exists`);
        }
        continue;
      }

      // FailureTarget precedes Failed and can linger while pods shut down
      // (e.g. ImagePullBackOff), so both count as failure.
      const failedCondition = job.status?.conditions?.find(
        (c) => (c.type === "Failed" || c.type === "FailureTarget") && c.status === "True",
      );
      if (failedCondition) {
        if (failedCondition.reason === "DeadlineExceeded") {
          await finishTask(
            task.id,
            "timeout",
            `Task exceeded its ${task.timeoutSeconds}s time budget`,
          );
        } else {
          await finishTask(
            task.id,
            "failed",
            `Agent job failed: ${failedCondition.reason ?? "unknown"} ${failedCondition.message ?? ""}`.trim(),
          );
        }
        continue;
      }

      const completionTime = job.status?.completionTime;
      if (
        job.status?.succeeded &&
        completionTime &&
        now - new Date(completionTime).getTime() > REPORT_GRACE_MS
      ) {
        await finishTask(
          task.id,
          "failed",
          "Agent job finished but the runner never reported a result",
        );
      }
    } catch (err) {
      console.error(`reconciler: error handling task ${task.id}:`, err);
    }
  }
}

export function startReconciler(): void {
  if (globalThis.__reconcilerStarted) return;
  globalThis.__reconcilerStarted = true;
  setInterval(() => {
    reconcile().catch((err) => console.error("reconciler pass failed:", err));
  }, INTERVAL_MS).unref();
  console.error("task reconciler started");
}

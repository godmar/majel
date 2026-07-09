import { asc, count, eq, inArray } from "drizzle-orm";
import { db } from "./db.server";
import { tasks, userProviderKeys } from "./schema.server";
import { addTaskEvent, failTask } from "./tasks.server";

/**
 * Concurrency-limited task dispatcher. Tasks are created with status
 * "pending" and only launched from here; a per-key limit
 * (user_provider_keys.concurrency_limit, 0 = unlimited) caps how many tasks
 * may be in flight per LLM API key — i.e. per (created_by, provider_id) —
 * and excess tasks wait in FIFO order until a slot frees.
 *
 * dispatchQueue() is called after every event that could free or need a slot
 * (task created, task reached a terminal state) and from the reconciler as a
 * backstop. All state below is in-process, which is sound because the c2c
 * deployment runs a single replica.
 */

/** Statuses that occupy a concurrency slot. */
const IN_FLIGHT = ["scheduled", "running"] as const;

// Tasks a dispatch pass has claimed whose Job creation is still in progress
// (status still "pending"), mapped to their key scope so passes count them.
const launching = new Map<string, string>();
// Tasks whose "queued" event was already written, to log it only once.
const queueEventLogged = new Set<string>();

let dispatching = false;
let rerunRequested = false;

function scopeOf(task: { createdBy: number | null; providerId: number | null }): string {
  return `${task.createdBy}:${task.providerId}`;
}

/** Fire-and-forget, single-flight: overlapping calls coalesce into a rerun. */
export function dispatchQueue(): void {
  if (dispatching) {
    rerunRequested = true;
    return;
  }
  dispatching = true;
  (async () => {
    do {
      rerunRequested = false;
      await dispatchPass();
    } while (rerunRequested);
  })()
    .catch((err) => console.error("queue dispatch failed:", err))
    .finally(() => {
      dispatching = false;
    });
}

async function dispatchPass(): Promise<void> {
  const queued = (
    await db
      .select({ id: tasks.id, createdBy: tasks.createdBy, providerId: tasks.providerId })
      .from(tasks)
      .where(eq(tasks.status, "pending"))
      .orderBy(asc(tasks.createdAt))
  ).filter((t) => !launching.has(t.id));
  if (queued.length === 0) return;

  const inFlight = new Map<string, number>();
  const counts = await db
    .select({ createdBy: tasks.createdBy, providerId: tasks.providerId, n: count() })
    .from(tasks)
    .where(inArray(tasks.status, [...IN_FLIGHT]))
    .groupBy(tasks.createdBy, tasks.providerId);
  for (const row of counts) inFlight.set(scopeOf(row), row.n);
  for (const scope of launching.values()) inFlight.set(scope, (inFlight.get(scope) ?? 0) + 1);

  const userIds = [...new Set(queued.map((t) => t.createdBy).filter((x) => x !== null))];
  const limits = new Map<string, number>();
  if (userIds.length > 0) {
    const rows = await db
      .select({
        userId: userProviderKeys.userId,
        providerId: userProviderKeys.providerId,
        limit: userProviderKeys.concurrencyLimit,
      })
      .from(userProviderKeys)
      .where(inArray(userProviderKeys.userId, userIds));
    for (const row of rows) limits.set(`${row.userId}:${row.providerId}`, row.limit);
  }

  for (const task of queued) {
    const scope = scopeOf(task);
    const limit = limits.get(scope) ?? 0;
    const current = inFlight.get(scope) ?? 0;
    if (limit > 0 && current >= limit) {
      if (!queueEventLogged.has(task.id)) {
        queueEventLogged.add(task.id);
        await addTaskEvent(
          task.id,
          "queued",
          `Waiting for a free slot (concurrency limit ${limit} for this API key)`,
        );
      }
      continue;
    }

    inFlight.set(scope, current + 1);
    launching.set(task.id, scope);
    queueEventLogged.delete(task.id);
    const { launchTask } = await import("./k8s.server");
    launchTask(task.id)
      .catch(async (err) => {
        console.error(`launch failed for task ${task.id}:`, err);
        await failTask(
          task.id,
          `Failed to launch agent job: ${err instanceof Error ? err.message : err}`,
        );
      })
      .finally(() => {
        launching.delete(task.id);
      });
  }
}

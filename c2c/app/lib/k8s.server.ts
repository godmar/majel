import { addTaskEvent } from "./tasks.server";

/**
 * Launch the sandbox Job for a task. Stub until the K8s integration lands
 * (M4): records an event and leaves the task pending.
 */
export async function launchTask(taskId: string): Promise<void> {
  await addTaskEvent(taskId, "launch_skipped", "K8s launcher not yet wired; task stays pending");
}

/** Delete the task's Job, if any. Stub until the K8s integration lands (M4). */
export async function cancelTask(_taskId: string): Promise<void> {}

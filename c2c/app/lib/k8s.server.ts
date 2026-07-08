import * as k8s from "@kubernetes/client-node";
import { eq } from "drizzle-orm";
import { db } from "./db.server";
import { env } from "./env.server";
import { renderOpencodeConfig } from "./opencode-config.server";
import { agentDefinitions, tasks } from "./schema.server";
import { addTaskEvent } from "./tasks.server";

const NAMESPACE = env.K8S_NAMESPACE;
const IMAGE_PULL_SECRET = "registry-secret";

declare global {
  var __kubeConfig: k8s.KubeConfig | undefined;
}

function kubeConfig(): k8s.KubeConfig {
  if (!globalThis.__kubeConfig) {
    const kc = new k8s.KubeConfig();
    // Honors $KUBECONFIG, falls back to in-cluster service account.
    kc.loadFromDefault();
    globalThis.__kubeConfig = kc;
  }
  return globalThis.__kubeConfig;
}

export function batchApi() {
  return kubeConfig().makeApiClient(k8s.BatchV1Api);
}

function coreApi() {
  return kubeConfig().makeApiClient(k8s.CoreV1Api);
}

export function jobNameForTask(taskId: string): string {
  return `agent-task-${taskId.slice(0, 8)}`;
}

/** Parse SANDBOX_NODE_SELECTOR ("key=value,key2=value2") into a selector map. */
function nodeSelector(): Record<string, string> | undefined {
  if (!env.SANDBOX_NODE_SELECTOR) return undefined;
  const selector: Record<string, string> = {};
  for (const pair of env.SANDBOX_NODE_SELECTOR.split(",")) {
    const [key, value] = pair.split("=").map((s) => s.trim());
    if (key && value) selector[key] = value;
  }
  return Object.keys(selector).length > 0 ? selector : undefined;
}

/**
 * Launch the sandbox Job for a task: a per-task Secret carries the rendered
 * opencode config and the callback token; the Job mounts it and runs the
 * sandbox image. The Secret is owned by the Job so TTL cleanup cascades.
 */
export async function launchTask(taskId: string): Promise<void> {
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  if (!task) throw new Error(`task ${taskId} not found`);
  const agent = await db.query.agentDefinitions.findFirst({
    where: eq(agentDefinitions.id, task.agentDefinitionId),
  });
  if (!agent) throw new Error(`agent for task ${taskId} not found`);

  if (!env.SANDBOX_CONTAINER_IMAGE) {
    throw new Error("SANDBOX_CONTAINER_IMAGE is not configured");
  }

  const config = await renderOpencodeConfig(agent, task.modelOverride);
  const jobName = jobNameForTask(taskId);
  const secretName = `${jobName}-config`;
  const ccApiUrl = env.CC_INTERNAL_URL ?? env.CC_BEARER_URL;

  await coreApi().createNamespacedSecret({
    namespace: NAMESPACE,
    body: {
      metadata: {
        name: secretName,
        labels: { app: "opencode-agent", "task-id": taskId },
      },
      stringData: {
        "config.json": JSON.stringify(config),
        "cc-bearer-token": env.CC_BEARER_TOKEN,
      },
    },
  });

  const job = await batchApi().createNamespacedJob({
    namespace: NAMESPACE,
    body: {
      metadata: {
        name: jobName,
        labels: { app: "opencode-agent", "task-id": taskId },
      },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: agent.timeoutSeconds,
        ttlSecondsAfterFinished: 3600,
        template: {
          metadata: { labels: { app: "opencode-agent", "task-id": taskId } },
          spec: {
            restartPolicy: "Never",
            nodeSelector: nodeSelector(),
            imagePullSecrets: [{ name: IMAGE_PULL_SECRET }],
            containers: [
              {
                name: "agent",
                image: env.SANDBOX_CONTAINER_IMAGE,
                imagePullPolicy: "Always",
                env: [
                  { name: "TASK_ID", value: taskId },
                  { name: "CC_API_URL", value: ccApiUrl },
                  {
                    name: "CC_BEARER_TOKEN",
                    valueFrom: {
                      secretKeyRef: { name: secretName, key: "cc-bearer-token" },
                    },
                  },
                  { name: "OPENCODE_CONFIG", value: "/etc/opencode/config.json" },
                  { name: "TASK_TIMEOUT_SECONDS", value: String(agent.timeoutSeconds) },
                ],
                volumeMounts: [{ name: "opencode-config", mountPath: "/etc/opencode", readOnly: true }],
                resources: {
                  requests: { cpu: "250m", memory: "512Mi" },
                  limits: { cpu: "2", memory: "2Gi" },
                },
              },
            ],
            volumes: [{ name: "opencode-config", secret: { secretName } }],
          },
        },
      },
    },
  });

  // Cascade Secret deletion with the Job's TTL cleanup.
  try {
    await coreApi().patchNamespacedSecret(
      {
        namespace: NAMESPACE,
        name: secretName,
        body: {
          metadata: {
            ownerReferences: [
              {
                apiVersion: "batch/v1",
                kind: "Job",
                name: jobName,
                uid: job.metadata!.uid!,
              },
            ],
          },
        },
      },
      k8s.setHeaderOptions("Content-Type", k8s.PatchStrategy.StrategicMergePatch),
    );
  } catch (err) {
    console.error(`failed to set ownerReference on ${secretName}:`, err);
  }

  await db
    .update(tasks)
    .set({ status: "scheduled", k8sJobName: jobName })
    .where(eq(tasks.id, taskId));
  await addTaskEvent(taskId, "job_created", `Kubernetes Job ${jobName} created`);
}

/** Delete the task's Job (and, via ownerReference, its config Secret). */
export async function cancelTask(taskId: string): Promise<void> {
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
  const jobName = task?.k8sJobName;
  if (!jobName) return;
  try {
    await batchApi().deleteNamespacedJob({
      namespace: NAMESPACE,
      name: jobName,
      propagationPolicy: "Background",
    });
    await addTaskEvent(taskId, "job_deleted", `Kubernetes Job ${jobName} deleted`);
  } catch (err: unknown) {
    if ((err as { code?: number }).code !== 404) {
      console.error(`failed to delete job ${jobName}:`, err);
    }
  }
}

export async function readJob(jobName: string): Promise<k8s.V1Job | null> {
  try {
    return await batchApi().readNamespacedJob({ namespace: NAMESPACE, name: jobName });
  } catch (err: unknown) {
    if ((err as { code?: number }).code === 404) return null;
    throw err;
  }
}

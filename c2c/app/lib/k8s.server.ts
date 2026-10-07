import * as k8s from "@kubernetes/client-node";
import { eq } from "drizzle-orm";
import { db } from "./db.server";
import { egressProxyConfigured, mintEgressCredential } from "./egress.server";
import { env } from "./env.server";
import {
  egressAllowlist,
  grantedSkills,
  renderOpencodeConfig,
  SKILLS_DIR,
  type GrantedSkill,
} from "./opencode-config.server";
import { mintRunnerToken } from "./runner-credential.server";
import { agentDefinitions, tasks } from "./schema.server";
import { renderSkillMarkdown } from "./skills";
import { addTaskEvent } from "./tasks.server";

const NAMESPACE = env.K8S_NAMESPACE;
const IMAGE_PULL_SECRET = "registry-secret";

// Kubernetes refuses a Secret over 1 MiB; leave headroom for its metadata.
const MAX_SECRET_BYTES = 900 * 1024;

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
 * How granted skills travel in the task's Secret: each becomes
 * <name>/SKILL.md plus its supporting files, projected into the skills
 * folder. Skill names are [a-z0-9-] and file keys are indexed, so every key
 * is a valid Secret key whatever the file is called. Supporting files may be
 * binary (an .xlsx template), so they go in as base64 `data`.
 */
export function skillSecretEntries(skillSet: GrantedSkill[]) {
  const stringData: Record<string, string> = {};
  const data: Record<string, string> = {};
  const items: { key: string; path: string; mode: number }[] = [];
  for (const sk of skillSet) {
    const key = `skill-${sk.name}`;
    stringData[key] = renderSkillMarkdown(sk);
    items.push({ key, path: `${sk.name}/SKILL.md`, mode: 0o644 });
    sk.files.forEach((f, i) => {
      const fileKey = `skillfile-${sk.name}-${i}`;
      data[fileKey] = f.content.toString("base64");
      items.push({ key: fileKey, path: `${sk.name}/${f.path}`, mode: f.executable ? 0o755 : 0o644 });
    });
  }
  return { stringData, data, items };
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

  const skillSet = await grantedSkills(agent);
  const config = await renderOpencodeConfig(agent, task.modelOverride, task.createdBy, skillSet);
  const skillEntries = skillSecretEntries(skillSet);
  const allowedHosts = await egressAllowlist(agent);
  const jobName = jobNameForTask(taskId);
  const secretName = `${jobName}-config`;
  const ccApiUrl = env.CC_INTERNAL_URL ?? env.CC_BEARER_URL;

  // The runner reaches the C2C directly over the pod network, so it must
  // bypass the proxy (Node's fetch ignores proxy env vars anyway) and the
  // NetworkPolicy has to allow it by pod selector — which only works for the
  // in-cluster URL. A public CC_BEARER_URL here would be blocked.
  const noProxy = ["localhost", "127.0.0.1", new URL(ccApiUrl).hostname].join(",");

  // Both of the pod's credentials die with it, on one clock. The slack covers
  // a runner still uploading results as the Job's deadline lands.
  const expires = Math.floor(Date.now() / 1000) + agent.timeoutSeconds + 300;

  // Scoped to this task alone: the pod shares a uid with the agent it runs, so
  // it cannot keep this from it (see runner-credential.server.ts). The shared
  // CC_BEARER_TOKEN never enters a pod.
  const runnerToken = mintRunnerToken({ taskId, expires });

  const proxyUrl = egressProxyConfigured()
    ? (() => {
        const credential = mintEgressCredential({
          hosts: allowedHosts,
          // Outliving the pod buys an attacker nothing, but a credential that
          // cannot be replayed later is free.
          expires,
        });
        const proxy = new URL(env.SANDBOX_EGRESS_PROXY);
        proxy.username = "agent";
        proxy.password = credential;
        return proxy.toString();
      })()
    : null;

  const stringData: Record<string, string> = {
    "config.json": JSON.stringify(config),
    "cc-runner-token": runnerToken,
    ...(proxyUrl ? { "egress-proxy-url": proxyUrl } : {}),
    ...skillEntries.stringData,
  };
  const secretBytes =
    Object.values(stringData).reduce((n, v) => n + Buffer.byteLength(v), 0) +
    Object.values(skillEntries.data).reduce((n, v) => n + Buffer.from(v, "base64").length, 0);
  if (secretBytes > MAX_SECRET_BYTES) {
    throw new Error(
      `agent "${agent.name}" carries ${Math.round(secretBytes / 1024)} KiB of config and skills, ` +
        `over the ${MAX_SECRET_BYTES / 1024} KiB a task can take; grant it fewer skills or ` +
        `trim their files`,
    );
  }

  await coreApi().createNamespacedSecret({
    namespace: NAMESPACE,
    body: {
      metadata: {
        name: secretName,
        labels: { app: "opencode-agent", "task-id": taskId },
      },
      stringData,
      ...(Object.keys(skillEntries.data).length > 0 ? { data: skillEntries.data } : {}),
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
                    name: "CC_RUNNER_TOKEN",
                    valueFrom: {
                      secretKeyRef: { name: secretName, key: "cc-runner-token" },
                    },
                  },
                  { name: "OPENCODE_CONFIG", value: "/etc/opencode/config.json" },
                  { name: "TASK_TIMEOUT_SECONDS", value: String(agent.timeoutSeconds) },
                  // opencode honors these for its provider, MCP and registry
                  // calls; the NetworkPolicy is what makes them mandatory
                  // rather than advisory, since anything bypassing the proxy
                  // (a raw socket from the bash tool) simply cannot connect.
                  ...(proxyUrl
                    ? [
                        ...["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].map((name) => ({
                          name,
                          valueFrom: {
                            secretKeyRef: { name: secretName, key: "egress-proxy-url" },
                          },
                        })),
                        { name: "NO_PROXY", value: noProxy },
                        { name: "no_proxy", value: noProxy },
                      ]
                    : []),
                ],
                volumeMounts: [
                  { name: "opencode-config", mountPath: "/etc/opencode", readOnly: true },
                  ...(skillEntries.items.length > 0
                    ? [{ name: "skills", mountPath: SKILLS_DIR, readOnly: true }]
                    : []),
                ],
                resources: {
                  requests: { cpu: "250m", memory: "512Mi" },
                  limits: { cpu: "2", memory: "2Gi" },
                },
              },
            ],
            volumes: [
              { name: "opencode-config", secret: { secretName } },
              // The same Secret, projected into the layout opencode discovers.
              // Only added when there are skills: an empty items list would
              // project every key instead.
              ...(skillEntries.items.length > 0
                ? [{ name: "skills", secret: { secretName, items: skillEntries.items } }]
                : []),
            ],
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

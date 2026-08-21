import { and, eq } from "drizzle-orm";
import { db } from "./db.server";
import {
  agentMcpServers,
  mcpServers,
  providers,
  userProviderKeys,
  type AgentDefinition,
  type Provider,
} from "./schema.server";

/**
 * Provider referenced by a "<provider>/<modelID>" model string, with the
 * model ID checked against that provider's catalog. Models come and go as the
 * VT endpoint rotates them; catching a retired one here turns what would be
 * an opaque provider error inside the pod into a rejection at task creation.
 */
export async function providerForModel(model: string): Promise<Provider> {
  const slash = model.indexOf("/");
  const providerName = slash === -1 ? model : model.slice(0, slash);
  const modelId = slash === -1 ? "" : model.slice(slash + 1);
  const provider = await db.query.providers.findFirst({
    where: eq(providers.name, providerName),
  });
  if (!provider || !provider.enabled) {
    throw new Error(`model "${model}" references unknown or disabled provider "${providerName}"`);
  }
  if (!provider.models.some((m) => m.id === modelId)) {
    const known = provider.models.map((m) => m.id).join(", ") || "(none configured)";
    throw new Error(
      `provider "${providerName}" offers no model "${modelId}". Available: ${known}`,
    );
  }
  return provider;
}

/**
 * API keys are strictly per user — there is no shared key. Every task runs
 * on behalf of a user, with that user's key.
 */
export async function resolveApiKey(
  provider: Provider,
  userId?: number | null,
): Promise<string> {
  if (userId == null) {
    throw new Error(
      `Tasks must run on behalf of a user (API keys are per user); external triggers must specify "user".`,
    );
  }
  const row = await db.query.userProviderKeys.findFirst({
    where: and(
      eq(userProviderKeys.userId, userId),
      eq(userProviderKeys.providerId, provider.id),
    ),
  });
  if (row?.apiKey) return row.apiKey;
  throw new Error(
    `No API key for provider "${provider.name}" — add yours under "API Keys" and try again.`,
  );
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Reachable by every agent, regardless of what it was granted. The Python
 * package index is here because agents are expected to write and run Python,
 * and the image cannot pre-install every library a task might want; pip pulls
 * the index from pypi.org and the wheels themselves from files.pythonhosted.org.
 *
 * This widens what code can enter a pod, but not what a pod can reach: an
 * installed package is still confined to the same allowlist as everything else.
 */
const BASE_EGRESS_HOSTS = ["pypi.org", "files.pythonhosted.org"];

/**
 * Hostnames this agent's pod may reach through the egress proxy. Everything
 * not listed is refused at CONNECT time; the C2C itself is not here because
 * the runner reaches it directly over the pod network (NO_PROXY), which the
 * NetworkPolicy allows by pod selector.
 *
 * MCP servers are the per-agent part and the part that matters — they are the
 * data the agent can touch, so an agent only gets the ones it was granted.
 * Provider hosts are the union across enabled providers rather than just this
 * agent's own, because a task may override the model onto another provider;
 * they are all LLM endpoints, so the union costs little.
 */
export async function egressAllowlist(agent: AgentDefinition): Promise<string[]> {
  const providerRows = await db
    .select({ baseUrl: providers.baseUrl })
    .from(providers)
    .where(eq(providers.enabled, true));

  const mcpRows = await db
    .select({ url: mcpServers.url, enabled: mcpServers.enabled })
    .from(agentMcpServers)
    .innerJoin(mcpServers, eq(agentMcpServers.mcpServerId, mcpServers.id))
    .where(eq(agentMcpServers.agentDefinitionId, agent.id));

  const hosts = [
    ...BASE_EGRESS_HOSTS,
    ...providerRows.map((p) => hostOf(p.baseUrl)),
    ...mcpRows.filter((m) => m.enabled).map((m) => hostOf(m.url)),
    ...agent.egressExtraHosts.map((h) => h.trim().toLowerCase()),
  ];
  return [...new Set(hosts.filter((h): h is string => Boolean(h)))].sort();
}

/**
 * Tools an agent may never use. webfetch/websearch are the network-egress
 * tools (the pod's egress allowlist is the real boundary, this just stops the
 * model trying); "question" would block on a human who does not exist in a
 * one-shot pod.
 */
export const DENIED_TOOLS = ["webfetch", "websearch", "question"] as const;

/** opencode's HOME inside the sandbox image; must match sandbox/Dockerfile. */
const AGENT_HOME = "/home/agent";

/**
 * Every permission key opencode 1.18 knows, spelled out.
 *
 * Leaving a key unset does NOT mean "allow": opencode ships built-in "ask"
 * rules — `doom_loop`, `external_directory`, and `read` on `*.env` /
 * `*.env.*` — and an unanswered "ask" stalls the tool call until the pod hits
 * its deadline. Pinning every key keeps the mounted config the complete
 * policy instead of a delta over defaults that shift between releases.
 * `GET /agent` on a running server prints the resolved ruleset; the sandbox
 * smoke test asserts against it.
 */
function renderPermissions(configured: Record<string, string>): Record<string, unknown> {
  // Admin-configurable, "allow" | "deny" (see agent_definitions.permissions).
  const read = configured.read ?? "allow";
  const edit = configured.edit ?? "allow";
  const bash = configured.bash ?? "allow";

  return {
    // A bare "allow" loses to opencode's more specific built-in `*.env` rules,
    // so an allow has to be spelled as a pattern map to outrank them.
    read: read === "allow" ? { "*": "allow", "*.env": "allow", "*.env.*": "allow" } : read,
    edit,
    bash,
    // Read-only inspection of the workspace; these ride with read.
    glob: read,
    grep: read,
    list: read,
    lsp: read,
    // Subagents are allowed and inherit this same policy via the root block.
    task: "allow",
    skill: "allow",
    todowrite: "allow",
    // Confine the agent to its workspace, while preserving the two paths
    // opencode itself needs (it writes large tool results out of band).
    external_directory: {
      "*": "deny",
      [`${AGENT_HOME}/.local/share/opencode/tool-output/*`]: "allow",
      "/tmp/opencode/*": "allow",
    },
    // Defaults to "ask" upstream, which would hang the pod.
    doom_loop: "deny",
    ...Object.fromEntries(DENIED_TOOLS.map((t) => [t, "deny"])),
  };
}

/**
 * Render the opencode.json for one task from an agent definition, its
 * allowed MCP servers, and the provider referenced by the model string
 * ("<provider>/<modelID>"), using the requesting user's API key. The result
 * is mounted into the sandbox pod and pointed to by OPENCODE_CONFIG.
 */
export async function renderOpencodeConfig(
  agent: AgentDefinition,
  modelOverride?: string | null,
  userId?: number | null,
): Promise<Record<string, unknown>> {
  const model = modelOverride ?? agent.model;
  const provider = await providerForModel(model);
  const apiKey = await resolveApiKey(provider, userId);

  const mcpRows = await db
    .select({
      name: mcpServers.name,
      url: mcpServers.url,
      headers: mcpServers.headers,
      enabled: mcpServers.enabled,
    })
    .from(agentMcpServers)
    .innerJoin(mcpServers, eq(agentMcpServers.mcpServerId, mcpServers.id))
    .where(eq(agentMcpServers.agentDefinitionId, agent.id));

  const mcp: Record<string, unknown> = {};
  for (const row of mcpRows) {
    if (!row.enabled) continue;
    mcp[row.name] = {
      type: "remote",
      url: row.url,
      ...(row.headers && Object.keys(row.headers).length > 0 ? { headers: row.headers } : {}),
    };
  }

  const models: Record<string, unknown> = {};
  for (const m of provider.models) {
    models[m.id] = {
      name: m.name,
      // opencode requires context/output limits on every model.
      limit: {
        context: m.contextLimit ?? 131072,
        output: m.outputLimit ?? 16384,
      },
    };
  }

  const permission = renderPermissions(agent.permissions);

  return {
    $schema: "https://opencode.ai/config.json",
    default_agent: agent.name,
    model,
    provider: {
      [provider.name]: {
        name: provider.displayName ?? provider.name,
        npm: provider.npm,
        options: {
          apiKey,
          baseURL: provider.baseUrl,
        },
        models,
      },
    },
    ...(Object.keys(mcp).length > 0 ? { mcp } : {}),
    // Drop the tools we never permit from the model's tool list entirely, so
    // it doesn't burn turns calling something that can only be refused.
    tools: Object.fromEntries(DENIED_TOOLS.map((t) => [t, false])),
    // A denied tool call should surface to the model as an error it can work
    // around, not end the run.
    experimental: { continue_loop_on_deny: true },
    // Root scope covers every agent, including opencode's built-in subagents
    // ("general", "explore"), whose own defaults would otherwise apply — they
    // ship with bash/webfetch/websearch allowed. Resolution order is
    // built-in defaults -> native agent defaults -> root -> per-agent, so
    // this beats the natives while the block below still wins for our agent.
    permission,
    agent: {
      [agent.name]: {
        mode: "primary",
        prompt: agent.systemPrompt,
        permission,
      },
    },
  };
}

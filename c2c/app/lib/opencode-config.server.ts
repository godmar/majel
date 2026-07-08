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

/** Provider referenced by a "<provider>/<modelID>" model string. */
export async function providerForModel(model: string): Promise<Provider> {
  const [providerName] = model.split("/", 1);
  const provider = await db.query.providers.findFirst({
    where: eq(providers.name, providerName),
  });
  if (!provider || !provider.enabled) {
    throw new Error(`model "${model}" references unknown or disabled provider "${providerName}"`);
  }
  return provider;
}

/**
 * API keys are per user: the requesting user's key wins; the provider's
 * default key (if set) covers API-triggered tasks and users without one.
 */
export async function resolveApiKey(
  provider: Provider,
  userId?: number | null,
): Promise<string> {
  if (userId != null) {
    const row = await db.query.userProviderKeys.findFirst({
      where: and(
        eq(userProviderKeys.userId, userId),
        eq(userProviderKeys.providerId, provider.id),
      ),
    });
    if (row?.apiKey) return row.apiKey;
  }
  if (provider.apiKey) return provider.apiKey;
  throw new Error(
    userId != null
      ? `No API key for provider "${provider.name}" — add yours under "API Keys" and try again.`
      : `Provider "${provider.name}" has no default API key configured.`,
  );
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
    agent: {
      [agent.name]: {
        mode: "primary",
        prompt: agent.systemPrompt,
        permission: agent.permissions,
      },
    },
  };
}

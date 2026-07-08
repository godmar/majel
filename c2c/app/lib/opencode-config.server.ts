import { eq } from "drizzle-orm";
import { db } from "./db.server";
import {
  agentMcpServers,
  mcpServers,
  providers,
  type AgentDefinition,
} from "./schema.server";

/**
 * Render the opencode.json for one task from an agent definition, its
 * allowed MCP servers, and the provider referenced by the model string
 * ("<provider>/<modelID>"). The result is mounted into the sandbox pod and
 * pointed to by OPENCODE_CONFIG.
 */
export async function renderOpencodeConfig(
  agent: AgentDefinition,
  modelOverride?: string | null,
): Promise<Record<string, unknown>> {
  const model = modelOverride ?? agent.model;
  const [providerName] = model.split("/", 1);

  const provider = await db.query.providers.findFirst({
    where: eq(providers.name, providerName),
  });
  if (!provider || !provider.enabled) {
    throw new Error(`model "${model}" references unknown or disabled provider "${providerName}"`);
  }

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
          apiKey: provider.apiKey,
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

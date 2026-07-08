/**
 * Idempotent seed: bootstraps the LLM provider, MCP servers, and the Majel
 * agent definition from opencode-master-config/opencode.jsonc (gitignored,
 * contains credentials) when that file is present; otherwise falls back to
 * LLM_API_BASE_URL / LLM_API_KEY from the environment.
 *
 * Run with: npm run db:seed
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../app/lib/db.server";
import { env } from "../app/lib/env.server";
import {
  agentDefinitions,
  agentMcpServers,
  mcpServers,
  providers,
  type ProviderModel,
} from "../app/lib/schema.server";

interface MasterConfig {
  default_agent?: string;
  model?: string;
  provider?: Record<
    string,
    {
      name?: string;
      npm?: string;
      options?: { apiKey?: string; baseURL?: string };
      models?: Record<string, { name?: string; limit?: { context?: number; output?: number } }>;
    }
  >;
  mcp?: Record<string, { type?: string; url?: string; headers?: Record<string, string> }>;
  agent?: Record<string, { mode?: string; prompt?: string; permission?: Record<string, string> }>;
}

function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function loadMasterConfig(): { config: MasterConfig; dir: string } | null {
  const dir = path.resolve(process.cwd(), "../opencode-master-config");
  const file = path.join(dir, "opencode.jsonc");
  if (!fs.existsSync(file)) return null;
  return { config: JSON.parse(stripJsonComments(fs.readFileSync(file, "utf8"))), dir };
}

async function main() {
  const master = loadMasterConfig();

  if (master?.config.provider) {
    for (const [name, p] of Object.entries(master.config.provider)) {
      const models: ProviderModel[] = Object.entries(p.models ?? {}).map(([id, m]) => ({
        id,
        name: m.name ?? id,
        contextLimit: m.limit?.context,
        outputLimit: m.limit?.output,
      }));
      const values = {
        name,
        displayName: p.name ?? name,
        npm: p.npm ?? "@ai-sdk/openai-compatible",
        baseUrl: p.options?.baseURL ?? env.LLM_API_BASE_URL,
        apiKey: p.options?.apiKey ?? env.LLM_API_KEY,
        models,
      };
      await db
        .insert(providers)
        .values(values)
        .onConflictDoUpdate({ target: providers.name, set: values });
      console.log(`provider: ${name} (${models.length} models)`);
    }
  } else if (env.LLM_API_BASE_URL && env.LLM_API_KEY) {
    await db
      .insert(providers)
      .values({
        name: "vt-openwebui",
        displayName: "VT Open WebUI",
        baseUrl: env.LLM_API_BASE_URL,
        apiKey: env.LLM_API_KEY,
        models: [],
      })
      .onConflictDoNothing();
    console.log("provider: vt-openwebui (from env, no models)");
  }

  const mcpIds = new Map<string, number>();
  for (const [name, m] of Object.entries(master?.config.mcp ?? {})) {
    if (!m.url) continue;
    const values = { name, url: m.url, headers: m.headers ?? null };
    const [row] = await db
      .insert(mcpServers)
      .values(values)
      .onConflictDoUpdate({ target: mcpServers.name, set: values })
      .returning();
    mcpIds.set(name, row.id);
    console.log(`mcp server: ${name}`);
  }

  for (const [name, a] of Object.entries(master?.config.agent ?? {})) {
    if (a.mode && a.mode !== "primary") continue;
    let prompt = a.prompt ?? "";
    const fileRef = prompt.match(/^\{file:(.+)\}$/);
    if (fileRef && master) {
      prompt = fs.readFileSync(path.resolve(master.dir, fileRef[1]), "utf8").trim();
    }
    const values = {
      name,
      description: "Seeded from opencode-master-config",
      systemPrompt: prompt,
      model: master?.config.model ?? "vt-openwebui/GLM-5.2",
      permissions: a.permission ?? { edit: "allow", bash: "allow" },
    };
    const [agent] = await db
      .insert(agentDefinitions)
      .values(values)
      .onConflictDoUpdate({ target: agentDefinitions.name, set: values })
      .returning();
    console.log(`agent: ${name}`);

    await db.delete(agentMcpServers).where(eq(agentMcpServers.agentDefinitionId, agent.id));
    for (const id of mcpIds.values()) {
      await db.insert(agentMcpServers).values({ agentDefinitionId: agent.id, mcpServerId: id });
    }
  }

  console.log("seed complete");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

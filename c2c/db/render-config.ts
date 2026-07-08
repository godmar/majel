/**
 * Debug tool: print the opencode.json that would be generated for an agent.
 * Usage: npx tsx db/render-config.ts [agent-name]   (default: Majel)
 */
import { eq } from "drizzle-orm";
import { db } from "../app/lib/db.server";
import { renderOpencodeConfig } from "../app/lib/opencode-config.server";
import { agentDefinitions } from "../app/lib/schema.server";

const name = process.argv[2] ?? "Majel";
const agent = await db.query.agentDefinitions.findFirst({
  where: eq(agentDefinitions.name, name),
});
if (!agent) {
  console.error(`agent "${name}" not found`);
  process.exit(1);
}
console.log(JSON.stringify(await renderOpencodeConfig(agent), null, 2));
process.exit(0);

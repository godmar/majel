import path from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { env } from "./env.server";
import * as schema from "./schema.server";

declare global {
  var __db: NodePgDatabase<typeof schema> | undefined;
  var __dbMigrated: Promise<void> | undefined;
}

function createDb() {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
  return drizzle(pool, { schema });
}

// Reuse across dev-server HMR reloads; migrate exactly once per process.
export const db = (globalThis.__db ??= createDb());

globalThis.__dbMigrated ??= migrate(db, {
  migrationsFolder: path.resolve(process.cwd(), "db/migrations"),
}).then(() => {
  console.log("database migrations applied");
});

await globalThis.__dbMigrated;

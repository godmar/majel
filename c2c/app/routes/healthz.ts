import { sql } from "drizzle-orm";
import { db } from "~/lib/db.server";

/** Liveness/readiness probe: verifies the database is reachable. */
export async function loader() {
  await db.execute(sql`select 1`);
  return new Response("ok", { headers: { "Content-Type": "text/plain" } });
}

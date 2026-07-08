import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { redirect } from "react-router";
import { db } from "./db.server";
import { adminAccounts, env, isProduction } from "./env.server";
import { users, type User } from "./schema.server";
import { getSession } from "./session.server";

/** Load the logged-in user, re-checking role/enabled against the database. */
export async function getUser(request: Request): Promise<User | null> {
  const session = await getSession(request.headers.get("Cookie"));
  const userId = session.get("userId");
  if (userId === undefined) return null;
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || !user.enabled) return null;
  return user;
}

export async function requireUser(request: Request): Promise<User> {
  const user = await getUser(request);
  if (!user) {
    const url = new URL(request.url);
    throw redirect(`/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`);
  }
  return user;
}

export async function requireAdmin(request: Request): Promise<User> {
  const user = await requireUser(request);
  if (user.role !== "admin") {
    throw new Response("Forbidden", { status: 403 });
  }
  return user;
}

/** Guard for the machine API: constant-time bearer token comparison. */
export function requireBearer(request: Request): void {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const expected = Buffer.from(env.CC_BEARER_TOKEN);
  const actual = Buffer.from(token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Response("Unauthorized", { status: 401 });
  }
}

/**
 * Look up (and on first login, provision) the local account for a
 * CAS-authenticated username. Accounts listed in ADMIN_ACCOUNTS are
 * auto-created as admins; everyone else must have been added by an admin.
 */
export async function resolveAccount(username: string): Promise<User | null> {
  const existing = await db.query.users.findFirst({ where: eq(users.username, username) });

  if (adminAccounts.includes(username)) {
    if (existing) {
      if (existing.role !== "admin" || !existing.enabled) {
        const [updated] = await db
          .update(users)
          .set({ role: "admin", enabled: true })
          .where(eq(users.id, existing.id))
          .returning();
        return updated;
      }
      return existing;
    }
    const [created] = await db
      .insert(users)
      .values({ username, role: "admin" })
      .returning();
    return created;
  }

  if (!existing || !existing.enabled) return null;
  return existing;
}

export async function recordLogin(userId: number): Promise<void> {
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
}

/**
 * Dev-only CAS bypass: log in as DEV_FAKE_USER, creating the account if
 * needed. Never active in production builds.
 */
export async function devLoginUser(): Promise<User | null> {
  if (isProduction || !env.DEV_FAKE_USER) return null;
  const username = env.DEV_FAKE_USER.toLowerCase();
  const account = await resolveAccount(username);
  if (account) return account;
  const [created] = await db
    .insert(users)
    .values({ username })
    .onConflictDoUpdate({ target: users.username, set: { enabled: true } })
    .returning();
  return created;
}

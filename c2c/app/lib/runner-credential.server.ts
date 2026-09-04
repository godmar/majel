import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env.server";

/**
 * Callback credential for a sandbox pod.
 *
 * The runner has to reach the C2C to fetch its prompt and report back, so the
 * pod must carry a credential — and it cannot keep that credential from the
 * agent it supervises. Both run in one container as one uid (sandbox/Dockerfile
 * runs everything as `agent`), so anything in the runner's environment is one
 * `env` away for the agent's bash, and one `cat /proc/1/environ` away even
 * when the child's environment is scrubbed: /proc reports the exec-time block,
 * which unsetting the variable in-process does not rewrite.
 *
 * So the credential is built to be worthless once it leaks. It names a single
 * task, expires with the pod, and authorizes only the /api/runner routes for
 * that one task — every one of which the agent already drives anyway. The
 * shared CC_BEARER_TOKEN, which opens every task and every user's files, has
 * no reason to enter a pod and no longer does.
 *
 * Same shape as the egress credential (see egress.server.ts): a signed,
 * self-describing grant, so verifying it needs no database lookup and no
 * stored state.
 */

export interface RunnerGrant {
  /** The one task whose /api/runner routes this credential opens. */
  taskId: string;
  /** Unix seconds after which the C2C refuses it. */
  expires: number;
}

/**
 * Derived from SESSION_SECRET rather than configured on its own, so no new
 * secret has to be distributed to deploy this. Grants live minutes, so the key
 * needs no rotation schedule of its own; and anyone holding SESSION_SECRET can
 * already forge an admin session, which is strictly worse than forging a grant
 * for one task. The label keeps this key distinct from other uses of that
 * secret.
 */
const SIGNING_KEY = createHmac("sha256", env.SESSION_SECRET)
  .update("runner-credential-v1")
  .digest();

function sign(payload: string): string {
  return createHmac("sha256", SIGNING_KEY).update(payload).digest("base64url");
}

/** Encode and sign a grant into the token the pod carries. */
export function mintRunnerToken(grant: RunnerGrant): string {
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify a runner token and return its grant, or null if the signature does
 * not check out or the payload is malformed. Expiry and task binding are the
 * caller's to enforce — see requireRunner() in auth.server.ts.
 */
export function verifyRunnerToken(token: string): RunnerGrant | null {
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;

  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const grant = JSON.parse(Buffer.from(payload, "base64url").toString()) as RunnerGrant;
    if (typeof grant.taskId !== "string" || typeof grant.expires !== "number") return null;
    return grant;
  } catch {
    return null;
  }
}

/** The token from an `Authorization: Bearer ...` header, or "". */
export function bearerToken(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

/**
 * Guard for the runner API (/api/runner/tasks/:taskId/...): the caller must
 * present an unexpired grant for exactly the task named in the path. A pod
 * cannot hide this token from its own agent, so the binding is what limits the
 * damage — a leaked grant writes to the task that agent is already running,
 * and to no other.
 */
export function requireRunner(request: Request, taskId: string | undefined): void {
  const grant = verifyRunnerToken(bearerToken(request));
  if (!grant || grant.taskId !== taskId || grant.expires < Date.now() / 1000) {
    throw new Response("Unauthorized", { status: 401 });
  }
}

import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "./env.server";

/**
 * Proxy credentials for a sandbox pod.
 *
 * The pod's egress allowlist travels with it, inside its proxy password,
 * signed so the pod cannot widen it. That keeps the proxy stateless: it needs
 * only the shared signing key, never a lookup against the C2C or a synced
 * Secret, so egress does not break when the C2C is down or mid-rollout.
 *
 * The credential is not secret — it grants exactly what the agent is already
 * allowed to reach — so having it in the pod's environment is fine.
 */

export interface EgressGrant {
  /** Hostnames the pod may CONNECT to. */
  hosts: string[];
  /** Unix seconds after which the proxy refuses the credential. */
  expires: number;
}

function sign(payload: string): string {
  return createHmac("sha256", env.SANDBOX_EGRESS_SIGNING_KEY).update(payload).digest("base64url");
}

/** Encode and sign a grant into a proxy password. */
export function mintEgressCredential(grant: EgressGrant): string {
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify a proxy password and return its grant, or null if the signature does
 * not check out or the payload is malformed. Exported so the proxy's tests
 * and the C2C agree on one implementation; the proxy image carries its own
 * copy of this logic since it deploys separately.
 */
export function verifyEgressCredential(credential: string): EgressGrant | null {
  const [payload, mac] = credential.split(".");
  if (!payload || !mac) return null;

  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const grant = JSON.parse(Buffer.from(payload, "base64url").toString()) as EgressGrant;
    if (!Array.isArray(grant.hosts) || typeof grant.expires !== "number") return null;
    return grant;
  } catch {
    return null;
  }
}

/** True when the deployment is configured to route agent egress through a proxy. */
export function egressProxyConfigured(): boolean {
  return Boolean(env.SANDBOX_EGRESS_PROXY && env.SANDBOX_EGRESS_SIGNING_KEY);
}

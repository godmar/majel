import { XMLParser } from "fast-xml-parser";
import { env } from "./env.server";

export interface CasResult {
  ok: boolean;
  username?: string;
  attributes?: Record<string, unknown>;
  error?: string;
}

export function casLoginUrl(): string {
  return `${env.CAS_LOGIN_URL}?service=${encodeURIComponent(env.CAS_SERVICE_URL)}`;
}

/**
 * Validate a CAS v2 service ticket against the CAS server. The `service`
 * parameter must be byte-identical to the one used at login time, so both
 * are always built from CAS_SERVICE_URL.
 */
export async function validateCasTicket(ticket: string): Promise<CasResult> {
  const url = `${env.CAS_SERVICE_VALIDATE_URL}?ticket=${encodeURIComponent(
    ticket,
  )}&service=${encodeURIComponent(env.CAS_SERVICE_URL)}`;

  const res = await fetch(url);
  if (!res.ok) {
    return { ok: false, error: `CAS validation request failed: HTTP ${res.status}` };
  }

  const xml = await res.text();
  const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false });
  const parsed = parser.parse(xml);
  const response = parsed?.serviceResponse;

  const success = response?.authenticationSuccess;
  if (success?.user) {
    return {
      ok: true,
      username: String(success.user).toLowerCase(),
      attributes: success.attributes,
    };
  }

  const failure = response?.authenticationFailure;
  const code = failure?.["@_code"] ?? "UNKNOWN";
  const message = typeof failure === "object" ? failure?.["#text"] : failure;
  return { ok: false, error: `CAS authentication failed (${code}): ${message ?? ""}`.trim() };
}

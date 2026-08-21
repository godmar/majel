/**
 * Egress allowlist proxy for sandbox agent pods.
 *
 * Agent pods have no direct route off the cluster (NetworkPolicy allows only
 * kube-dns, the C2C, and this proxy), so every outbound connection arrives
 * here as a CONNECT and is tunneled only if its hostname is on the calling
 * pod's allowlist.
 *
 * The allowlist is not held here: it arrives inside the pod's proxy password,
 * HMAC-signed by the C2C, so this stays stateless and keeps working when the
 * C2C is down. See c2c/app/lib/egress.server.ts for the minting side — the
 * two must agree on the format.
 *
 * Matching is on the CONNECT hostname, and resolution happens per connection,
 * so allowlisted hosts can renumber freely without touching any config.
 *
 * Environment:
 *   EGRESS_SIGNING_KEY  shared HMAC key (required)
 *   PORT                listen port (default 3128)
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import net from "node:net";

const PORT = Number(process.env.PORT ?? 3128);
const SIGNING_KEY = process.env.EGRESS_SIGNING_KEY;
if (!SIGNING_KEY) {
  console.error("EGRESS_SIGNING_KEY is required");
  process.exit(2);
}

/** Only TLS. Everything an agent legitimately reaches is HTTPS, and refusing
 *  plaintext keeps the tunnel the one audited path out. */
const ALLOWED_PORTS = new Set([443]);

function log(fields) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...fields }));
}

function verify(credential) {
  const [payload, mac] = (credential ?? "").split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(createHmac("sha256", SIGNING_KEY).update(payload).digest("base64url"));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const grant = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!Array.isArray(grant.hosts) || typeof grant.expires !== "number") return null;
    return grant;
  } catch {
    return null;
  }
}

/** Grant from the Proxy-Authorization header, or null. */
function grantFor(req) {
  const header = req.headers["proxy-authorization"] ?? "";
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !value) return null;
  const decoded = Buffer.from(value, "base64").toString();
  return verify(decoded.slice(decoded.indexOf(":") + 1));
}

/** A leading "." matches subdomains; anything else is an exact hostname. */
function permitted(grant, host) {
  const h = host.toLowerCase();
  return grant.hosts.some((rule) => {
    const r = String(rule).toLowerCase();
    return r.startsWith(".") ? h.endsWith(r) : h === r;
  });
}

const server = http.createServer((req, res) => {
  log({ verdict: "deny", reason: "plain-http", url: req.url });
  res.writeHead(403, { "Content-Type": "text/plain" });
  res.end("egress proxy: only HTTPS via CONNECT is permitted\n");
});

server.on("connect", (req, clientSocket, head) => {
  // Register before any refusal: a client that gives up on a rejected CONNECT
  // resets the socket, and an unhandled 'error' would take the proxy down.
  clientSocket.on("error", () => clientSocket.destroy());

  const separator = req.url.lastIndexOf(":");
  // Refusals echo the host back in a status line, so strip anything that could
  // break out of it into a header of the attacker's choosing.
  const host = req.url.slice(0, separator).replace(/[^\w.:\[\]-]/g, "");
  const port = Number(req.url.slice(separator + 1));

  // A bare "403" told the agent nothing, so a blocked host looked like a bug in
  // whatever it was calling. Both the reason phrase and the body explain the
  // refusal: python's http.client surfaces the phrase verbatim ("Tunnel
  // connection failed: 403 ..."), and curl -v prints the body.
  const refuse = (reason, detail, code = 403, phrase = "Forbidden") => {
    log({ verdict: "deny", reason, host, port });
    const body = `egress proxy: ${detail}\n`;
    clientSocket.end(
      [
        `HTTP/1.1 ${code} ${phrase} - ${detail}`,
        "Content-Type: text/plain",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: close",
        "",
        body,
      ].join("\r\n"),
    );
  };

  const grant = grantFor(req);
  if (!grant) {
    return refuse(
      "bad-credential",
      "missing or invalid proxy credential",
      407,
      "Proxy Authentication Required",
    );
  }
  if (grant.expires < Date.now() / 1000) {
    return refuse("expired", "this pod's egress credential has expired");
  }
  if (!ALLOWED_PORTS.has(port)) {
    return refuse("port", `only port 443 is permitted, not ${port}`);
  }
  if (!permitted(grant, host)) {
    return refuse(
      "not-allowlisted",
      `${host} is not on this agent's egress allowlist (allowed: ${grant.hosts.join(", ")}). ` +
        `Reach it through an MCP tool, or have an admin add it to the agent's extra hosts.`,
    );
  }

  const upstream = net.connect(port, host, () => {
    log({ verdict: "allow", host, port });
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", (err) => {
    log({ verdict: "upstream-error", host, port, error: err.message });
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  clientSocket.on("close", () => upstream.destroy());
});

server.listen(PORT, "0.0.0.0", () => log({ event: "listening", port: PORT }));

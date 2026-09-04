// In-memory stand-in for the C2C runner API, used to smoke-test the sandbox
// image (and thus a new opencode version) without the full stack.
//
// Serves one task, records everything the runner reports, and exposes
// GET /verdict which returns 200 only if the run exercised the whole
// contract: events, live transcript sync with a tool call, an uploaded
// output file, and a successful result with text.
import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8092);
const TASK_ID = process.env.TASK_ID ?? "00000000-smoke-test";
// Must match the key smoke.sh mints with; the real key is derived from
// SESSION_SECRET (see c2c/app/lib/runner-credential.server.ts).
const SIGNING_KEY = process.env.RUNNER_SIGNING_KEY ?? "smoke-test-signing-key";

const state = {
  events: [],
  transcriptSyncs: 0,
  lastTranscript: null,
  files: [],
  result: null,
  authFailures: 0,
  wrongTaskAccepted: false,
};

/**
 * The same check the C2C makes: a valid signature over an unexpired grant
 * naming this task. Mirrors requireRunner() in c2c/app/lib/runner-credential.server.ts —
 * a runner that sends the shared token, or a grant for another task, must
 * come back 401 here just as it would in production.
 */
function grantFor(header) {
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(
    createHmac("sha256", SIGNING_KEY).update(payload).digest("base64url"),
  );
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const grant = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof grant.taskId !== "string" || typeof grant.expires !== "number") return null;
    if (grant.expires < Date.now() / 1000) return null;
    return grant;
  } catch {
    return null;
  }
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function verdict() {
  const checks = {
    "runner authenticated every call": state.authFailures === 0,
    "runner presented a grant scoped to this task": state.wrongTaskAccepted === false,
    "runner_started event": state.events.some((e) => e.type === "runner_started"),
    "session_created event with sessionID": state.events.some(
      (e) => e.type === "session_created" && typeof e.data?.sessionID === "string",
    ),
    "transcript synced at least once": state.transcriptSyncs > 0,
    "transcript contains a completed tool part": Boolean(
      state.lastTranscript?.some((m) =>
        m?.parts?.some((p) => p?.type === "tool" && p?.state?.status === "completed"),
      ),
    ),
    "output file uploaded": state.files.some((f) => f.filename === "result-file.txt"),
    "result ok with text": state.result?.ok === true && Boolean(state.result?.resultText),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/verdict") {
    const v = verdict();
    return json(res, v.pass ? 200 : 500, v);
  }

  // Raw record of the run, for scenarios whose expectations differ from the
  // happy-path verdict (a stalled turn that recovers, or one that does not).
  if (url.pathname === "/state") {
    return json(res, 200, {
      events: state.events.map((e) => e.type),
      result: state.result,
      files: state.files.map((f) => f.filename),
      transcriptSyncs: state.transcriptSyncs,
    });
  }

  const grant = grantFor(req.headers.authorization ?? "");
  if (!grant) {
    state.authFailures++;
    return json(res, 401, { error: "unauthorized" });
  }
  // A grant is only good for the task it names. Recorded rather than rejected
  // so the verdict can say which rule the runner broke.
  if (grant.taskId !== TASK_ID) {
    state.wrongTaskAccepted = true;
    return json(res, 401, { error: "wrong task" });
  }

  const base = `/api/runner/tasks/${TASK_ID}`;
  const body = await readBody(req);

  if (url.pathname === `${base}/input`) {
    return json(res, 200, {
      taskId: TASK_ID,
      prompt: "Create a file called result-file.txt containing a greeting.",
      agent: "SmokeTest",
      timeoutSeconds: 300,
      files: [],
    });
  }
  if (url.pathname === `${base}/events`) {
    const event = JSON.parse(body.toString());
    state.events.push(event);
    console.log(`mock-c2c: event ${event.type}`);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === `${base}/transcript`) {
    state.transcriptSyncs++;
    state.lastTranscript = JSON.parse(body.toString());
    return json(res, 200, { ok: true });
  }
  if (url.pathname === `${base}/result/files`) {
    state.files.push({
      filename: decodeURIComponent(req.headers["x-filename"] ?? ""),
      size: body.length,
    });
    console.log(`mock-c2c: file ${req.headers["x-filename"]} (${body.length} bytes)`);
    return json(res, 200, { ok: true, id: state.files.length });
  }
  if (url.pathname === `${base}/result`) {
    state.result = JSON.parse(body.toString());
    // The final result carries the transcript too; count it for the checks.
    if (Array.isArray(state.result.transcript)) {
      state.lastTranscript = state.result.transcript;
      state.transcriptSyncs++;
    }
    console.log(`mock-c2c: result ok=${state.result.ok}`);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: `unexpected path ${url.pathname}` });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock-c2c listening on :${PORT}`));

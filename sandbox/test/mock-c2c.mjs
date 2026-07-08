// In-memory stand-in for the C2C runner API, used to smoke-test the sandbox
// image (and thus a new opencode version) without the full stack.
//
// Serves one task, records everything the runner reports, and exposes
// GET /verdict which returns 200 only if the run exercised the whole
// contract: events, live transcript sync with a tool call, an uploaded
// output file, and a successful result with text.
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8092);
const TOKEN = process.env.CC_BEARER_TOKEN ?? "smoke-test-token";
const TASK_ID = process.env.TASK_ID ?? "00000000-smoke-test";

const state = {
  events: [],
  transcriptSyncs: 0,
  lastTranscript: null,
  files: [],
  result: null,
  authFailures: 0,
};

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

  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${TOKEN}`) {
    state.authFailures++;
    return json(res, 401, { error: "unauthorized" });
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

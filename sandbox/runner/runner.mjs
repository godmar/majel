/**
 * Sandbox runner: drives one opencode session for one task, reporting
 * progress and results back to the C2C server.
 *
 * Environment:
 *   TASK_ID          task UUID
 *   CC_API_URL       base URL of the C2C server (in-cluster service)
 *   CC_RUNNER_TOKEN  per-task credential for this task's C2C runner API
 *   OPENCODE_CONFIG  path to the rendered opencode.json (mounted secret)
 *   TASK_TIMEOUT_SECONDS  optional wall-clock budget (default 1800)
 *
 * Flow: fetch input -> write files -> snapshot workspace -> start
 * `opencode serve` -> create session -> prompt (async) -> live transcript
 * sync while waiting for idle -> collect result text + new/changed files ->
 * upload -> exit.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const TASK_ID = requireEnv("TASK_ID");
const CC_API_URL = requireEnv("CC_API_URL").replace(/\/$/, "");
const CC_RUNNER_TOKEN = requireEnv("CC_RUNNER_TOKEN");
const WORKSPACE = process.env.WORKSPACE ?? "/workspace";
const OC_PORT = Number(process.env.OPENCODE_PORT ?? 4096);
const OC_URL = `http://127.0.0.1:${OC_PORT}`;
const TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_SECONDS ?? 1800) * 1000;

const MAX_FILE_BYTES = 25 * 1024 * 1024;

// A turn that completes having produced nothing is the provider dropping the
// request, not the agent finishing. Observed twice in production as ~181s
// with zero tokens in and out and finish "unknown", both times immediately
// after an unusually long turn. The session history survives it, so nudging
// the agent to continue recovers the run; only a second empty turn is fatal.
const MAX_STALL_RETRIES = 1;
const STALL_RETRY_DELAY_MS = 5000;
const STALL_RETRY_PROMPT =
  "Your previous response came back empty. That was a transport failure, not " +
  "anything you did wrong. Continue the task from where you left off — do not " +
  "start over, and do not repeat work you have already done.";
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "__pycache__", ".opencode", ".cache"]);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env var ${name}`);
    process.exit(2);
  }
  return v;
}

/** fetch against this task's C2C runner API with auth and retries. */
async function cc(pathname, { method = "GET", json, body, headers = {}, retries = 5 } = {}) {
  const url = `${CC_API_URL}${pathname}`;
  const opts = {
    method,
    headers: { Authorization: `Bearer ${CC_RUNNER_TOKEN}`, ...headers },
  };
  if (json !== undefined) {
    opts.body = JSON.stringify(json);
    opts.headers["Content-Type"] = "application/json";
  } else if (body !== undefined) {
    opts.body = body;
  }
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.status >= 500) throw new Error(`HTTP ${res.status} from ${pathname}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${pathname}`), { fatal: true });
      return res;
    } catch (err) {
      lastErr = err;
      if (err.fatal || attempt === retries) break;
      await sleep(Math.min(1000 * 2 ** attempt, 15000));
    }
  }
  throw lastErr;
}

async function postEvent(type, message, data) {
  try {
    await cc(`/api/runner/tasks/${TASK_ID}/events`, { method: "POST", json: { type, message, data } });
  } catch (err) {
    console.error(`failed to post event ${type}:`, err.message);
  }
}

/** opencode server API helper (localhost, no auth). */
async function oc(pathname, { method = "GET", json, timeoutMs = 30000 } = {}) {
  const opts = { method, signal: AbortSignal.timeout(timeoutMs) };
  if (json !== undefined) {
    opts.body = JSON.stringify(json);
    opts.headers = { "Content-Type": "application/json" };
  }
  const res = await fetch(`${OC_URL}${pathname}`, opts);
  if (!res.ok) throw new Error(`opencode ${method} ${pathname}: HTTP ${res.status}`);
  return res;
}

// ---------------------------------------------------------------- workspace

function scanWorkspace() {
  const snapshot = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(full);
        snapshot.set(path.relative(WORKSPACE, full), createHash("sha256").update(content).digest("hex"));
      }
    }
  };
  walk(WORKSPACE);
  return snapshot;
}

function guessMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  return (
    {
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".csv": "text/csv",
      ".json": "application/json",
      ".html": "text/html",
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".py": "text/x-python",
      ".zip": "application/zip",
    }[ext] ?? "application/octet-stream"
  );
}

// ----------------------------------------------------------------- opencode

async function waitForServer(deadlineMs = 60000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      await oc("/global/health", { timeoutMs: 2000 });
      return;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error("opencode serve did not become healthy in time");
}

async function fetchTranscript(sessionID) {
  const res = await oc(`/session/${sessionID}/message`, { timeoutMs: 60000 });
  return res.json();
}

/**
 * Refuse anything opencode stops to ask about.
 *
 * This is a liveness guard, not the policy: policy lives in the rendered
 * opencode config, which pins every permission key to allow or deny, so a
 * correctly configured agent never gets here. What does get here is whatever
 * the policy did not anticipate — an MCP tool under a name we do not
 * enumerate, a permission key added by a future opencode. Nobody can answer
 * in a one-shot pod, and an unanswered request stalls the tool call until the
 * task hits its deadline; refusing turns a 30-minute timeout into an
 * immediate tool error the agent can work around. Each refusal is reported as
 * a task event, because it means the policy has a gap worth closing.
 */
async function rejectPendingRequests() {
  const permissions = await (await oc("/permission", { timeoutMs: 5000 })).json();
  for (const req of permissions) {
    const what = `${req.permission} ${(req.patterns ?? []).join(", ")}`.trim();
    await oc(`/permission/${req.id}/reply`, {
      method: "POST",
      json: {
        reply: "reject",
        message: `Refused by sandbox policy: "${req.permission}" is not permitted for this agent.`,
      },
    });
    console.log(`refused permission request: ${what}`);
    await postEvent("permission_refused", `Refused permission request: ${what}`, {
      permission: req.permission,
      patterns: req.patterns ?? [],
    });
  }

  // Questions are a separate API from permissions and need their own refusal;
  // the config denies the tool, so reaching this means the deny was bypassed.
  const questions = await (await oc("/question", { timeoutMs: 5000 })).json();
  for (const req of questions) {
    await oc(`/question/${req.id}/reject`, { method: "POST" });
    console.log(`refused question request ${req.id}`);
    await postEvent("question_refused", "Refused a question: tasks run unattended.");
  }
}

function extractResultText(transcript) {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const msg = transcript[i];
    if (msg?.info?.role !== "assistant") continue;
    const text = (msg.parts ?? [])
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/**
 * True when a completed turn contains nothing at all — no text, no tool call,
 * no reasoning. That is never a valid way for the agent to finish, so it must
 * not be mistaken for an answer: extractResultText would happily walk back
 * past it and report whatever the agent last said mid-thought as the result.
 */
function turnProducedNothing(msg) {
  return !(msg?.parts ?? []).some(
    (p) =>
      p?.type === "tool" ||
      ((p?.type === "text" || p?.type === "reasoning") &&
        typeof p.text === "string" &&
        p.text.trim() !== ""),
  );
}

/** Human-readable summary of an empty turn, for the failure and the event. */
function describeStall(info) {
  const { created, completed } = info?.time ?? {};
  const secs = created && completed ? `, ${Math.round((completed - created) / 1000)}s` : "";
  return `finish "${info?.finish ?? "none"}"${secs}, ${info?.tokens?.output ?? 0} output tokens`;
}

/**
 * Poll the transcript until the agent loop finishes. A turn is complete when
 * the newest message is an assistant message with time.completed set and a
 * finish reason other than "tool-calls" (which just means another step is
 * coming). The /api/session/{id}/wait endpoint is unreliable in opencode
 * 1.17.x (returns 503), so completion is derived from messages instead.
 *
 * afterLength ignores a transcript that has not yet grown past what the caller
 * already saw, so a retry cannot immediately re-read the turn it is retrying.
 */
async function waitForCompletion(sessionID, deadline, afterLength = 0) {
  while (Date.now() < deadline) {
    await sleep(2000);
    let transcript;
    try {
      transcript = await fetchTranscript(sessionID);
    } catch (err) {
      console.error("transcript poll failed:", err.message);
      continue;
    }
    if (transcript.length <= afterLength) continue;
    const info = transcript.at(-1)?.info;
    if (info?.role !== "assistant") continue;
    if (info.error) {
      throw new Error(`agent error: ${JSON.stringify(info.error).slice(0, 500)}`);
    }
    if (info.time?.completed && info.finish !== "tool-calls") {
      return transcript;
    }
  }
  throw new Error(`task exceeded time budget (${Math.round(TIMEOUT_MS / 1000)}s)`);
}

/**
 * Drive the session until it produces a real answer.
 *
 * An empty turn used to end the run silently: the runner reported success and
 * the task showed the agent's last mid-thought sentence as its result. Retry
 * it once — the history is intact, so the agent resumes where it stopped —
 * and if the retry comes back empty too, fail loudly rather than hand back a
 * plan as though it were the work.
 */
async function runToCompletion(sessionID, deadline) {
  let seen = 0;
  for (let attempt = 0; ; attempt++) {
    const transcript = await waitForCompletion(sessionID, deadline, seen);
    const last = transcript.at(-1);
    if (!turnProducedNothing(last)) return transcript;

    const detail = describeStall(last?.info);
    if (attempt >= MAX_STALL_RETRIES) {
      throw new Error(
        `the model returned an empty response and did not recover after ${attempt} ` +
          `retry: the run stopped before finishing (${detail})`,
      );
    }

    console.error(`empty response from the model (${detail}); asking the agent to continue`);
    await postEvent("turn_stalled", `Model returned an empty response (${detail}); retrying.`, {
      finish: last?.info?.finish ?? null,
      attempt: attempt + 1,
    });
    seen = transcript.length;
    await sleep(STALL_RETRY_DELAY_MS);
    await oc(`/session/${sessionID}/prompt_async`, {
      method: "POST",
      json: { parts: [{ type: "text", text: STALL_RETRY_PROMPT }] },
    });
  }
}

// --------------------------------------------------------------------- main

async function main() {
  const started = Date.now();
  const deadline = started + TIMEOUT_MS - 30000; // leave margin before K8s kills the pod

  fs.mkdirSync(WORKSPACE, { recursive: true });
  process.chdir(WORKSPACE);

  // 1. Task input
  const input = await (await cc(`/api/runner/tasks/${TASK_ID}/input`)).json();
  for (const file of input.files) {
    const safe = path.basename(file.filename);
    const bytes = Buffer.from(
      await (await cc(`/api/runner/tasks/${TASK_ID}/files/${file.id}`)).arrayBuffer(),
    );
    fs.writeFileSync(path.join(WORKSPACE, safe), bytes);
    console.log(`input file: ${safe} (${bytes.length} bytes)`);
  }

  // 2. Pre-run snapshot for output detection
  const before = scanWorkspace();

  // 3. Start opencode serve
  const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(OC_PORT)], {
    cwd: WORKSPACE,
    stdio: ["ignore", "inherit", "inherit"],
  });
  server.on("exit", (code) => console.log(`opencode serve exited with code ${code}`));
  await waitForServer();
  await postEvent("runner_started", "opencode server ready");

  // 4. Create session and send the prompt
  const session = await (await oc("/session", { method: "POST", json: { title: `task ${TASK_ID}` } })).json();
  await postEvent("session_created", `opencode session ${session.id}`, { sessionID: session.id });

  await oc(`/session/${session.id}/prompt_async`, {
    method: "POST",
    json: { parts: [{ type: "text", text: input.prompt }] },
  });
  await postEvent("prompt_sent", "Prompt submitted to agent");

  // 5. Live transcript sync (and refusal of anything opencode asks about)
  // while waiting for completion
  let syncing = true;
  const syncLoop = (async () => {
    while (syncing) {
      await sleep(3000);
      try {
        await rejectPendingRequests();
      } catch (err) {
        console.error("refusing pending requests failed:", err.message);
      }
      try {
        const transcript = await fetchTranscript(session.id);
        await cc(`/api/runner/tasks/${TASK_ID}/transcript`, {
          method: "PUT",
          json: transcript,
          retries: 0,
        });
      } catch (err) {
        console.error("transcript sync failed:", err.message);
      }
    }
  })();

  let transcript;
  try {
    transcript = await runToCompletion(session.id, deadline);
  } finally {
    syncing = false;
    await syncLoop;
  }

  // 6. Collect results
  const resultText = extractResultText(transcript);

  const after = scanWorkspace();
  const changed = [...after.entries()]
    .filter(([rel, hash]) => before.get(rel) !== hash)
    .map(([rel]) => rel);

  for (const rel of changed) {
    const full = path.join(WORKSPACE, rel);
    const size = fs.statSync(full).size;
    if (size === 0 || size > MAX_FILE_BYTES) {
      console.log(`skipping output file ${rel} (${size} bytes)`);
      continue;
    }
    try {
      await cc(`/api/runner/tasks/${TASK_ID}/result/files`, {
        method: "POST",
        body: fs.readFileSync(full),
        headers: {
          "X-Filename": encodeURIComponent(rel),
          "Content-Type": guessMime(rel),
        },
        retries: 2,
      });
      console.log(`uploaded output file: ${rel}`);
    } catch (err) {
      console.error(`failed to upload ${rel}:`, err.message);
    }
  }

  // 7. Final result
  await cc(`/api/runner/tasks/${TASK_ID}/result`, {
    method: "POST",
    json: { ok: true, resultText, transcript },
  });
  console.log(`task completed in ${Math.round((Date.now() - started) / 1000)}s`);
  server.kill();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("runner failed:", err);
  try {
    await cc(`/api/runner/tasks/${TASK_ID}/result`, {
      method: "POST",
      json: { ok: false, error: String(err?.message ?? err) },
    });
  } catch (reportErr) {
    console.error("failed to report failure:", reportErr.message);
  }
  process.exit(1);
});

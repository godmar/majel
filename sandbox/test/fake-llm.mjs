// Minimal OpenAI-compatible streaming server for sandbox smoke tests.
// Turn 1: tool call (bash writes result-file.txt). Turn 2: final text.
//
// FAKE_LLM_MODE reproduces the production failure where a provider accepts a
// request and streams nothing back, which opencode records as a completed
// turn with no parts and finish "unknown":
//   normal          every turn answers (default)
//   stall-once      the final turn is empty once, then answers -> run recovers
//   stall-always    the final turn is always empty             -> runner fails
//   stall-stop-once the final turn is empty once but says finish_reason
//                   "stop", so opencode ends its loop there    -> runner nudges
//   skill-files     load the skill in FAKE_LLM_SKILL, read and run its
//                   files, then try to load ungranted-skill    -> one call per turn
//
// FAKE_LLM_SILENCE_SECONDS holds the final turn completely silent -- no
// headers, no body -- for that long before answering normally, which is how
// a starved provider looks from the client. Set it past a suspected idle
// timeout to find out whether the client gives up, and after how long.
import fs from "node:fs";
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8091);
const MODE = process.env.FAKE_LLM_MODE ?? "normal";
const SILENCE_MS = Number(process.env.FAKE_LLM_SILENCE_SECONDS ?? 0) * 1000;
// FAKE_LLM_DUMP names a file to receive the first request that offers tools
// (opencode's session-title request does not), so a test can check what the
// model is shown -- e.g. which skills its system prompt lists.
const DUMP = process.env.FAKE_LLM_DUMP;
const SKILL = process.env.FAKE_LLM_SKILL ?? "granted-skill";
const SKILL_DIR = `/home/agent/.config/opencode/skills/${SKILL}`;
const SKILL_STEPS = [
  ["skill", { name: SKILL }],
  ["read", { filePath: `${SKILL_DIR}/scripts/hello.py` }],
  ["bash", { command: `python3 ${SKILL_DIR}/scripts/hello.py`, description: "Run the skill script" }],
  ["bash", { command: `cat ${SKILL_DIR}/reference/notes.md`, description: "Read the skill notes" }],
  ["skill", { name: "ungranted-skill" }],
];
let stalls = 0;
let dumped = false;

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = http.createServer((req, res) => {
  if (!req.url.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const payload = JSON.parse(body);
    if (DUMP && !dumped && payload.tools?.length) {
      dumped = true;
      fs.writeFileSync(DUMP, JSON.stringify(payload, null, 2));
    }
    const hasToolResult = payload.messages.some((m) => m.role === "tool");
    console.log(`fake-llm: ${payload.messages.length} messages, hasToolResult=${hasToolResult}`);

    if (SILENCE_MS > 0 && hasToolResult) {
      const t0 = Date.now();
      console.log(`fake-llm: holding the response silent for ${SILENCE_MS / 1000}s`);
      req.socket.on("close", () =>
        console.log(`fake-llm: CLIENT HUNG UP after ${((Date.now() - t0) / 1000).toFixed(1)}s`));
      await new Promise((r) => setTimeout(r, SILENCE_MS));
      if (res.writableEnded || req.socket.destroyed) {
        console.log("fake-llm: socket already gone; nothing to answer");
        return;
      }
      console.log("fake-llm: silence over, answering normally");
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const base = {
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: payload.model,
    };

    // An empty stream: headers, no chunks, no finish_reason, just [DONE]
    // (or, for stall-stop-once, nothing but a "stop").
    const stallOnce = MODE === "stall-once" || MODE === "stall-stop-once";
    if (hasToolResult && (MODE === "stall-always" || (stallOnce && stalls === 0))) {
      stalls++;
      console.log(`fake-llm: returning an empty stream (stall ${stalls}, mode ${MODE})`);
      if (MODE === "stall-stop-once") {
        sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (MODE === "skill-files") {
      const step = SKILL_STEPS[payload.messages.filter((m) => m.role === "tool").length];
      if (step) {
        const [name, args] = step;
        sse(res, {
          ...base,
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [{ index: 0, id: `call_${name}_${Date.now()}`, type: "function",
                function: { name, arguments: JSON.stringify(args) } }],
            },
            finish_reason: null,
          }],
        });
        sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] });
        sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
    } else if (!hasToolResult) {
      sse(res, {
        ...base,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{
              index: 0, id: "call_1", type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({
                  command: "echo 'hello from the sandbox agent' > result-file.txt",
                  description: "Write the result file",
                }),
              },
            }],
          },
          finish_reason: null,
        }],
      });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      sse(res, {
        ...base,
        choices: [{ index: 0, delta: { role: "assistant", content: "Done. I created result-file.txt." }, finish_reason: null }],
      });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`fake-llm listening on :${PORT}`));

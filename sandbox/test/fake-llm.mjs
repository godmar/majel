// Minimal OpenAI-compatible streaming server for sandbox smoke tests.
// Turn 1: tool call (bash writes result-file.txt). Turn 2: final text.
//
// FAKE_LLM_MODE reproduces the production failure where a provider accepts a
// request and streams nothing back, which opencode records as a completed
// turn with no parts and finish "unknown":
//   normal        every turn answers (default)
//   stall-once    the final turn is empty once, then answers  -> runner retries
//   stall-always  the final turn is always empty              -> runner fails
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8091);
const MODE = process.env.FAKE_LLM_MODE ?? "normal";
let stalls = 0;

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
  req.on("end", () => {
    const payload = JSON.parse(body);
    const hasToolResult = payload.messages.some((m) => m.role === "tool");
    console.log(`fake-llm: ${payload.messages.length} messages, hasToolResult=${hasToolResult}`);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // An empty stream: headers, no chunks, no finish_reason, just [DONE].
    if (hasToolResult && (MODE === "stall-always" || (MODE === "stall-once" && stalls === 0))) {
      stalls++;
      console.log(`fake-llm: returning an empty stream (stall ${stalls}, mode ${MODE})`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const base = {
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: payload.model,
    };

    if (!hasToolResult) {
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

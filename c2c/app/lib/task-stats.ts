/**
 * Where a run's time went, derived from the opencode transcript the runner
 * syncs. Every assistant message is one model call (a "step"): opencode
 * stamps it when the request starts and when the step completes, and the
 * tools the model asked for run inside that window, each stamped on its own.
 * So per step, tool time is the union of its tool intervals (tools can run in
 * parallel) and model time is the rest of the step.
 *
 * Computed on read rather than stored, so it covers every task that has a
 * transcript, including ones that ran before this existed.
 */

interface Interval {
  start: number;
  end: number;
}

export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

export interface RunStats {
  /** Runner start (opencode ready) to result; null while the task runs. */
  wallMs: number | null;
  /** Queueing, pod scheduling, image pull and opencode startup. */
  startupMs: number | null;
  modelMs: number;
  toolMs: number;
  /** wallMs minus model and tool time: session setup, polling, uploads. */
  otherMs: number | null;
  modelCalls: number;
  slowestCallMs: number;
  toolCalls: number;
  tools: ToolStat[];
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  cost: number;
}

type Json = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});

/** Total length covered by a set of possibly overlapping intervals. */
function unionLength(intervals: Interval[]): number {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const { start, end } of sorted) {
    if (start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = start;
      curEnd = end;
    } else {
      curEnd = Math.max(curEnd, end);
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

function toMs(d: Date | string | null | undefined): number | null {
  return d ? new Date(d).getTime() : null;
}

export function computeRunStats(
  transcript: unknown,
  times: {
    createdAt: Date | string;
    startedAt: Date | string | null;
    finishedAt: Date | string | null;
  },
  now = Date.now(),
): RunStats | null {
  if (!Array.isArray(transcript)) return null;

  const tools = new Map<string, ToolStat>();
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let modelMs = 0;
  let toolMs = 0;
  let modelCalls = 0;
  let slowestCallMs = 0;
  let toolCalls = 0;
  let cost = 0;

  for (const raw of transcript) {
    const msg = obj(raw);
    const info = obj(msg.info);
    if (info.role !== "assistant") continue;
    const time = obj(info.time);
    const start = num(time.created);
    if (!start) continue;
    // A step still in flight runs until now (live view) or, if the task
    // ended without completing it, until the task did.
    const end = num(time.completed) || toMs(times.finishedAt) || now;

    const intervals: Interval[] = [];
    for (const rawPart of Array.isArray(msg.parts) ? msg.parts : []) {
      const part = obj(rawPart);
      if (part.type !== "tool") continue;
      const state = obj(part.state);
      const t = obj(state.time);
      const tStart = num(t.start);
      if (!tStart) continue;
      const tEnd = num(t.end) || end;
      const duration = Math.max(0, tEnd - tStart);
      intervals.push({ start: Math.max(tStart, start), end: Math.min(tEnd, end) });

      const name = typeof part.tool === "string" ? part.tool : "unknown";
      const stat = tools.get(name) ?? { name, calls: 0, errors: 0, totalMs: 0, maxMs: 0 };
      stat.calls++;
      if (state.status === "error") stat.errors++;
      stat.totalMs += duration;
      stat.maxMs = Math.max(stat.maxMs, duration);
      tools.set(name, stat);
      toolCalls++;
    }

    const stepMs = Math.max(0, end - start);
    const stepToolMs = Math.min(stepMs, unionLength(intervals));
    toolMs += stepToolMs;
    modelMs += stepMs - stepToolMs;
    modelCalls++;
    slowestCallMs = Math.max(slowestCallMs, stepMs - stepToolMs);

    const tk = obj(info.tokens);
    const cache = obj(tk.cache);
    tokens.input += num(tk.input);
    tokens.output += num(tk.output);
    tokens.reasoning += num(tk.reasoning);
    tokens.cacheRead += num(cache.read);
    tokens.cacheWrite += num(cache.write);
    cost += num(info.cost);
  }

  if (modelCalls === 0) return null;

  const created = toMs(times.createdAt);
  const started = toMs(times.startedAt);
  const finished = toMs(times.finishedAt);
  const wallMs = started && finished ? Math.max(0, finished - started) : null;

  return {
    wallMs,
    startupMs: created && started ? Math.max(0, started - created) : null,
    modelMs,
    toolMs,
    otherMs: wallMs === null ? null : Math.max(0, wallMs - modelMs - toolMs),
    modelCalls,
    slowestCallMs,
    toolCalls,
    tools: [...tools.values()].sort((a, b) => b.totalMs - a.totalMs),
    tokens,
    cost,
  };
}

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { Theme } from "@mui/material/styles";
import type { RunStats } from "~/lib/task-stats";

// Categorical slots 1 and 2 of the dataviz reference palette, each with its
// own dark-mode step (validated as a pair in both modes). "Other" is not a
// series but a remainder, so it stays a neutral gray.
const SEGMENT_COLORS = {
  model: { light: "#2a78d6", dark: "#3987e5" },
  tools: { light: "#eb6834", dark: "#d95926" },
  other: { light: "#b4b3ad", dark: "#5c5b57" },
};

type SegmentKey = keyof typeof SEGMENT_COLORS;

function swatch(key: SegmentKey) {
  return (theme: Theme) => ({
    bgcolor: SEGMENT_COLORS[key].light,
    ...theme.applyStyles("dark", { bgcolor: SEGMENT_COLORS[key].dark }),
  });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(Math.round(s % 60)).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

const formatCount = (n: number) => n.toLocaleString("en-US");
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function StatTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <Box sx={{ minWidth: 140, flex: "1 1 140px" }}>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h6" sx={{ fontVariantNumeric: "tabular-nums", lineHeight: 1.3 }}>
        {value}
      </Typography>
      {detail && (
        <Typography variant="caption" color="text.secondary">
          {detail}
        </Typography>
      )}
    </Box>
  );
}

/** One part-to-whole bar: where the run's wall-clock time went. */
function TimeBar({ segments, total }: { segments: { key: SegmentKey; label: string; ms: number }[]; total: number }) {
  const visible = segments.filter((s) => s.ms > 0);
  return (
    <>
      <Box
        role="img"
        aria-label={visible.map((s) => `${s.label} ${formatDuration(s.ms)}`).join(", ")}
        sx={{ display: "flex", gap: "2px", height: 14, borderRadius: "4px", overflow: "hidden" }}
      >
        {visible.map((s) => (
          <Tooltip
            key={s.key}
            title={`${s.label}: ${formatDuration(s.ms)} (${pct(s.ms, total)}%)`}
            placement="top"
            arrow
          >
            <Box sx={[{ flexGrow: s.ms, flexBasis: 0, minWidth: 3 }, swatch(s.key)]} />
          </Tooltip>
        ))}
      </Box>
      <Stack direction="row" spacing={3} sx={{ mt: 1, flexWrap: "wrap", rowGap: 0.5 }}>
        {segments.map((s) => (
          <Stack key={s.key} direction="row" spacing={0.75} sx={{ alignItems: "center" }}>
            <Box sx={[{ width: 10, height: 10, borderRadius: "2px" }, swatch(s.key)]} />
            <Typography variant="body2">
              {s.label}{" "}
              <Box component="span" sx={{ color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
                {formatDuration(s.ms)} · {pct(s.ms, total)}%
              </Box>
            </Typography>
          </Stack>
        ))}
      </Stack>
    </>
  );
}

export default function RunStatsCard({ stats, live }: { stats: RunStats; live: boolean }) {
  const segments: { key: SegmentKey; label: string; ms: number }[] = [
    { key: "model", label: "Waiting on the model", ms: stats.modelMs },
    { key: "tools", label: "Running tools", ms: stats.toolMs },
  ];
  if (stats.otherMs !== null) segments.push({ key: "other", label: "Other", ms: stats.otherMs });
  const total = stats.wallMs ?? stats.modelMs + stats.toolMs;
  const { tokens } = stats;
  const usesSubagents = stats.tools.some((t) => t.name === "task");

  return (
    <Paper sx={{ p: 2, mb: 2 }}>
      <Typography variant="subtitle2" color="text.secondary" gutterBottom>
        Run statistics{live && " (so far)"}
      </Typography>

      <Stack direction="row" sx={{ flexWrap: "wrap", gap: 2, mb: 2 }}>
        <StatTile
          label="Run time"
          value={formatDuration(total)}
          detail={stats.startupMs !== null ? `+ ${formatDuration(stats.startupMs)} queue & startup` : undefined}
        />
        <StatTile
          label="Model"
          value={formatDuration(stats.modelMs)}
          detail={`${stats.modelCalls} calls · slowest ${formatDuration(stats.slowestCallMs)}`}
        />
        <StatTile
          label="Tools"
          value={formatDuration(stats.toolMs)}
          detail={`${stats.toolCalls} calls`}
        />
        <StatTile
          label="Tokens in / out"
          value={`${formatCount(tokens.input + tokens.cacheRead)} / ${formatCount(tokens.output)}`}
          detail={[
            tokens.cacheRead > 0 && `${formatCount(tokens.cacheRead)} cached`,
            tokens.reasoning > 0 && `${formatCount(tokens.reasoning)} reasoning`,
          ]
            .filter(Boolean)
            .join(" · ") || undefined}
        />
      </Stack>

      <TimeBar segments={segments} total={total} />
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
        Model time runs from each request to the model until its answer is complete. Other covers
        the runner's own work: starting the session, noticing the agent finished, and uploading
        files.
      </Typography>

      {stats.tools.length > 0 && (
        <Table size="small" sx={{ mt: 2 }}>
          <TableHead>
            <TableRow>
              <TableCell>Tool</TableCell>
              <TableCell align="right">Calls</TableCell>
              <TableCell align="right">Errors</TableCell>
              <TableCell align="right">Total time</TableCell>
              <TableCell align="right">Longest call</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {stats.tools.map((t) => (
              <TableRow key={t.name}>
                <TableCell sx={{ fontFamily: "monospace" }}>{t.name}</TableCell>
                <TableCell align="right">{t.calls}</TableCell>
                <TableCell align="right">{t.errors || "—"}</TableCell>
                <TableCell align="right">{formatDuration(t.totalMs)}</TableCell>
                <TableCell align="right">{formatDuration(t.maxMs)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {usesSubagents && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
          The <code>task</code> tool runs a subagent; its time includes that subagent's own model
          calls.
        </Typography>
      )}
    </Paper>
  );
}

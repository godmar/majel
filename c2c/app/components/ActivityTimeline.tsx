import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import BuildIcon from "@mui/icons-material/Build";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import PsychologyIcon from "@mui/icons-material/Psychology";
import SmartToyIcon from "@mui/icons-material/SmartToy";
import MarkdownView from "./MarkdownView";

/**
 * opencode transcript rendering. The transcript is the JSON returned by
 * GET /session/{id}/message: an array of { info: Message, parts: Part[] }.
 * Shapes are handled defensively since they come from an external tool.
 */

interface TranscriptPart {
  type?: string;
  text?: string;
  tool?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    title?: string;
    error?: string;
  };
}

interface TranscriptMessage {
  info?: { role?: string; id?: string };
  parts?: TranscriptPart[];
}

function toolSummary(part: TranscriptPart): string {
  const input = part.state?.input ?? {};
  if (typeof part.state?.title === "string" && part.state.title) return part.state.title;
  for (const key of ["command", "filePath", "path", "url", "query", "pattern", "description"]) {
    const v = input[key];
    if (typeof v === "string" && v) return v.length > 100 ? `${v.slice(0, 100)}…` : v;
  }
  return "";
}

function MonoBlock({ children }: { children: string }) {
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1,
        borderRadius: 1,
        bgcolor: "action.hover",
        overflow: "auto",
        maxHeight: 320,
        fontSize: "0.8rem",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {children}
    </Box>
  );
}

function ToolCall({ part }: { part: TranscriptPart }) {
  const status = part.state?.status;
  const failed = status === "error";
  const running = status === "running" || status === "pending";
  const summary = toolSummary(part);
  return (
    <Accordion variant="outlined" disableGutters sx={{ "&:before": { display: "none" } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", minWidth: 0, width: "100%" }}>
          <BuildIcon fontSize="small" color={failed ? "error" : "action"} />
          <Chip
            size="small"
            label={part.tool ?? "tool"}
            color={failed ? "error" : running ? "info" : "default"}
            variant="outlined"
          />
          <Typography
            variant="body2"
            color="text.secondary"
            noWrap
            sx={{ fontFamily: summary.startsWith("/") || part.tool === "bash" ? "monospace" : undefined }}
          >
            {summary}
          </Typography>
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Stack spacing={1}>
          {part.state?.input && Object.keys(part.state.input).length > 0 && (
            <>
              <Typography variant="caption" color="text.secondary">
                Input
              </Typography>
              <MonoBlock>{JSON.stringify(part.state.input, null, 2)}</MonoBlock>
            </>
          )}
          {part.state?.error && (
            <>
              <Typography variant="caption" color="error">
                Error
              </Typography>
              <MonoBlock>{part.state.error}</MonoBlock>
            </>
          )}
          {typeof part.state?.output === "string" && part.state.output && (
            <>
              <Typography variant="caption" color="text.secondary">
                Output
              </Typography>
              <MonoBlock>{part.state.output}</MonoBlock>
            </>
          )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}

function Reasoning({ text }: { text: string }) {
  return (
    <Accordion variant="outlined" disableGutters sx={{ "&:before": { display: "none" } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <PsychologyIcon fontSize="small" color="action" />
          <Typography variant="body2" color="text.secondary">
            Reasoning
          </Typography>
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
        <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: "pre-wrap" }}>
          {text}
        </Typography>
      </AccordionDetails>
    </Accordion>
  );
}

export default function ActivityTimeline({
  transcript,
  live,
}: {
  transcript: unknown;
  live: boolean;
}) {
  const messages: TranscriptMessage[] = Array.isArray(transcript) ? transcript : [];
  const items: React.ReactNode[] = [];

  for (const msg of messages) {
    if (msg.info?.role !== "assistant") continue;
    for (const [i, part] of (msg.parts ?? []).entries()) {
      const key = `${msg.info?.id ?? "m"}-${i}`;
      if (part.type === "text" && part.text?.trim()) {
        items.push(
          <Stack key={key} direction="row" spacing={1} sx={{ py: 1 }}>
            <SmartToyIcon fontSize="small" color="primary" sx={{ mt: 0.5 }} />
            <Box sx={{ minWidth: 0, flexGrow: 1 }}>
              <MarkdownView>{part.text}</MarkdownView>
            </Box>
          </Stack>,
        );
      } else if (part.type === "reasoning" && part.text?.trim()) {
        items.push(<Reasoning key={key} text={part.text} />);
      } else if (part.type === "tool") {
        items.push(<ToolCall key={key} part={part} />);
      }
    }
  }

  if (items.length === 0 && !live) return null;

  return (
    <Paper sx={{ p: 2, mb: 2 }}>
      <Typography variant="subtitle2" color="text.secondary" gutterBottom>
        Agent activity
      </Typography>
      {items.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Waiting for the agent to start…
        </Typography>
      ) : (
        <Stack spacing={0.5}>{items}</Stack>
      )}
      {live && <LinearProgress sx={{ mt: 2 }} />}
    </Paper>
  );
}

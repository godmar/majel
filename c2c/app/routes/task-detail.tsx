import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import ArchiveIcon from "@mui/icons-material/Archive";
import CancelIcon from "@mui/icons-material/Cancel";
import UnarchiveIcon from "@mui/icons-material/Unarchive";
import CircleIcon from "@mui/icons-material/Circle";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import InsertDriveFileIcon from "@mui/icons-material/InsertDriveFile";
import ReplayIcon from "@mui/icons-material/Replay";
import * as React from "react";
import { and, asc, eq } from "drizzle-orm";
import { Form, redirect, useRevalidator } from "react-router";
import type { Route } from "./+types/task-detail";
import ActivityTimeline from "~/components/ActivityTimeline";
import DateTime from "~/components/DateTime";
import MarkdownView from "~/components/MarkdownView";
import TaskStatusChip from "~/components/TaskStatusChip";
import { requireUser } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { listTaskFiles } from "~/lib/files.server";
import { agentDefinitions, taskEvents, taskFiles, tasks } from "~/lib/schema.server";
import { addTaskEvent, createTask, isTerminal } from "~/lib/tasks.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, params.taskId) });
  if (!task) throw new Response("Not found", { status: 404 });
  if (user.role !== "admin" && task.createdBy !== user.id) {
    throw new Response("Forbidden", { status: 403 });
  }

  const agent = await db.query.agentDefinitions.findFirst({
    where: eq(agentDefinitions.id, task.agentDefinitionId),
  });
  const events = await db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, task.id))
    .orderBy(asc(taskEvents.ts));
  const files = await listTaskFiles(task.id);

  return {
    task: {
      id: task.id,
      status: task.status,
      prompt: task.prompt,
      model: task.modelOverride ?? agent?.model ?? "",
      resultText: task.resultText,
      transcript: task.transcript,
      error: task.error,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      archived: task.archivedAt !== null,
    },
    agentName: agent?.name ?? "unknown",
    events: events.map((e) => ({ id: e.id, ts: e.ts, type: e.type, message: e.message })),
    inputFiles: files.filter((f) => f.kind === "input"),
    outputFiles: files.filter((f) => f.kind === "output"),
    terminal: isTerminal(task.status),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const user = await requireUser(request);
  const task = await db.query.tasks.findFirst({ where: eq(tasks.id, params.taskId) });
  if (!task) throw new Response("Not found", { status: 404 });
  if (user.role !== "admin" && task.createdBy !== user.id) {
    throw new Response("Forbidden", { status: 403 });
  }

  const form = await request.formData();
  const intent = form.get("intent");
  if (intent === "cancel" && !isTerminal(task.status)) {
    const { cancelTask } = await import("~/lib/k8s.server");
    await cancelTask(task.id);
    await db
      .update(tasks)
      .set({ status: "canceled", finishedAt: new Date() })
      .where(eq(tasks.id, task.id));
    await addTaskEvent(task.id, "canceled", `Canceled by ${user.username}`);
  } else if (intent === "archive" && isTerminal(task.status)) {
    await db.update(tasks).set({ archivedAt: new Date() }).where(eq(tasks.id, task.id));
  } else if (intent === "unarchive") {
    await db.update(tasks).set({ archivedAt: null }).where(eq(tasks.id, task.id));
  } else if (intent === "rerun" && isTerminal(task.status)) {
    // Fresh task with the same prompt/agent/model/inputs. It runs as whoever
    // clicked (LLM keys are per user), not the original creator.
    const inputs = await db.query.taskFiles.findMany({
      where: and(eq(taskFiles.taskId, task.id), eq(taskFiles.kind, "input")),
    });
    try {
      const rerun = await createTask({
        agentDefinitionId: task.agentDefinitionId,
        prompt: task.prompt,
        modelOverride: task.modelOverride,
        createdBy: user.id,
        triggerSource: "web",
        files: inputs.map((f) => ({
          filename: f.filename,
          mimeType: f.mimeType,
          content: f.content,
        })),
      });
      await addTaskEvent(rerun.id, "rerun", `Rerun of task ${task.id} by ${user.username}`);
      throw redirect(`/tasks/${rerun.id}`);
    } catch (err) {
      if (err instanceof Response) throw err;
      return { error: err instanceof Error ? err.message : "Failed to rerun task" };
    }
  }
  return { error: null };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function FileList({ taskId, files }: { taskId: string; files: { id: number; filename: string; sizeBytes: number }[] }) {
  return (
    <List dense>
      {files.map((f) => (
        <ListItem key={f.id} disablePadding>
          <ListItemIcon sx={{ minWidth: 32 }}>
            <InsertDriveFileIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>
            <Link href={`/tasks/${taskId}/files/${f.id}`} download>
              {f.filename}
            </Link>{" "}
            <Typography component="span" variant="body2" color="text.secondary">
              ({formatBytes(f.sizeBytes)})
            </Typography>
          </ListItemText>
        </ListItem>
      ))}
    </List>
  );
}

export default function TaskDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { task, agentName, events, inputFiles, outputFiles, terminal } = loaderData;
  const revalidator = useRevalidator();

  // Live-refresh while the task is active; the runner keeps the transcript
  // synced server-side.
  React.useEffect(() => {
    if (terminal) return;
    const id = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 3000);
    return () => clearInterval(id);
  }, [terminal, revalidator]);

  const duration =
    task.startedAt &&
    Math.round(
      ((task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now()) -
        new Date(task.startedAt).getTime()) /
        1000,
    );

  return (
    <Box sx={{ maxWidth: 1000 }}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "center", mb: 2, flexWrap: "wrap" }}>
        <Typography variant="h5">Task</Typography>
        <TaskStatusChip status={task.status} />
        <Chip size="small" variant="outlined" label={agentName} />
        <Chip size="small" variant="outlined" label={task.model} />
        {duration !== null && duration !== undefined && (
          <Typography variant="body2" color="text.secondary" suppressHydrationWarning>
            {duration}s
          </Typography>
        )}
        {task.archived && <Chip size="small" label="Archived" />}
        <Box sx={{ flexGrow: 1 }} />
        {terminal ? (
          <>
            <Form method="post">
              <input type="hidden" name="intent" value="rerun" />
              <Button type="submit" size="small" startIcon={<ReplayIcon />}>
                Rerun
              </Button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value={task.archived ? "unarchive" : "archive"} />
              <Button
                type="submit"
                size="small"
                startIcon={task.archived ? <UnarchiveIcon /> : <ArchiveIcon />}
              >
                {task.archived ? "Unarchive" : "Archive"}
              </Button>
            </Form>
          </>
        ) : (
          <Form
            method="post"
            onSubmit={(e) => {
              if (!confirm("Cancel this task?")) e.preventDefault();
            }}
          >
            <input type="hidden" name="intent" value="cancel" />
            <Button type="submit" color="error" size="small" startIcon={<CancelIcon />}>
              Cancel
            </Button>
          </Form>
        )}
      </Stack>

      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
          Prompt
        </Typography>
        <Typography sx={{ whiteSpace: "pre-wrap" }}>{task.prompt}</Typography>
        {inputFiles.length > 0 && (
          <>
            <Divider sx={{ my: 1.5 }} />
            <Typography variant="subtitle2" color="text.secondary">
              Input files
            </Typography>
            <FileList taskId={task.id} files={inputFiles} />
          </>
        )}
      </Paper>

      {actionData?.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {actionData.error}
        </Alert>
      )}

      {task.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {task.error}
        </Alert>
      )}

      <ActivityTimeline transcript={task.transcript} live={!terminal} />

      {task.resultText && (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
            Result
          </Typography>
          <MarkdownView>{task.resultText}</MarkdownView>
        </Paper>
      )}

      {outputFiles.length > 0 && (
        <Paper sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
            Output files
          </Typography>
          <FileList taskId={task.id} files={outputFiles} />
        </Paper>
      )}

      <Accordion variant="outlined" disableGutters>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography variant="subtitle2">Event log ({events.length})</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <List dense>
            {events.map((e) => (
              <ListItem key={e.id} disablePadding sx={{ py: 0.25 }}>
                <ListItemIcon sx={{ minWidth: 24 }}>
                  <CircleIcon sx={{ fontSize: 8 }} color="disabled" />
                </ListItemIcon>
                <ListItemText
                  primary={e.message ?? e.type}
                  secondary={
                    <>
                      {e.type} — <DateTime value={e.ts} />
                    </>
                  }
                />
              </ListItem>
            ))}
          </List>
        </AccordionDetails>
      </Accordion>
    </Box>
  );
}

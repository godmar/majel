import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import SendIcon from "@mui/icons-material/Send";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import * as React from "react";
import { asc, eq } from "drizzle-orm";
import { Form, redirect, useNavigation } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/task-new";
import { requireUser } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { FileTooLargeError, MAX_FILE_BYTES } from "~/lib/files.server";
import { agentDefinitions, providers } from "~/lib/schema.server";
import { createTask } from "~/lib/tasks.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const agents = await db
    .select({
      id: agentDefinitions.id,
      name: agentDefinitions.name,
      description: agentDefinitions.description,
      model: agentDefinitions.model,
    })
    .from(agentDefinitions)
    .where(eq(agentDefinitions.enabled, true))
    .orderBy(asc(agentDefinitions.name));

  const allProviders = await db
    .select({ name: providers.name, models: providers.models })
    .from(providers)
    .where(eq(providers.enabled, true));
  const modelOptions = allProviders.flatMap((p) =>
    p.models.map((m) => ({ value: `${p.name}/${m.id}`, label: m.name })),
  );

  return { agents, modelOptions };
}

const formSchema = z.object({
  agentDefinitionId: z.coerce.number().int(),
  prompt: z.string().trim().min(1, "Prompt is required"),
  modelOverride: z.string().trim().optional(),
});

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();

  const parsed = formSchema.safeParse({
    agentDefinitionId: form.get("agentDefinitionId"),
    prompt: form.get("prompt"),
    modelOverride: form.get("modelOverride") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const files: { filename: string; mimeType?: string; content: Buffer }[] = [];
  for (const entry of form.getAll("files")) {
    if (entry instanceof File && entry.size > 0) {
      if (entry.size > MAX_FILE_BYTES) {
        return { error: `${entry.name} exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB per-file limit.` };
      }
      files.push({
        filename: entry.name,
        mimeType: entry.type || undefined,
        content: Buffer.from(await entry.arrayBuffer()),
      });
    }
  }

  try {
    const task = await createTask({
      agentDefinitionId: parsed.data.agentDefinitionId,
      prompt: parsed.data.prompt,
      modelOverride: parsed.data.modelOverride === "" ? null : parsed.data.modelOverride,
      createdBy: user.id,
      triggerSource: "web",
      files,
    });
    throw redirect(`/tasks/${task.id}`);
  } catch (err) {
    if (err instanceof Response) throw err;
    if (err instanceof FileTooLargeError) return { error: err.message };
    return { error: err instanceof Error ? err.message : "Failed to create task" };
  }
}

export default function TaskNew({ loaderData, actionData }: Route.ComponentProps) {
  const { agents, modelOptions } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [agentId, setAgentId] = React.useState<number | "">(agents[0]?.id ?? "");
  const [fileNames, setFileNames] = React.useState<string[]>([]);
  const selectedAgent = agents.find((a) => a.id === agentId);

  return (
    <Box sx={{ maxWidth: 800 }}>
      <Typography variant="h5" sx={{ mb: 2 }}>
        New Task
      </Typography>

      {agents.length === 0 ? (
        <Alert severity="info">No agents are available. Ask an administrator to configure one.</Alert>
      ) : (
        <Paper sx={{ p: 3 }}>
          <Form method="post" encType="multipart/form-data">
            <Stack spacing={3}>
              <TextField
                name="agentDefinitionId"
                label="Agent"
                select
                required
                value={agentId}
                onChange={(e) => setAgentId(Number(e.target.value))}
                helperText={selectedAgent?.description || " "}
              >
                {agents.map((a) => (
                  <MenuItem key={a.id} value={a.id}>
                    {a.name}
                  </MenuItem>
                ))}
              </TextField>

              <TextField
                name="prompt"
                label="Task (prompt)"
                placeholder="Describe the task for the agent…"
                required
                multiline
                minRows={5}
                fullWidth
              />

              <TextField
                name="modelOverride"
                label="Model (optional override)"
                select
                defaultValue=""
                helperText={selectedAgent ? `Default: ${selectedAgent.model}` : " "}
              >
                <MenuItem value="">Use agent default</MenuItem>
                {modelOptions.map((m) => (
                  <MenuItem key={m.value} value={m.value}>
                    {m.label}
                  </MenuItem>
                ))}
              </TextField>

              <Box>
                <Button component="label" variant="outlined" startIcon={<UploadFileIcon />}>
                  Attach files
                  <input
                    type="file"
                    name="files"
                    multiple
                    hidden
                    onChange={(e) =>
                      setFileNames(Array.from(e.target.files ?? []).map((f) => f.name))
                    }
                  />
                </Button>
                {fileNames.length > 0 && (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                    {fileNames.join(", ")}
                  </Typography>
                )}
              </Box>

              {actionData?.error && <Alert severity="error">{actionData.error}</Alert>}

              <Box>
                <Button type="submit" variant="contained" startIcon={<SendIcon />} disabled={busy}>
                  {busy ? "Submitting…" : "Submit task"}
                </Button>
              </Box>
            </Stack>
          </Form>
        </Paper>
      )}
    </Box>
  );
}

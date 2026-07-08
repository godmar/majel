import * as React from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import EditIcon from "@mui/icons-material/Edit";
import { asc, eq } from "drizzle-orm";
import { Form, useNavigation } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/admin-providers";
import { requireAdmin } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { providers, type ProviderModel } from "~/lib/schema.server";

// opencode requires context/output limits for every model; these defaults
// apply when a line omits them.
const DEFAULT_CONTEXT_LIMIT = 131072;
const DEFAULT_OUTPUT_LIMIT = 16384;

const MODELS_FORMAT = 'one model per line: "model-id | Display Name | context-limit | output-limit"';

/**
 * Parse the models textarea. Limits are mandatory in the rendered opencode
 * config, so missing/invalid numbers fall back to the defaults.
 */
function parseModels(text: string): ProviderModel[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name, context, output] = line.split("|").map((s) => s.trim());
      return {
        id,
        name: name || id,
        contextLimit: Number(context) > 0 ? Number(context) : DEFAULT_CONTEXT_LIMIT,
        outputLimit: Number(output) > 0 ? Number(output) : DEFAULT_OUTPUT_LIMIT,
      };
    });
}

function modelsToText(models: ProviderModel[]): string {
  return models
    .map(
      (m) =>
        `${m.id} | ${m.name} | ${m.contextLimit ?? DEFAULT_CONTEXT_LIMIT} | ${m.outputLimit ?? DEFAULT_OUTPUT_LIMIT}`,
    )
    .join("\n");
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const rows = await db.select().from(providers).orderBy(asc(providers.name));
  return {
    providers: rows.map((p) => ({
      id: p.id,
      name: p.name,
      displayName: p.displayName,
      baseUrl: p.baseUrl,
      npm: p.npm,
      modelIds: p.models.map((m) => m.id),
      modelsText: modelsToText(p.models),
      enabled: p.enabled,
    })),
  };
}

const upsertSchema = z.object({
  name: z.string().trim().min(1).max(64),
  displayName: z.string().trim().default(""),
  baseUrl: z.string().trim().url(),
  models: z.string().trim().default(""),
});

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "add") {
    const parsed = upsertSchema.safeParse({
      name: form.get("name"),
      displayName: form.get("displayName"),
      baseUrl: form.get("baseUrl"),
      models: form.get("models") ?? "",
    });
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    const d = parsed.data;
    try {
      await db.insert(providers).values({
        name: d.name,
        displayName: d.displayName || d.name,
        baseUrl: d.baseUrl,
        models: parseModels(d.models),
      });
    } catch {
      return { error: `A provider named "${d.name}" already exists.` };
    }
    return { ok: true };
  }

  const id = Number(form.get("id"));
  if (!Number.isInteger(id)) return { error: "Invalid provider" };

  if (intent === "update") {
    const parsed = upsertSchema.safeParse({
      name: form.get("name"),
      displayName: form.get("displayName"),
      baseUrl: form.get("baseUrl"),
      models: form.get("models") ?? "",
    });
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    const d = parsed.data;
    try {
      await db
        .update(providers)
        .set({
          name: d.name,
          displayName: d.displayName || d.name,
          baseUrl: d.baseUrl,
          models: parseModels(d.models),
          updatedAt: new Date(),
        })
        .where(eq(providers.id, id));
    } catch {
      return { error: `A provider named "${d.name}" already exists.` };
    }
    return { ok: true };
  }

  if (intent === "toggle-enabled") {
    await db
      .update(providers)
      .set({ enabled: form.get("enabled") === "true", updatedAt: new Date() })
      .where(eq(providers.id, id));
    return { ok: true };
  }
  return { error: "Unknown action" };
}

interface EditableProvider {
  id: number;
  name: string;
  displayName: string | null;
  baseUrl: string;
  modelsText: string;
}

function EditProviderDialog({
  provider,
  onClose,
  busy,
}: {
  provider: EditableProvider | null;
  onClose: () => void;
  busy: boolean;
}) {
  return (
    <Dialog open={Boolean(provider)} onClose={onClose} fullWidth maxWidth="md">
      {provider && (
        <Form method="post" onSubmit={onClose}>
          <input type="hidden" name="intent" value="update" />
          <input type="hidden" name="id" value={provider.id} />
          <DialogTitle>Edit provider</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                <TextField name="name" label="Name (id)" size="small" required defaultValue={provider.name} fullWidth />
                <TextField
                  name="displayName"
                  label="Display name"
                  size="small"
                  defaultValue={provider.displayName ?? ""}
                  fullWidth
                />
              </Stack>
              <TextField name="baseUrl" label="Base URL" size="small" required defaultValue={provider.baseUrl} />
              <TextField
                name="models"
                label={`Models (${MODELS_FORMAT})`}
                size="small"
                multiline
                minRows={4}
                defaultValue={provider.modelsText}
                slotProps={{ input: { sx: { fontFamily: "monospace", fontSize: "0.85rem" } } }}
              />
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose} color="inherit">
              Cancel
            </Button>
            <Button type="submit" variant="contained" disabled={busy}>
              Save
            </Button>
          </DialogActions>
        </Form>
      )}
    </Dialog>
  );
}

export default function AdminProviders({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [editing, setEditing] = React.useState<EditableProvider | null>(null);

  return (
    <>
      <Typography variant="h5" sx={{ mb: 2 }}>
        LLM Providers
      </Typography>

      <Paper sx={{ p: 2, mb: 3 }}>
        <Form method="post">
          <input type="hidden" name="intent" value="add" />
          <Stack spacing={2}>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <TextField name="name" label="Name (id)" size="small" required sx={{ minWidth: 160 }} />
              <TextField name="displayName" label="Display name" size="small" sx={{ minWidth: 160 }} />
              <TextField name="baseUrl" label="Base URL (OpenAI-compatible)" size="small" required fullWidth />
            </Stack>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <TextField
                name="models"
                label={`Models (${MODELS_FORMAT})`}
                size="small"
                multiline
                minRows={2}
                fullWidth
              />
            </Stack>
            <Box>
              <Button type="submit" variant="contained" startIcon={<AddIcon />} disabled={busy}>
                Add provider
              </Button>
            </Box>
          </Stack>
        </Form>
        {actionData?.error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {actionData.error}
          </Alert>
        )}
      </Paper>

      <TableContainer component={Paper}>
        <Table size="small" sx={{ minWidth: 650 }}>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Base URL</TableCell>
              <TableCell>Models</TableCell>
              <TableCell>Enabled</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loaderData.providers.map((p) => (
              <TableRow key={p.id} hover>
                <TableCell>{p.displayName ?? p.name}</TableCell>
                <TableCell sx={{ wordBreak: "break-all" }}>{p.baseUrl}</TableCell>
                <TableCell>
                  <Typography variant="body2" color="text.secondary">
                    {p.modelIds.length} model{p.modelIds.length === 1 ? "" : "s"}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Form method="post">
                    <input type="hidden" name="intent" value="toggle-enabled" />
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="enabled" value={String(!p.enabled)} />
                    <Switch
                      checked={p.enabled}
                      size="small"
                      disabled={busy}
                      onChange={(e) => e.target.form?.requestSubmit()}
                      slotProps={{ input: { "aria-label": `enable ${p.name}` } }}
                    />
                  </Form>
                </TableCell>
                <TableCell align="right">
                  <Tooltip title="Edit">
                    <IconButton size="small" disabled={busy} onClick={() => setEditing(p)}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <EditProviderDialog provider={editing} onClose={() => setEditing(null)} busy={busy} />
    </>
  );
}

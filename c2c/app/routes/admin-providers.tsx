import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
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
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import { asc, eq } from "drizzle-orm";
import { Form, useNavigation } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/admin-providers";
import { requireAdmin } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { providers, type ProviderModel } from "~/lib/schema.server";

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
      enabled: p.enabled,
      hasApiKey: p.apiKey.length > 0,
    })),
  };
}

const upsertSchema = z.object({
  name: z.string().trim().min(1).max(64),
  displayName: z.string().trim().default(""),
  baseUrl: z.string().trim().url(),
  apiKey: z.string().default(""),
  models: z.string().trim().default(""),
});

/** Models are entered one per line as "id" or "id | Display Name". */
function parseModels(text: string): ProviderModel[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name] = line.split("|").map((s) => s.trim());
      return { id, name: name || id, contextLimit: 131072, outputLimit: 16384 };
    });
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "add") {
    const parsed = upsertSchema.safeParse({
      name: form.get("name"),
      displayName: form.get("displayName"),
      baseUrl: form.get("baseUrl"),
      apiKey: form.get("apiKey"),
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
        apiKey: d.apiKey,
        models: parseModels(d.models),
      });
    } catch {
      return { error: `A provider named "${d.name}" already exists.` };
    }
    return { ok: true };
  }

  const id = Number(form.get("id"));
  if (!Number.isInteger(id)) return { error: "Invalid provider" };

  if (intent === "toggle-enabled") {
    await db
      .update(providers)
      .set({ enabled: form.get("enabled") === "true", updatedAt: new Date() })
      .where(eq(providers.id, id));
    return { ok: true };
  }
  return { error: "Unknown action" };
}

export default function AdminProviders({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

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
              <TextField name="apiKey" label="API key" size="small" type="password" fullWidth />
              <TextField
                name="models"
                label='Models (one per line: "model-id | Display Name")'
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
              <TableCell>API key</TableCell>
              <TableCell>Enabled</TableCell>
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
                <TableCell>{p.hasApiKey ? "set" : "—"}</TableCell>
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  );
}

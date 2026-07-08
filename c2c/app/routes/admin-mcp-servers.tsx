import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
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
import DeleteIcon from "@mui/icons-material/Delete";
import { asc, eq } from "drizzle-orm";
import { Form, useNavigation } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/admin-mcp-servers";
import { requireAdmin } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { mcpServers } from "~/lib/schema.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const rows = await db.select().from(mcpServers).orderBy(asc(mcpServers.name));
  return {
    servers: rows.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      enabled: s.enabled,
      headerNames: Object.keys(s.headers ?? {}),
    })),
  };
}

const addSchema = z.object({
  name: z.string().trim().min(1).max(64),
  url: z.string().trim().url("URL must be a valid http(s) URL"),
  headers: z.string().trim().default(""),
});

function parseHeaders(text: string): Record<string, string> | null {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) return null;
    headers[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return headers;
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "add") {
    const parsed = addSchema.safeParse({
      name: form.get("name"),
      url: form.get("url"),
      headers: form.get("headers") ?? "",
    });
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    const headers = parseHeaders(parsed.data.headers);
    if (headers === null) {
      return { error: 'Headers must be one "Name: value" pair per line.' };
    }
    try {
      await db.insert(mcpServers).values({
        name: parsed.data.name,
        url: parsed.data.url,
        headers: Object.keys(headers).length > 0 ? headers : null,
      });
    } catch {
      return { error: `An MCP server named "${parsed.data.name}" already exists.` };
    }
    return { ok: true };
  }

  const id = Number(form.get("id"));
  if (!Number.isInteger(id)) return { error: "Invalid server" };

  if (intent === "toggle-enabled") {
    await db
      .update(mcpServers)
      .set({ enabled: form.get("enabled") === "true", updatedAt: new Date() })
      .where(eq(mcpServers.id, id));
    return { ok: true };
  }
  if (intent === "delete") {
    await db.delete(mcpServers).where(eq(mcpServers.id, id));
    return { ok: true };
  }
  return { error: "Unknown action" };
}

export default function AdminMcpServers({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <>
      <Typography variant="h5" sx={{ mb: 2 }}>
        MCP Servers
      </Typography>

      <Paper sx={{ p: 2, mb: 3 }}>
        <Form method="post">
          <input type="hidden" name="intent" value="add" />
          <Stack spacing={2}>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <TextField name="name" label="Name" size="small" required sx={{ minWidth: 180 }} />
              <TextField name="url" label="URL" size="small" required fullWidth />
            </Stack>
            <TextField
              name="headers"
              label='HTTP headers (one "Name: value" per line, e.g. Authorization: Bearer …)'
              size="small"
              multiline
              minRows={2}
              fullWidth
            />
            <Box>
              <Button type="submit" variant="contained" startIcon={<AddIcon />} disabled={busy}>
                Add MCP server
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
              <TableCell>URL</TableCell>
              <TableCell>Headers</TableCell>
              <TableCell>Enabled</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loaderData.servers.map((s) => (
              <TableRow key={s.id} hover>
                <TableCell>{s.name}</TableCell>
                <TableCell sx={{ wordBreak: "break-all" }}>{s.url}</TableCell>
                <TableCell>{s.headerNames.length > 0 ? s.headerNames.join(", ") : "—"}</TableCell>
                <TableCell>
                  <Form method="post">
                    <input type="hidden" name="intent" value="toggle-enabled" />
                    <input type="hidden" name="id" value={s.id} />
                    <input type="hidden" name="enabled" value={String(!s.enabled)} />
                    <Switch
                      checked={s.enabled}
                      size="small"
                      disabled={busy}
                      onChange={(e) => e.target.form?.requestSubmit()}
                      slotProps={{ input: { "aria-label": `enable ${s.name}` } }}
                    />
                  </Form>
                </TableCell>
                <TableCell align="right">
                  <Form
                    method="post"
                    style={{ display: "inline" }}
                    onSubmit={(e) => {
                      if (!confirm(`Delete MCP server "${s.name}"?`)) e.preventDefault();
                    }}
                  >
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="id" value={s.id} />
                    <Tooltip title="Delete">
                      <IconButton type="submit" size="small" disabled={busy}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
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

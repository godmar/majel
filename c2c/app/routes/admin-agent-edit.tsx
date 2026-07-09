import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormGroup from "@mui/material/FormGroup";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { asc, eq } from "drizzle-orm";
import { Form, Link, redirect, useNavigation } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/admin-agent-edit";
import { requireAdmin } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import {
  agentDefinitions,
  agentMcpServers,
  mcpServers,
  providers,
} from "~/lib/schema.server";

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireAdmin(request);
  const isNew = params.agentId === "new";
  const agent = isNew
    ? null
    : await db.query.agentDefinitions.findFirst({
        where: eq(agentDefinitions.id, Number(params.agentId)),
      });
  if (!isNew && !agent) throw new Response("Not found", { status: 404 });

  const allProviders = await db
    .select({ name: providers.name, models: providers.models, enabled: providers.enabled })
    .from(providers)
    .orderBy(asc(providers.name));
  const modelOptions = allProviders
    .filter((p) => p.enabled)
    .flatMap((p) => p.models.map((m) => ({ value: `${p.name}/${m.id}`, label: `${m.name} (${p.name})` })));

  const allMcp = await db
    .select({ id: mcpServers.id, name: mcpServers.name, enabled: mcpServers.enabled })
    .from(mcpServers)
    .orderBy(asc(mcpServers.name));

  const selectedMcp = agent
    ? (
        await db
          .select({ id: agentMcpServers.mcpServerId })
          .from(agentMcpServers)
          .where(eq(agentMcpServers.agentDefinitionId, agent.id))
      ).map((r) => r.id)
    : [];

  return { agent, modelOptions, allMcp, selectedMcp };
}

const formSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().default(""),
  systemPrompt: z.string().trim().min(1, "System prompt is required"),
  model: z.string().trim().min(1, "Model is required"),
  timeoutSeconds: z.coerce.number().int().min(60).max(24 * 3600),
  permissionRead: z.enum(["allow", "ask", "deny"]),
  permissionEdit: z.enum(["allow", "ask", "deny"]),
  permissionBash: z.enum(["allow", "ask", "deny"]),
  autoApprove: z.coerce.boolean(),
  enabled: z.coerce.boolean(),
});

export async function action({ request, params }: Route.ActionArgs) {
  await requireAdmin(request);
  const form = await request.formData();
  const isNew = params.agentId === "new";

  if (form.get("intent") === "delete" && !isNew) {
    try {
      await db.delete(agentDefinitions).where(eq(agentDefinitions.id, Number(params.agentId)));
    } catch {
      return { error: "This agent has tasks referencing it; disable it instead of deleting." };
    }
    throw redirect("/admin/agents");
  }

  const parsed = formSchema.safeParse({
    name: form.get("name"),
    description: form.get("description"),
    systemPrompt: form.get("systemPrompt"),
    model: form.get("model"),
    timeoutSeconds: form.get("timeoutSeconds"),
    permissionRead: form.get("permissionRead") ?? "allow",
    permissionEdit: form.get("permissionEdit") ?? "allow",
    permissionBash: form.get("permissionBash") ?? "allow",
    autoApprove: form.get("autoApprove") === "on",
    enabled: form.get("enabled") === "on",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;
  const values = {
    name: d.name,
    description: d.description,
    systemPrompt: d.systemPrompt,
    model: d.model,
    timeoutSeconds: d.timeoutSeconds,
    permissions: { read: d.permissionRead, edit: d.permissionEdit, bash: d.permissionBash },
    autoApprove: d.autoApprove,
    enabled: d.enabled,
    updatedAt: new Date(),
  };

  let agentId: number;
  try {
    if (isNew) {
      const [row] = await db.insert(agentDefinitions).values(values).returning();
      agentId = row.id;
    } else {
      agentId = Number(params.agentId);
      await db.update(agentDefinitions).set(values).where(eq(agentDefinitions.id, agentId));
    }
  } catch {
    return { error: `An agent named "${d.name}" already exists.` };
  }

  const mcpIds = form.getAll("mcpServerIds").map(Number).filter(Number.isInteger);
  await db.delete(agentMcpServers).where(eq(agentMcpServers.agentDefinitionId, agentId));
  for (const mcpServerId of mcpIds) {
    await db.insert(agentMcpServers).values({ agentDefinitionId: agentId, mcpServerId });
  }

  throw redirect("/admin/agents");
}

export default function AdminAgentEdit({ loaderData, actionData }: Route.ComponentProps) {
  const { agent, modelOptions, allMcp, selectedMcp } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const permissions = (agent?.permissions ?? {}) as Record<string, string>;

  return (
    <Box sx={{ maxWidth: 900 }}>
      <Typography variant="h5" sx={{ mb: 2 }}>
        {agent ? `Edit agent: ${agent.name}` : "New agent"}
      </Typography>
      {actionData?.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {actionData.error}
        </Alert>
      )}
      <Paper sx={{ p: 3 }}>
        <Form method="post">
          <Stack spacing={3}>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <TextField name="name" label="Name" defaultValue={agent?.name ?? ""} required fullWidth />
              <TextField
                name="description"
                label="Description"
                defaultValue={agent?.description ?? ""}
                fullWidth
              />
            </Stack>
            <TextField
              name="systemPrompt"
              label="System prompt"
              defaultValue={agent?.systemPrompt ?? ""}
              required
              multiline
              minRows={6}
              fullWidth
            />
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <TextField
                name="model"
                label="Model"
                select
                defaultValue={agent?.model ?? modelOptions[0]?.value ?? ""}
                required
                fullWidth
              >
                {modelOptions.map((m) => (
                  <MenuItem key={m.value} value={m.value}>
                    {m.label}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                name="timeoutSeconds"
                label="Timeout (seconds)"
                type="number"
                defaultValue={agent?.timeoutSeconds ?? 1800}
                fullWidth
              />
            </Stack>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <TextField
                name="permissionRead"
                label="File read permission"
                select
                defaultValue={permissions.read ?? "allow"}
                fullWidth
              >
                {["allow", "ask", "deny"].map((v) => (
                  <MenuItem key={v} value={v}>
                    {v}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                name="permissionEdit"
                label="File edit permission"
                select
                defaultValue={permissions.edit ?? "allow"}
                fullWidth
              >
                {["allow", "ask", "deny"].map((v) => (
                  <MenuItem key={v} value={v}>
                    {v}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                name="permissionBash"
                label="Shell (bash) permission"
                select
                defaultValue={permissions.bash ?? "allow"}
                fullWidth
              >
                {["allow", "ask", "deny"].map((v) => (
                  <MenuItem key={v} value={v}>
                    {v}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
            <FormControlLabel
              control={<Switch name="autoApprove" defaultChecked={agent?.autoApprove ?? false} />}
              label='Automatically approve all permission requests (YOLO) — without this, any "ask" outcome (including opencode&apos;s built-in guard on secret-looking files) hangs the headless agent until it times out'
            />

            <Box>
              <Typography variant="subtitle2" gutterBottom>
                MCP servers available to this agent
              </Typography>
              <FormGroup row>
                {allMcp.map((m) => (
                  <FormControlLabel
                    key={m.id}
                    control={
                      <Checkbox
                        name="mcpServerIds"
                        value={m.id}
                        defaultChecked={selectedMcp.includes(m.id)}
                      />
                    }
                    label={m.enabled ? m.name : `${m.name} (disabled)`}
                  />
                ))}
                {allMcp.length === 0 && (
                  <Typography color="text.secondary">No MCP servers configured.</Typography>
                )}
              </FormGroup>
            </Box>

            <FormControlLabel
              control={<Switch name="enabled" defaultChecked={agent?.enabled ?? true} />}
              label="Enabled (visible to users)"
            />

            <Stack direction="row" spacing={2}>
              <Button type="submit" variant="contained" disabled={busy}>
                {agent ? "Save changes" : "Create agent"}
              </Button>
              <Button component={Link} to="/admin/agents" color="inherit">
                Cancel
              </Button>
              <Box sx={{ flexGrow: 1 }} />
              {agent && (
                <Button
                  type="submit"
                  name="intent"
                  value="delete"
                  color="error"
                  disabled={busy}
                  onClick={(e) => {
                    if (!confirm(`Delete agent "${agent.name}"?`)) {
                      e.preventDefault();
                    }
                  }}
                >
                  Delete
                </Button>
              )}
            </Stack>
          </Stack>
        </Form>
      </Paper>
    </Box>
  );
}

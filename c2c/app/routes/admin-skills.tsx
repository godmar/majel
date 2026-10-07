import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import { asc, eq, sql } from "drizzle-orm";
import { Form, Link as RouterLink, useNavigation } from "react-router";
import type { Route } from "./+types/admin-skills";
import { requireAdmin } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { agentDefinitions, agentSkills, skillFiles, skills } from "~/lib/schema.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const rows = await db
    .select({
      id: skills.id,
      name: skills.name,
      description: skills.description,
      enabled: skills.enabled,
      updatedAt: skills.updatedAt,
      fileCount: sql<number>`(select count(*)::int from ${skillFiles} where ${skillFiles.skillId} = ${skills.id})`,
    })
    .from(skills)
    .orderBy(asc(skills.name));
  const grants = await db
    .select({ skillId: agentSkills.skillId, agentName: agentDefinitions.name })
    .from(agentSkills)
    .innerJoin(agentDefinitions, eq(agentSkills.agentDefinitionId, agentDefinitions.id))
    .orderBy(asc(agentDefinitions.name));
  return {
    skills: rows.map((r) => ({
      ...r,
      agents: grants.filter((g) => g.skillId === r.id).map((g) => g.agentName),
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  await requireAdmin(request);
  const form = await request.formData();
  const id = Number(form.get("id"));
  if (!Number.isInteger(id)) return { error: "Invalid skill" };

  if (form.get("intent") === "toggle-enabled") {
    await db
      .update(skills)
      .set({ enabled: form.get("enabled") === "true", updatedAt: new Date() })
      .where(eq(skills.id, id));
  } else if (form.get("intent") === "delete") {
    await db.delete(skills).where(eq(skills.id, id));
  }
  return { error: null };
}

export default function AdminSkills({ loaderData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
        <Typography variant="h5">Skills</Typography>
        <Button
          component={RouterLink}
          to="/admin/skills/new"
          variant="contained"
          startIcon={<AddIcon />}
        >
          New Skill
        </Button>
      </Box>
      <Typography color="text.secondary" sx={{ mb: 2, maxWidth: 900 }}>
        A skill is a set of instructions an agent can load when a task calls for it. The agent
        always sees each skill's name and description, and reads the full instructions only when
        it decides the skill applies, so skills add know-how without lengthening every prompt.
        Grant skills to agents on each agent's page; a disabled skill is withheld from every
        agent. See the{" "}
        <Link href="https://opencode.ai/docs/skills/" target="_blank" rel="noreferrer">
          opencode skills documentation
        </Link>
        .
      </Typography>

      <TableContainer component={Paper}>
        <Table size="small" sx={{ minWidth: 650 }}>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Description</TableCell>
              <TableCell>Files</TableCell>
              <TableCell>Used by</TableCell>
              <TableCell>Enabled</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loaderData.skills.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <Typography color="text.secondary" sx={{ py: 2, textAlign: "center" }}>
                    No skills yet.
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {loaderData.skills.map((sk) => (
              <TableRow key={sk.id} hover>
                <TableCell sx={{ whiteSpace: "nowrap", fontFamily: "monospace" }}>
                  <Link component={RouterLink} to={`/admin/skills/${sk.id}`} underline="hover">
                    {sk.name}
                  </Link>
                </TableCell>
                <TableCell
                  title={sk.description}
                  sx={{
                    maxWidth: 420,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {sk.description}
                </TableCell>
                <TableCell>{sk.fileCount > 0 ? sk.fileCount : "—"}</TableCell>
                <TableCell>
                  {sk.agents.length > 0 ? (
                    sk.agents.join(", ")
                  ) : (
                    <Typography component="span" variant="body2" color="text.secondary">
                      no agents
                    </Typography>
                  )}
                </TableCell>
                <TableCell>
                  <Form method="post">
                    <input type="hidden" name="intent" value="toggle-enabled" />
                    <input type="hidden" name="id" value={sk.id} />
                    <input type="hidden" name="enabled" value={String(!sk.enabled)} />
                    <Switch
                      checked={sk.enabled}
                      size="small"
                      disabled={busy}
                      onChange={(e) => e.target.form?.requestSubmit()}
                      slotProps={{ input: { "aria-label": `enable ${sk.name}` } }}
                    />
                  </Form>
                </TableCell>
                <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                  <Tooltip title="Edit">
                    <IconButton size="small" component={RouterLink} to={`/admin/skills/${sk.id}`}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Form
                    method="post"
                    style={{ display: "inline" }}
                    onSubmit={(e) => {
                      const used = sk.agents.length > 0 ? ` It is used by ${sk.agents.join(", ")}.` : "";
                      if (!confirm(`Delete skill "${sk.name}"?${used}`)) e.preventDefault();
                    }}
                  >
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="id" value={sk.id} />
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

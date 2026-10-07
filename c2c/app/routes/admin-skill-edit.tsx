import * as React from "react";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormGroup from "@mui/material/FormGroup";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/admin-skill-edit";
import MarkdownView from "~/components/MarkdownView";
import SkillFilesEditor, {
  editableFiles,
  filesErrors,
  filesManifest,
  totalFileBytes,
  type EditableSkillFile,
} from "~/components/SkillFilesEditor";
import { requireAdmin } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { agentDefinitions, agentSkills, skillFiles, skills } from "~/lib/schema.server";
import {
  FRONTMATTER_HELP,
  isTextContent,
  MAX_SKILL_FILES_BYTES,
  renderSkillMarkdown,
  SKILL_NAME_RE,
  skillFilePathError,
  skillSchema,
} from "~/lib/skills";

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireAdmin(request);
  const isNew = params.skillId === "new";
  const skill = isNew
    ? null
    : await db.query.skills.findFirst({ where: eq(skills.id, Number(params.skillId)) });
  if (!isNew && !skill) throw new Response("Not found", { status: 404 });

  const agents = await db
    .select({ id: agentDefinitions.id, name: agentDefinitions.name, enabled: agentDefinitions.enabled })
    .from(agentDefinitions)
    .orderBy(asc(agentDefinitions.name));
  const grantedTo = skill
    ? (
        await db
          .select({ id: agentSkills.agentDefinitionId })
          .from(agentSkills)
          .where(eq(agentSkills.skillId, skill.id))
      ).map((r) => r.id)
    : [];

  const files = skill
    ? (
        await db
          .select()
          .from(skillFiles)
          .where(eq(skillFiles.skillId, skill.id))
          .orderBy(asc(skillFiles.path))
      ).map((f) => ({
        id: f.id,
        path: f.path,
        executable: f.executable,
        sizeBytes: f.sizeBytes,
        text: isTextContent(f.content) ? f.content.toString("utf8") : null,
      }))
    : [];

  return { skill, agents, grantedTo, files };
}

// The editor sends every file to keep; content only for new or edited ones.
const filesManifestSchema = z.array(
  z.object({
    id: z.number().int().nullable(),
    path: z.string().trim(),
    executable: z.boolean(),
    text: z.string().optional(),
    base64: z.string().optional(),
  }),
);

export async function action({ request, params }: Route.ActionArgs) {
  await requireAdmin(request);
  const form = await request.formData();
  const isNew = params.skillId === "new";

  if (form.get("intent") === "delete" && !isNew) {
    await db.delete(skills).where(eq(skills.id, Number(params.skillId)));
    throw redirect("/admin/skills");
  }

  let metadata: unknown;
  let manifestJson: unknown;
  try {
    metadata = JSON.parse(String(form.get("metadata") ?? "{}"));
    manifestJson = JSON.parse(String(form.get("files") ?? "[]"));
  } catch {
    return { error: "The form could not be read; please reload and try again." };
  }
  const manifest = filesManifestSchema.safeParse(manifestJson);
  if (!manifest.success) return { error: "The file list could not be read; please reload." };
  const parsed = skillSchema.safeParse({
    name: form.get("name") ?? "",
    description: form.get("description") ?? "",
    license: form.get("license") ?? "",
    compatibility: form.get("compatibility") ?? "",
    metadata,
    body: form.get("body") ?? "",
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const values = {
    ...parsed.data,
    enabled: form.get("enabled") === "on",
    updatedAt: new Date(),
  };

  // Resolve every file to its bytes: new or edited ones from the form,
  // unchanged ones from what is saved (which must belong to this skill).
  const saved = isNew
    ? []
    : await db.select().from(skillFiles).where(eq(skillFiles.skillId, Number(params.skillId)));
  const files: { path: string; content: Buffer; executable: boolean }[] = [];
  for (const f of manifest.data) {
    const pathError = skillFilePathError(f.path);
    if (pathError) return { error: `${f.path || "A file"}: ${pathError}` };
    if (files.some((g) => g.path === f.path)) return { error: `Two files are named ${f.path}.` };
    let content: Buffer | undefined;
    if (f.text !== undefined) content = Buffer.from(f.text, "utf8");
    else if (f.base64 !== undefined) content = Buffer.from(f.base64, "base64");
    else content = saved.find((s) => s.id === f.id)?.content;
    if (!content) return { error: `${f.path}: its content is missing; please re-add it.` };
    files.push({ path: f.path, content, executable: f.executable });
  }
  const totalBytes = files.reduce((n, f) => n + f.content.length, 0);
  if (totalBytes > MAX_SKILL_FILES_BYTES) {
    return {
      error: `Supporting files total ${Math.round(totalBytes / 1024)} KB; the limit is ${MAX_SKILL_FILES_BYTES / 1024} KB.`,
    };
  }

  const agentIds = form.getAll("agentIds").map(Number).filter(Number.isInteger);
  try {
    await db.transaction(async (tx) => {
      let skillId: number;
      if (isNew) {
        const [row] = await tx.insert(skills).values(values).returning({ id: skills.id });
        skillId = row.id;
      } else {
        skillId = Number(params.skillId);
        await tx.update(skills).set(values).where(eq(skills.id, skillId));
      }
      // Replace rather than diff: renames can swap paths, which a row-by-row
      // update would trip over on the unique (skill, path) index.
      await tx.delete(skillFiles).where(eq(skillFiles.skillId, skillId));
      if (files.length > 0) {
        await tx.insert(skillFiles).values(
          files.map((f) => ({ skillId, ...f, sizeBytes: f.content.length })),
        );
      }
      await tx.delete(agentSkills).where(eq(agentSkills.skillId, skillId));
      if (agentIds.length > 0) {
        await tx
          .insert(agentSkills)
          .values(agentIds.map((agentDefinitionId) => ({ agentDefinitionId, skillId })));
      }
    });
  } catch (err) {
    // node-postgres reports the violated constraint; drizzle may wrap it.
    const pgError = (err as { cause?: { constraint?: string } })?.cause ?? (err as { constraint?: string });
    if (pgError?.constraint === "skills_name_unique") {
      return { error: `A skill named "${values.name}" already exists.` };
    }
    throw err;
  }

  throw redirect("/admin/skills");
}

interface MetaRow {
  key: string;
  value: string;
}

/** A field's label plus the explanation of what that frontmatter entry means. */
function FieldHelp({ field, children }: { field: string; children: React.ReactNode }) {
  return (
    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
      <Box component="code" sx={{ fontWeight: 600, mr: 0.75 }}>
        {field}
      </Box>
      {children}
    </Typography>
  );
}

export default function AdminSkillEdit({ loaderData, actionData }: Route.ComponentProps) {
  const { skill, agents, grantedTo, files: savedFiles } = loaderData;
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const [name, setName] = React.useState(skill?.name ?? "");
  const [description, setDescription] = React.useState(skill?.description ?? "");
  const [license, setLicense] = React.useState(skill?.license ?? "");
  const [compatibility, setCompatibility] = React.useState(skill?.compatibility ?? "");
  const [meta, setMeta] = React.useState<MetaRow[]>(
    Object.entries(skill?.metadata ?? {}).map(([key, value]) => ({ key, value })),
  );
  const [body, setBody] = React.useState(skill?.body ?? "");
  const [bodyTab, setBodyTab] = React.useState<"write" | "preview">("write");
  const [files, setFiles] = React.useState<EditableSkillFile[]>(() => editableFiles(savedFiles));
  const filesBlocked =
    filesErrors(files).size > 0 || totalFileBytes(files) > MAX_SKILL_FILES_BYTES;

  const nameError =
    name.length > 64
      ? "At most 64 characters."
      : name && !SKILL_NAME_RE.test(name)
        ? "Use lowercase letters and digits, with single hyphens between words, e.g. my-skill."
        : null;
  const metadata = Object.fromEntries(
    meta.filter((m) => m.key.trim()).map((m) => [m.key.trim(), m.value]),
  );
  const skillMd = renderSkillMarkdown({
    name: name || "skill-name",
    description,
    license: license.trim() || null,
    compatibility: compatibility.trim() || null,
    metadata,
    body,
  });

  const updateMeta = (i: number, patch: Partial<MetaRow>) =>
    setMeta((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Box sx={{ maxWidth: 1000 }}>
      <Typography variant="h5" sx={{ mb: 2 }}>
        {skill ? `Edit skill: ${skill.name}` : "New skill"}
      </Typography>

      <Alert severity="info" sx={{ mb: 2 }}>
        Each skill becomes a <code>SKILL.md</code> file in the agent's sandbox. The{" "}
        <strong>frontmatter</strong> (name, description and the optional fields) is listed to the
        agent at the start of every task; the <strong>instructions</strong> are read only when the
        agent decides to use the skill. A good description is therefore what makes a skill get
        used at the right time.
      </Alert>

      {actionData?.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {actionData.error}
        </Alert>
      )}

      <Paper sx={{ p: 3 }}>
        <Form method="post">
          <input type="hidden" name="metadata" value={JSON.stringify(metadata)} />
          <input type="hidden" name="body" value={body} />
          <input type="hidden" name="files" value={filesManifest(files)} />
          <Stack spacing={3}>
            <Typography variant="subtitle1">Frontmatter</Typography>

            <Box>
              <TextField
                name="name"
                label="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                fullWidth
                error={Boolean(nameError)}
                helperText={nameError ?? `${name.length}/64`}
                slotProps={{ htmlInput: { style: { fontFamily: "monospace" }, spellCheck: false } }}
              />
              <FieldHelp field="name">{FRONTMATTER_HELP.name}</FieldHelp>
            </Box>

            <Box>
              <TextField
                name="description"
                label="Description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
                fullWidth
                multiline
                minRows={2}
                error={description.length > 1024}
                helperText={`${description.length}/1024`}
              />
              <FieldHelp field="description">{FRONTMATTER_HELP.description}</FieldHelp>
            </Box>

            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <Box sx={{ flex: 1 }}>
                <TextField
                  name="license"
                  label="License (optional)"
                  placeholder="MIT"
                  value={license}
                  onChange={(e) => setLicense(e.target.value)}
                  fullWidth
                />
                <FieldHelp field="license">{FRONTMATTER_HELP.license}</FieldHelp>
              </Box>
              <Box sx={{ flex: 1 }}>
                <TextField
                  name="compatibility"
                  label="Compatibility (optional)"
                  placeholder="opencode"
                  value={compatibility}
                  onChange={(e) => setCompatibility(e.target.value)}
                  fullWidth
                />
                <FieldHelp field="compatibility">{FRONTMATTER_HELP.compatibility}</FieldHelp>
              </Box>
            </Stack>

            <Box>
              <Typography variant="body1" gutterBottom>
                Metadata (optional)
              </Typography>
              <Stack spacing={1}>
                {meta.map((row, i) => (
                  <Stack key={i} direction="row" spacing={1} sx={{ alignItems: "center" }}>
                    <TextField
                      size="small"
                      label="Key"
                      value={row.key}
                      onChange={(e) => updateMeta(i, { key: e.target.value })}
                      sx={{ width: 220 }}
                    />
                    <TextField
                      size="small"
                      label="Value"
                      value={row.value}
                      onChange={(e) => updateMeta(i, { value: e.target.value })}
                      fullWidth
                    />
                    <Tooltip title="Remove">
                      <IconButton
                        size="small"
                        onClick={() => setMeta((rows) => rows.filter((_r, j) => j !== i))}
                        aria-label={`remove metadata ${row.key}`}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                ))}
              </Stack>
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={() => setMeta((rows) => [...rows, { key: "", value: "" }])}
                sx={{ mt: 1 }}
              >
                Add entry
              </Button>
              <FieldHelp field="metadata">{FRONTMATTER_HELP.metadata}</FieldHelp>
            </Box>

            <Box>
              <Typography variant="subtitle1">Instructions</Typography>
              <Tabs
                value={bodyTab}
                onChange={(_e, v) => setBodyTab(v)}
                sx={{ mb: 1, minHeight: 36, "& .MuiTab-root": { minHeight: 36 } }}
              >
                <Tab value="write" label="Write" />
                <Tab value="preview" label="Preview" />
              </Tabs>
              {bodyTab === "write" ? (
                <TextField
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  required
                  fullWidth
                  multiline
                  minRows={14}
                  placeholder={"# What this skill is for\n\n## Steps\n1. …\n\n## Rules\n- …"}
                  slotProps={{
                    htmlInput: { style: { fontFamily: "monospace", fontSize: 14 }, spellCheck: false },
                  }}
                />
              ) : (
                <Paper variant="outlined" sx={{ p: 2, minHeight: 200 }}>
                  {body.trim() ? (
                    <MarkdownView>{body}</MarkdownView>
                  ) : (
                    <Typography color="text.secondary">Nothing to preview yet.</Typography>
                  )}
                </Paper>
              )}
              <FieldHelp field="body">{FRONTMATTER_HELP.body}</FieldHelp>
            </Box>

            <SkillFilesEditor
              skillId={skill?.id ?? null}
              files={files}
              setFiles={setFiles}
              body={body}
            />

            <Accordion variant="outlined" disableGutters>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="body2">
                  Show the generated <code>SKILL.md</code> and folder
                </Typography>
              </AccordionSummary>
              <AccordionDetails>
                <Typography variant="body2" color="text.secondary" gutterBottom>
                  In the agent's sandbox, read-only:
                </Typography>
                <Box
                  component="pre"
                  sx={{ m: 0, mb: 2, fontSize: 13, overflowX: "auto" }}
                >
                  {[
                    `~/.config/opencode/skills/${name || "skill-name"}/`,
                    "  SKILL.md",
                    ...files
                      .map((f) => f.path.trim())
                      .filter(Boolean)
                      .sort()
                      .map((p) => `  ${p}`),
                  ].join("\n")}
                </Box>
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    p: 1.5,
                    borderRadius: 1,
                    bgcolor: "action.hover",
                    fontSize: 13,
                    overflowX: "auto",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {skillMd}
                </Box>
              </AccordionDetails>
            </Accordion>

            <Box>
              <Typography variant="subtitle1" gutterBottom>
                Agents that may use this skill
              </Typography>
              <FormGroup row>
                {agents.map((a) => (
                  <FormControlLabel
                    key={a.id}
                    control={
                      <Checkbox
                        name="agentIds"
                        value={a.id}
                        defaultChecked={grantedTo.includes(a.id)}
                      />
                    }
                    label={a.enabled ? a.name : `${a.name} (disabled)`}
                  />
                ))}
                {agents.length === 0 && (
                  <Typography color="text.secondary">No agents configured.</Typography>
                )}
              </FormGroup>
            </Box>

            <FormControlLabel
              control={<Switch name="enabled" defaultChecked={skill?.enabled ?? true} />}
              label="Enabled (a disabled skill is withheld from every agent)"
            />

            <Stack direction="row" spacing={2}>
              <Button
                type="submit"
                variant="contained"
                disabled={busy || Boolean(nameError) || description.length > 1024 || filesBlocked}
              >
                {skill ? "Save changes" : "Create skill"}
              </Button>
              <Button component={Link} to="/admin/skills" color="inherit">
                Cancel
              </Button>
              <Box sx={{ flexGrow: 1 }} />
              {skill && (
                <Button
                  type="submit"
                  name="intent"
                  value="delete"
                  color="error"
                  disabled={busy}
                  formNoValidate
                  onClick={(e) => {
                    if (!confirm(`Delete skill "${skill.name}"?`)) e.preventDefault();
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

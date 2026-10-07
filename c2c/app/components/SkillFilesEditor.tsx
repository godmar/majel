import * as React from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Collapse from "@mui/material/Collapse";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import DownloadIcon from "@mui/icons-material/Download";
import EditNoteIcon from "@mui/icons-material/EditNote";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import {
  defaultSkillFilePath,
  FILES_HELP,
  isTextContent,
  MAX_SKILL_FILES_BYTES,
  skillFilePathError,
} from "~/lib/skills";

/** One supporting file as the editor holds it. */
export interface EditableSkillFile {
  /** React key; stable across renames. */
  key: string;
  /** Database id of a saved file, null for one added in this session. */
  id: number | null;
  path: string;
  executable: boolean;
  /** Content of a text file (editable inline); null for a binary file. */
  text: string | null;
  /** Content of a binary file uploaded in this session. */
  base64: string | null;
  size: number;
  /** Content differs from what is saved, so it must be sent. */
  dirty: boolean;
  open: boolean;
}

/** Saved files as the loader returns them. */
export function editableFiles(
  files: { id: number; path: string; executable: boolean; sizeBytes: number; text: string | null }[],
): EditableSkillFile[] {
  return files.map((f) => ({
    key: `saved-${f.id}`,
    id: f.id,
    path: f.path,
    executable: f.executable,
    text: f.text,
    base64: null,
    size: f.sizeBytes,
    dirty: false,
    open: false,
  }));
}

/**
 * What the form submits: every file to keep, with content only where it
 * changed — unchanged saved files are referenced by id and keep their bytes.
 */
export function filesManifest(files: EditableSkillFile[]): string {
  return JSON.stringify(
    files.map((f) => ({
      id: f.id,
      path: f.path.trim(),
      executable: f.executable,
      ...(f.id === null || f.dirty
        ? f.text !== null
          ? { text: f.text }
          : { base64: f.base64 }
        : {}),
    })),
  );
}

/** Problems that must block saving: bad paths, duplicates, too large. */
export function filesErrors(files: EditableSkillFile[]): Map<string, string> {
  const errors = new Map<string, string>();
  const seen = new Set<string>();
  for (const f of files) {
    const path = f.path.trim();
    const err = skillFilePathError(path);
    if (err) errors.set(f.key, err);
    else if (seen.has(path)) errors.set(f.key, "Another file already has this path");
    seen.add(path);
  }
  return errors;
}

export const totalFileBytes = (files: EditableSkillFile[]) => files.reduce((n, f) => n + f.size, 0);

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
}

let nextKey = 0;

export default function SkillFilesEditor({
  skillId,
  files,
  setFiles,
  body,
}: {
  skillId: number | null;
  files: EditableSkillFile[];
  setFiles: React.Dispatch<React.SetStateAction<EditableSkillFile[]>>;
  /** The instructions, to point out files they never mention. */
  body: string;
}) {
  const uploadRef = React.useRef<HTMLInputElement>(null);
  const errors = filesErrors(files);
  const total = totalFileBytes(files);

  const update = (key: string, patch: Partial<EditableSkillFile>) =>
    setFiles((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const addTextFile = () =>
    setFiles((rows) => [
      ...rows,
      {
        key: `new-${nextKey++}`,
        id: null,
        path: "scripts/new-script.py",
        executable: false,
        text: "",
        base64: null,
        size: 0,
        dirty: true,
        open: true,
      },
    ]);

  const addUploads = async (list: FileList | null) => {
    const added: EditableSkillFile[] = [];
    for (const file of Array.from(list ?? [])) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = isTextContent(bytes) ? new TextDecoder().decode(bytes) : null;
      added.push({
        key: `new-${nextKey++}`,
        id: null,
        path: defaultSkillFilePath(file.name),
        // A shebang says the file is meant to be run as a program.
        executable: text?.startsWith("#!") ?? false,
        text,
        base64: text === null ? toBase64(bytes) : null,
        size: bytes.length,
        dirty: true,
        open: false,
      });
    }
    setFiles((rows) => [...rows, ...added]);
    if (uploadRef.current) uploadRef.current.value = "";
  };

  return (
    <Box>
      <Typography variant="subtitle1">Supporting files (optional)</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {FILES_HELP}
      </Typography>

      <Stack spacing={1}>
        {files.map((f) => {
          const error = errors.get(f.key);
          const path = f.path.trim();
          const unmentioned = !error && path && !body.includes(path);
          return (
            <Paper key={f.key} variant="outlined" sx={{ p: 1.5 }}>
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { sm: "flex-start" } }}>
                <TextField
                  size="small"
                  label="Path"
                  value={f.path}
                  onChange={(e) => update(f.key, { path: e.target.value })}
                  error={Boolean(error)}
                  helperText={
                    error ??
                    (unmentioned
                      ? `Not mentioned in the instructions — refer to it as ${path} so the agent knows when to use it.`
                      : `${f.text !== null ? "Text" : "Binary"}, ${formatBytes(f.size)}`)
                  }
                  slotProps={{
                    htmlInput: { style: { fontFamily: "monospace" }, spellCheck: false },
                    formHelperText: unmentioned ? { sx: { color: "warning.main" } } : undefined,
                  }}
                  sx={{ flexGrow: 1 }}
                />
                <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", pt: { sm: 0.5 } }}>
                  <Tooltip
                    describeChild
                    title="Mark scripts the agent runs directly, as ./scripts/name. Not needed for python3 scripts/name.py."
                  >
                    <FormControlLabel
                      control={
                        <Switch
                          size="small"
                          checked={f.executable}
                          onChange={(e) => update(f.key, { executable: e.target.checked })}
                          slotProps={{ input: { "aria-label": `${f.path} is executable` } }}
                        />
                      }
                      label="Executable"
                      sx={{ mr: 1 }}
                    />
                  </Tooltip>
                  {f.text !== null ? (
                    <Tooltip title={f.open ? "Hide content" : "Edit content"}>
                      <IconButton
                        size="small"
                        onClick={() => update(f.key, { open: !f.open })}
                        aria-label={`edit ${f.path}`}
                      >
                        <EditNoteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : (
                    <Tooltip title="Binary files can't be edited here; upload a new version instead">
                      <span>
                        <IconButton size="small" disabled aria-label={`${f.path} is binary`}>
                          <EditNoteIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  )}
                  {f.id !== null && skillId !== null && (
                    <Tooltip title="Download">
                      <IconButton
                        size="small"
                        href={`/admin/skills/${skillId}/files/${f.id}`}
                        aria-label={`download ${f.path}`}
                      >
                        <DownloadIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  )}
                  <Tooltip title="Remove">
                    <IconButton
                      size="small"
                      onClick={() => setFiles((rows) => rows.filter((r) => r.key !== f.key))}
                      aria-label={`remove ${f.path}`}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>
              {f.text !== null && (
                <Collapse in={f.open} unmountOnExit>
                  <TextField
                    value={f.text}
                    onChange={(e) =>
                      update(f.key, { text: e.target.value, size: utf8Length(e.target.value), dirty: true })
                    }
                    fullWidth
                    multiline
                    minRows={8}
                    maxRows={30}
                    sx={{ mt: 1.5 }}
                    slotProps={{
                      htmlInput: {
                        style: { fontFamily: "monospace", fontSize: 13 },
                        spellCheck: false,
                        "aria-label": `content of ${f.path}`,
                      },
                    }}
                  />
                </Collapse>
              )}
            </Paper>
          );
        })}
      </Stack>

      <Stack direction="row" spacing={1} sx={{ mt: 1, alignItems: "center", flexWrap: "wrap" }}>
        <Button size="small" startIcon={<AddIcon />} onClick={addTextFile}>
          New text file
        </Button>
        <Button size="small" startIcon={<UploadFileIcon />} onClick={() => uploadRef.current?.click()}>
          Upload files
        </Button>
        <input ref={uploadRef} type="file" multiple hidden onChange={(e) => addUploads(e.target.files)} />
        <Box sx={{ flexGrow: 1 }} />
        {files.length > 0 && (
          <Box sx={{ minWidth: 200 }}>
            <Typography
              variant="caption"
              color={total > MAX_SKILL_FILES_BYTES ? "error" : "text.secondary"}
            >
              {formatBytes(total)} of {formatBytes(MAX_SKILL_FILES_BYTES)}
              {total > MAX_SKILL_FILES_BYTES && " — too large; remove or trim files"}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={Math.min(100, (total / MAX_SKILL_FILES_BYTES) * 100)}
              color={total > MAX_SKILL_FILES_BYTES ? "error" : "primary"}
              aria-label="supporting files size"
            />
          </Box>
        )}
      </Stack>
    </Box>
  );
}

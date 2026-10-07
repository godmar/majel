/**
 * Agent Skills (https://opencode.ai/docs/skills/), shared by the admin UI and
 * the pod config renderer. A skill is one SKILL.md: YAML frontmatter, which
 * opencode shows the agent up front, and a markdown body the agent reads only
 * when it decides to load the skill.
 */
import { z } from "zod";

// opencode refuses a skill whose name breaks this, and the name must also be
// its directory name; both are enforced here so a bad one never reaches a pod.
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface SkillFields {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  body: string;
}

/** What each frontmatter entry means, shown next to its field in the editor. */
export const FRONTMATTER_HELP = {
  name:
    "The skill's identifier — the agent loads it by this name. 1–64 characters: " +
    "lowercase letters and digits, with single hyphens between words " +
    "(e.g. xlsx-deliverable). Required.",
  description:
    "The only part the agent sees before loading the skill, so it decides " +
    "from this alone whether the skill applies. Say what the skill does and " +
    'when to use it ("Use whenever the task asks for…"). Up to 1024 characters. Required.',
  license:
    'License the skill\'s content is shared under, e.g. "MIT" or "CC-BY-4.0". ' +
    "Informational only; leave empty for internal skills.",
  compatibility:
    'Environment the skill is written for, e.g. "opencode". Informational ' +
    "only; opencode loads the skill either way.",
  metadata:
    "Free-form key/value pairs for your own bookkeeping (owner, version, " +
    "audience). Strings only. The agent sees them, but nothing acts on them.",
  body:
    "The instructions the agent follows once it loads the skill, in Markdown. " +
    "Write them for the agent: concrete steps, rules, and examples. They cost " +
    "context only when the skill is used, so they can be as long as they need to be.",
} as const;

/** How the editor explains supporting files. */
export const FILES_HELP =
  "Scripts, reference documents and templates that ship with the skill. When the " +
  "agent loads the skill it is told the skill's folder and shown a list of these " +
  "files, so mention each one in the instructions by its path and say when to use " +
  "it — e.g. \"run python3 scripts/check.py on the result\". A script costs the " +
  "agent nothing until it runs, and the agent sees only its output, so prefer a " +
  "file over pasting a long script into the instructions. Files are read-only in " +
  "the sandbox: scripts should write into the agent's working directory.";

/**
 * Supporting files of one skill, together. They travel to the pod inside the
 * task's Kubernetes Secret, which is capped at 1 MiB including the rest of
 * the task's config, so this is per skill and the launch checks the total.
 */
export const MAX_SKILL_FILES_BYTES = 256 * 1024;

const PATH_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * Why a supporting-file path is unusable, or null if it is fine. Paths are
 * relative to the skill's folder: letters, digits, "._-" and "/" between
 * folders, so nothing can land outside the folder or hide as a dotfile.
 */
export function skillFilePathError(path: string): string | null {
  if (!path) return "Path is required";
  if (path.length > 200) return "Path must be at most 200 characters";
  const segments = path.split("/");
  if (segments.length > 5) return "Path may be at most 5 folders deep";
  if (!segments.every((seg) => PATH_SEGMENT_RE.test(seg))) {
    return 'Use letters, digits, ".", "_" and "-", with "/" between folders (e.g. scripts/check.py)';
  }
  if (path === "SKILL.md") return "SKILL.md is generated from the fields above";
  return null;
}

/** Where an uploaded file goes by default, by the usual skill layout. */
export function defaultSkillFilePath(filename: string): string {
  const base = filename.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "file";
  const ext = base.slice(base.lastIndexOf(".") + 1).toLowerCase();
  if (["py", "sh", "js", "mjs", "r", "pl", "rb", "sql", "jq"].includes(ext)) return `scripts/${base}`;
  if (["md", "txt", "csv", "tsv", "json", "xml", "yaml", "yml", "html"].includes(ext)) {
    return `reference/${base}`;
  }
  return `assets/${base}`;
}

/** UTF-8 text without NULs: shown and edited inline rather than as a blob. */
export function isTextContent(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export const skillSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(64, "Name must be at most 64 characters")
    .regex(
      SKILL_NAME_RE,
      "Name must be lowercase letters and digits, with single hyphens between words (e.g. my-skill)",
    ),
  description: z
    .string()
    .trim()
    .min(1, "Description is required")
    .max(1024, "Description must be at most 1024 characters"),
  license: z
    .string()
    .trim()
    .max(200)
    .transform((s) => s || null),
  compatibility: z
    .string()
    .trim()
    .max(500)
    .transform((s) => s || null),
  metadata: z.record(z.string(), z.string()),
  body: z.string().trim().min(1, "Instructions are required"),
});

/**
 * A YAML double-quoted scalar. JSON's string escapes are a subset of YAML's,
 * so this is always valid and never reinterpreted (no `yes`→true, no `#`
 * comments, no multi-line surprises).
 */
function yamlString(s: string): string {
  return JSON.stringify(s);
}

/** The SKILL.md opencode reads, frontmatter and body. */
export function renderSkillMarkdown(skill: SkillFields): string {
  const lines = ["---", `name: ${skill.name}`, `description: ${yamlString(skill.description)}`];
  if (skill.license) lines.push(`license: ${yamlString(skill.license)}`);
  if (skill.compatibility) lines.push(`compatibility: ${yamlString(skill.compatibility)}`);
  const meta = Object.entries(skill.metadata);
  if (meta.length > 0) {
    lines.push("metadata:");
    for (const [k, v] of meta) lines.push(`  ${yamlString(k)}: ${yamlString(v)}`);
  }
  lines.push("---", "", skill.body.trim(), "");
  return lines.join("\n");
}

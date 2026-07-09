import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { TaskStatus } from "./task-status";

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name"),
  email: text("email"),
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

export const mcpServers = pgTable("mcp_servers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  type: text("type", { enum: ["remote"] }).notNull().default("remote"),
  url: text("url").notNull(),
  headers: jsonb("headers").$type<Record<string, string>>(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface ProviderModel {
  id: string;
  name: string;
  contextLimit?: number;
  outputLimit?: number;
}

// Providers carry no API key: keys are strictly per user (user_provider_keys).
export const providers = pgTable("providers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  displayName: text("display_name"),
  npm: text("npm").notNull().default("@ai-sdk/openai-compatible"),
  baseUrl: text("base_url").notNull(),
  models: jsonb("models").$type<ProviderModel[]>().notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// LLM API keys are per person: the same provider is reached with the
// requesting user's own credential.
export const userProviderKeys = pgTable(
  "user_provider_keys",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: integer("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    apiKey: text("api_key").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.providerId] })],
);

export const agentDefinitions = pgTable("agent_definitions", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  systemPrompt: text("system_prompt").notNull(),
  model: text("model").notNull(), // "<provider>/<modelID>"
  permissions: jsonb("permissions")
    .$type<Record<string, string>>()
    .notNull()
    .default({ edit: "allow", bash: "allow" }),
  timeoutSeconds: integer("timeout_seconds").notNull().default(1800),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentMcpServers = pgTable(
  "agent_mcp_servers",
  {
    agentDefinitionId: integer("agent_definition_id")
      .notNull()
      .references(() => agentDefinitions.id, { onDelete: "cascade" }),
    mcpServerId: integer("mcp_server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.agentDefinitionId, t.mcpServerId] })],
);

export type { TaskStatus };

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentDefinitionId: integer("agent_definition_id")
    .notNull()
    .references(() => agentDefinitions.id),
  createdBy: integer("created_by").references(() => users.id),
  triggerSource: text("trigger_source", { enum: ["web", "api"] }).notNull().default("web"),
  prompt: text("prompt").notNull(),
  modelOverride: text("model_override"),
  status: text("status")
    .$type<TaskStatus>()
    .notNull()
    .default("pending"),
  k8sJobName: text("k8s_job_name"),
  opencodeSessionId: text("opencode_session_id"),
  resultText: text("result_text"),
  transcript: jsonb("transcript"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  // Archived tasks are hidden from the default list view but kept forever.
  archivedAt: timestamp("archived_at", { withTimezone: true }),
}, (t) => [
  index("tasks_created_by_idx").on(t.createdBy, t.createdAt.desc()),
  index("tasks_status_idx").on(t.status),
]);

export const taskFiles = pgTable("task_files", {
  id: serial("id").primaryKey(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["input", "output"] }).notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull().default("application/octet-stream"),
  sizeBytes: integer("size_bytes").notNull(),
  content: bytea("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("task_files_task_idx").on(t.taskId)]);

export const taskEvents = pgTable("task_events", {
  id: serial("id").primaryKey(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  type: text("type").notNull(),
  message: text("message"),
  data: jsonb("data"),
}, (t) => [index("task_events_task_idx").on(t.taskId, t.ts)]);

export type User = typeof users.$inferSelect;
export type McpServer = typeof mcpServers.$inferSelect;
export type Provider = typeof providers.$inferSelect;
export type AgentDefinition = typeof agentDefinitions.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskFile = typeof taskFiles.$inferSelect;
export type TaskEvent = typeof taskEvents.$inferSelect;

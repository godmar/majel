import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  route("healthz", "routes/healthz.ts"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  route("api/user/casvalidate", "routes/cas-validate.ts"),

  // File downloads render raw bytes, so they live outside the app layout.
  route("tasks/:taskId/files/:fileId", "routes/task-file-download.ts"),

  // Machine API for programmatic/external task creation (bearer token auth).
  route("api/tasks", "routes/api-tasks.ts"),
  route("api/tasks/:taskId", "routes/api-task-detail.ts"),

  // Machine API used by sandbox runners (bearer token auth).
  route("api/runner/tasks/:taskId/input", "routes/api-runner-input.ts"),
  route("api/runner/tasks/:taskId/files/:fileId", "routes/api-runner-file.ts"),
  route("api/runner/tasks/:taskId/events", "routes/api-runner-events.ts"),
  route("api/runner/tasks/:taskId/transcript", "routes/api-runner-transcript.ts"),
  route("api/runner/tasks/:taskId/result", "routes/api-runner-result.ts"),
  route("api/runner/tasks/:taskId/result/files", "routes/api-runner-result-file.ts"),

  layout("routes/app-layout.tsx", [
    index("routes/task-list.tsx"),
    route("tasks/new", "routes/task-new.tsx"),
    route("tasks/:taskId", "routes/task-detail.tsx"),
    route("admin/users", "routes/admin-users.tsx"),
    route("admin/agents", "routes/admin-agents.tsx"),
    route("admin/agents/:agentId", "routes/admin-agent-edit.tsx"),
    route("admin/mcp-servers", "routes/admin-mcp-servers.tsx"),
    route("admin/providers", "routes/admin-providers.tsx"),
  ]),
] satisfies RouteConfig;

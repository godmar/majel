import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  route("api/user/casvalidate", "routes/cas-validate.ts"),

  // File downloads render raw bytes, so they live outside the app layout.
  route("tasks/:taskId/files/:fileId", "routes/task-file-download.ts"),

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

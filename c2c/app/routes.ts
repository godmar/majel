import { type RouteConfig, index, layout, route } from "@react-router/dev/routes";

export default [
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  route("api/user/casvalidate", "routes/cas-validate.ts"),

  layout("routes/app-layout.tsx", [
    index("routes/task-list.tsx"),
    route("admin/users", "routes/admin-users.tsx"),
  ]),
] satisfies RouteConfig;

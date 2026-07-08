import { Outlet } from "react-router";
import type { Route } from "./+types/app-layout";
import AppShell from "~/components/AppShell";
import { requireUser } from "~/lib/auth.server";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  return {
    user: {
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    },
  };
}

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  return (
    <AppShell user={loaderData.user}>
      <Outlet />
    </AppShell>
  );
}

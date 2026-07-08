import { redirect } from "react-router";
import type { Route } from "./+types/cas-validate";
import { recordLogin, resolveAccount } from "~/lib/auth.server";
import { validateCasTicket } from "~/lib/cas.server";
import { commitSession, getSession, returnToCookie } from "~/lib/session.server";

/**
 * CAS callback: CAS redirects the browser here with a service ticket after a
 * successful VT login. This URL is the registered CAS "service".
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const ticket = url.searchParams.get("ticket");
  if (!ticket) {
    throw redirect("/login?error=no-ticket");
  }

  const result = await validateCasTicket(ticket);
  if (!result.ok || !result.username) {
    console.warn("CAS validation failed:", result.error);
    throw redirect("/login?error=cas-failed");
  }

  const account = await resolveAccount(result.username);
  if (!account) {
    throw redirect(`/login?error=not-enabled&user=${encodeURIComponent(result.username)}`);
  }

  await recordLogin(account.id);

  const session = await getSession(request.headers.get("Cookie"));
  session.set("userId", account.id);
  session.set("username", account.username);

  const returnTo: string | null = await returnToCookie.parse(request.headers.get("Cookie"));

  const headers = new Headers();
  headers.append("Set-Cookie", await commitSession(session));
  headers.append("Set-Cookie", await returnToCookie.serialize("", { maxAge: 0 }));

  throw redirect(returnTo && returnTo.startsWith("/") ? returnTo : "/", { headers });
}

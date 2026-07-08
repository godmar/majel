import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Typography from "@mui/material/Typography";
import LoginIcon from "@mui/icons-material/Login";
import { data, redirect } from "react-router";
import type { Route } from "./+types/login";
import { devLoginUser, getUser, recordLogin } from "~/lib/auth.server";
import { casLoginUrl } from "~/lib/cas.server";
import { commitSession, getSession, returnToCookie } from "~/lib/session.server";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo");

  if (await getUser(request)) {
    throw redirect(returnTo ?? "/");
  }

  const devUser = await devLoginUser();
  if (devUser) {
    const session = await getSession(request.headers.get("Cookie"));
    session.set("userId", devUser.id);
    session.set("username", devUser.username);
    await recordLogin(devUser.id);
    throw redirect(returnTo ?? "/", {
      headers: { "Set-Cookie": await commitSession(session) },
    });
  }

  const headers = new Headers();
  if (returnTo && returnTo.startsWith("/")) {
    headers.append("Set-Cookie", await returnToCookie.serialize(returnTo));
  }

  return data(
    {
      loginUrl: casLoginUrl(),
      error: url.searchParams.get("error"),
      username: url.searchParams.get("user"),
    },
    { headers },
  );
}

function errorMessage(error: string | null, username: string | null): string | null {
  switch (error) {
    case "not-enabled":
      return `Your account${username ? ` (${username})` : ""} has not been enabled. Please contact an administrator to request access.`;
    case "cas-failed":
      return "VT Login could not verify your sign-in. Please try again.";
    case "no-ticket":
      return "The sign-in response was missing a ticket. Please try again.";
    default:
      return null;
  }
}

export default function Login({ loaderData }: Route.ComponentProps) {
  const message = errorMessage(loaderData.error, loaderData.username);
  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        p: 2,
      }}
    >
      <Card sx={{ maxWidth: 420, width: "100%" }} elevation={4}>
        <CardContent sx={{ p: 4, textAlign: "center" }}>
          <Typography variant="h5" gutterBottom>
            VT Library AI Agents
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 3 }}>
            Submit tasks to library AI agents and monitor their progress.
          </Typography>
          {message && (
            <Alert severity="warning" sx={{ mb: 3, textAlign: "left" }}>
              {message}
            </Alert>
          )}
          <Button
            variant="contained"
            size="large"
            startIcon={<LoginIcon />}
            href={loaderData.loginUrl}
            fullWidth
          >
            Sign in with VT
          </Button>
        </CardContent>
      </Card>
    </Box>
  );
}

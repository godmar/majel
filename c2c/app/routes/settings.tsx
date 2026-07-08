import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { and, asc, eq } from "drizzle-orm";
import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/settings";
import { requireUser } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { providers, userProviderKeys } from "~/lib/schema.server";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const rows = await db
    .select({
      id: providers.id,
      name: providers.name,
      displayName: providers.displayName,
      baseUrl: providers.baseUrl,
      hasDefault: providers.apiKey,
    })
    .from(providers)
    .where(eq(providers.enabled, true))
    .orderBy(asc(providers.name));

  const keys = await db
    .select({ providerId: userProviderKeys.providerId, updatedAt: userProviderKeys.updatedAt })
    .from(userProviderKeys)
    .where(eq(userProviderKeys.userId, user.id));
  const keyByProvider = new Map(keys.map((k) => [k.providerId, k.updatedAt]));

  return {
    providers: rows.map((p) => ({
      id: p.id,
      name: p.displayName ?? p.name,
      baseUrl: p.baseUrl,
      hasDefault: p.hasDefault.length > 0,
      keySetAt: keyByProvider.get(p.id)?.toISOString() ?? null,
    })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  const providerId = Number(form.get("providerId"));
  if (!Number.isInteger(providerId)) return { error: "Invalid provider" };

  if (form.get("intent") === "clear-key") {
    await db
      .delete(userProviderKeys)
      .where(
        and(eq(userProviderKeys.userId, user.id), eq(userProviderKeys.providerId, providerId)),
      );
    return { ok: true };
  }

  const apiKey = String(form.get("apiKey") ?? "").trim();
  if (!apiKey) return { error: "API key must not be empty." };
  await db
    .insert(userProviderKeys)
    .values({ userId: user.id, providerId, apiKey })
    .onConflictDoUpdate({
      target: [userProviderKeys.userId, userProviderKeys.providerId],
      set: { apiKey, updatedAt: new Date() },
    });
  return { ok: true };
}

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <Box sx={{ maxWidth: 700 }}>
      <Typography variant="h5" sx={{ mb: 1 }}>
        API Keys
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3 }}>
        Agents run with your personal LLM API key. Enter the key you were issued for each
        provider; tasks you submit will use it.
      </Typography>

      {actionData?.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {actionData.error}
        </Alert>
      )}

      <Stack spacing={2}>
        {loaderData.providers.map((p) => (
          <Paper key={p.id} sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1.5 }}>
              <Typography variant="subtitle1">{p.name}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }} noWrap>
                {p.baseUrl}
              </Typography>
              {p.keySetAt ? (
                <Chip size="small" color="success" label="your key is set" />
              ) : p.hasDefault ? (
                <Chip size="small" color="warning" label="using shared default key" />
              ) : (
                <Chip size="small" color="error" label="no key — tasks will fail" />
              )}
            </Stack>
            <Form method="post">
              <input type="hidden" name="providerId" value={p.id} />
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
                <TextField
                  name="apiKey"
                  label={p.keySetAt ? "Replace your API key" : "Your API key"}
                  size="small"
                  type="password"
                  autoComplete="new-password"
                  fullWidth
                />
                <Button type="submit" variant="contained" disabled={busy}>
                  Save
                </Button>
                {p.keySetAt && (
                  <Button
                    type="submit"
                    name="intent"
                    value="clear-key"
                    color="inherit"
                    disabled={busy}
                  >
                    Remove
                  </Button>
                )}
              </Stack>
            </Form>
          </Paper>
        ))}
        {loaderData.providers.length === 0 && (
          <Typography color="text.secondary">No providers are configured.</Typography>
        )}
      </Stack>
    </Box>
  );
}

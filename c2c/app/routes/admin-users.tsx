import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import PersonAddIcon from "@mui/icons-material/PersonAdd";
import { asc, eq } from "drizzle-orm";
import { Form, useNavigation } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/admin-users";
import { requireAdmin } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { users } from "~/lib/schema.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const rows = await db.select().from(users).orderBy(asc(users.username));
  return { users: rows.map(({ id, username, displayName, role, enabled, lastLoginAt }) => ({
    id, username, displayName, role, enabled, lastLoginAt,
  })) };
}

const addSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._-]+$/, "Username may only contain letters, digits, dots, dashes"),
  role: z.enum(["admin", "user"]),
});

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "add") {
    const parsed = addSchema.safeParse({
      username: form.get("username"),
      role: form.get("role") ?? "user",
    });
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
    }
    const { username, role } = parsed.data;
    try {
      await db.insert(users).values({ username, role });
    } catch {
      return { error: `User "${username}" already exists.` };
    }
    return { ok: true };
  }

  const userId = Number(form.get("userId"));
  if (!Number.isInteger(userId)) return { error: "Invalid user" };
  if (userId === admin.id) {
    return { error: "You cannot change your own account." };
  }

  if (intent === "toggle-enabled") {
    const enabled = form.get("enabled") === "true";
    await db.update(users).set({ enabled }).where(eq(users.id, userId));
    return { ok: true };
  }
  if (intent === "set-role") {
    const role = form.get("role") === "admin" ? "admin" : ("user" as const);
    await db.update(users).set({ role }).where(eq(users.id, userId));
    return { ok: true };
  }
  return { error: "Unknown action" };
}

export default function AdminUsers({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <>
      <Typography variant="h5" sx={{ mb: 2 }}>
        Users
      </Typography>

      <Paper sx={{ p: 2, mb: 3 }}>
        <Form method="post">
          <input type="hidden" name="intent" value="add" />
          <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", alignItems: "center" }}>
            <TextField
              name="username"
              label="VT username (PID)"
              size="small"
              required
              sx={{ minWidth: 220 }}
            />
            <TextField name="role" label="Role" size="small" select defaultValue="user" sx={{ minWidth: 120 }}>
              <MenuItem value="user">User</MenuItem>
              <MenuItem value="admin">Admin</MenuItem>
            </TextField>
            <Button type="submit" variant="contained" startIcon={<PersonAddIcon />} disabled={busy}>
              Add user
            </Button>
          </Box>
        </Form>
        {actionData?.error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {actionData.error}
          </Alert>
        )}
      </Paper>

      <TableContainer component={Paper}>
        <Table size="small" sx={{ minWidth: 600 }}>
          <TableHead>
            <TableRow>
              <TableCell>Username</TableCell>
              <TableCell>Role</TableCell>
              <TableCell>Enabled</TableCell>
              <TableCell>Last login</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loaderData.users.map((u) => (
              <TableRow key={u.id} hover>
                <TableCell>{u.username}</TableCell>
                <TableCell>
                  <Form method="post">
                    <input type="hidden" name="intent" value="set-role" />
                    <input type="hidden" name="userId" value={u.id} />
                    <input type="hidden" name="role" value={u.role === "admin" ? "user" : "admin"} />
                    <Button size="small" type="submit" disabled={busy} color="inherit" sx={{ textTransform: "none" }}>
                      {u.role === "admin" ? "Admin ▾" : "User ▾"}
                    </Button>
                  </Form>
                </TableCell>
                <TableCell>
                  <Form method="post">
                    <input type="hidden" name="intent" value="toggle-enabled" />
                    <input type="hidden" name="userId" value={u.id} />
                    <input type="hidden" name="enabled" value={String(!u.enabled)} />
                    <Switch
                      checked={u.enabled}
                      size="small"
                      disabled={busy}
                      onChange={(e) => e.target.form?.requestSubmit()}
                      slotProps={{ input: { "aria-label": `enable ${u.username}` } }}
                    />
                  </Form>
                </TableCell>
                <TableCell>
                  {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  );
}

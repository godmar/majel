import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import { desc, eq } from "drizzle-orm";
import { Link } from "react-router";
import type { Route } from "./+types/task-list";
import TaskStatusChip from "~/components/TaskStatusChip";
import { requireUser } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { agentDefinitions, tasks, users } from "~/lib/schema.server";

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const isAdmin = user.role === "admin";

  const rows = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      prompt: tasks.prompt,
      createdAt: tasks.createdAt,
      finishedAt: tasks.finishedAt,
      agentName: agentDefinitions.name,
      username: users.username,
    })
    .from(tasks)
    .innerJoin(agentDefinitions, eq(tasks.agentDefinitionId, agentDefinitions.id))
    .leftJoin(users, eq(tasks.createdBy, users.id))
    .where(isAdmin ? undefined : eq(tasks.createdBy, user.id))
    .orderBy(desc(tasks.createdAt))
    .limit(100);

  return { rows, isAdmin };
}

function excerpt(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export default function TaskList({ loaderData }: Route.ComponentProps) {
  const { rows, isAdmin } = loaderData;

  return (
    <>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 2 }}>
        <Typography variant="h5">Tasks</Typography>
        <Button component={Link} to="/tasks/new" variant="contained" startIcon={<AddIcon />}>
          New Task
        </Button>
      </Box>

      {rows.length === 0 ? (
        <Paper sx={{ p: 6, textAlign: "center" }}>
          <Typography color="text.secondary" gutterBottom>
            No tasks yet.
          </Typography>
          <Typography color="text.secondary">
            Create a task to send a prompt to one of the configured agents.
          </Typography>
        </Paper>
      ) : (
        <TableContainer component={Paper}>
          <Table size="small" sx={{ minWidth: 650 }}>
            <TableHead>
              <TableRow>
                <TableCell>Status</TableCell>
                <TableCell>Agent</TableCell>
                <TableCell sx={{ width: "40%" }}>Prompt</TableCell>
                {isAdmin && <TableCell>User</TableCell>}
                <TableCell>Created</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.id}
                  hover
                  component={Link}
                  to={`/tasks/${row.id}`}
                  sx={{ textDecoration: "none", cursor: "pointer" }}
                >
                  <TableCell>
                    <TaskStatusChip status={row.status} />
                  </TableCell>
                  <TableCell>{row.agentName}</TableCell>
                  <TableCell>{excerpt(row.prompt)}</TableCell>
                  {isAdmin && <TableCell>{row.username ?? "—"}</TableCell>}
                  <TableCell>{new Date(row.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </>
  );
}

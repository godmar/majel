import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import { asc, eq, sql } from "drizzle-orm";
import { Link } from "react-router";
import type { Route } from "./+types/admin-agents";
import { requireAdmin } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { agentDefinitions, agentMcpServers } from "~/lib/schema.server";

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(request);
  const rows = await db
    .select({
      id: agentDefinitions.id,
      name: agentDefinitions.name,
      description: agentDefinitions.description,
      model: agentDefinitions.model,
      enabled: agentDefinitions.enabled,
      timeoutSeconds: agentDefinitions.timeoutSeconds,
      mcpCount: sql<number>`(select count(*) from ${agentMcpServers} where ${agentMcpServers.agentDefinitionId} = ${agentDefinitions.id})`,
    })
    .from(agentDefinitions)
    .orderBy(asc(agentDefinitions.name));
  return { agents: rows };
}

export default function AdminAgents({ loaderData }: Route.ComponentProps) {
  return (
    <>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 2 }}>
        <Typography variant="h5">Agents</Typography>
        <Button component={Link} to="/admin/agents/new" variant="contained" startIcon={<AddIcon />}>
          New Agent
        </Button>
      </Box>
      <TableContainer component={Paper}>
        <Table size="small" sx={{ minWidth: 650 }}>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Description</TableCell>
              <TableCell>Model</TableCell>
              <TableCell>MCP servers</TableCell>
              <TableCell>Timeout</TableCell>
              <TableCell>Status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loaderData.agents.map((a) => (
              <TableRow
                key={a.id}
                hover
                component={Link}
                to={`/admin/agents/${a.id}`}
                sx={{ textDecoration: "none", cursor: "pointer" }}
              >
                <TableCell>{a.name}</TableCell>
                <TableCell>{a.description}</TableCell>
                <TableCell>{a.model}</TableCell>
                <TableCell>{a.mcpCount}</TableCell>
                <TableCell>{a.timeoutSeconds}s</TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    label={a.enabled ? "Enabled" : "Disabled"}
                    color={a.enabled ? "success" : "default"}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  );
}

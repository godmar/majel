import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import InputAdornment from "@mui/material/InputAdornment";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TablePagination from "@mui/material/TablePagination";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import ArchiveIcon from "@mui/icons-material/Archive";
import SearchIcon from "@mui/icons-material/Search";
import UnarchiveIcon from "@mui/icons-material/Unarchive";
import * as React from "react";
import { and, count, desc, eq, ilike, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import { Link, useFetcher, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/task-list";
import DateTime from "~/components/DateTime";
import TaskStatusChip from "~/components/TaskStatusChip";
import { requireUser } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { agentDefinitions, tasks, users } from "~/lib/schema.server";
import { TERMINAL, type TaskStatus } from "~/lib/task-status";

const PAGE_SIZES = [25, 50, 100];
const STATUSES: TaskStatus[] = [
  "pending",
  "scheduled",
  "running",
  "succeeded",
  "failed",
  "timeout",
  "canceled",
];

function parseFilters(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const status = url.searchParams.get("status") ?? "";
  const view = url.searchParams.get("view") === "archived" ? "archived" : "active";
  const page = Math.max(0, Number(url.searchParams.get("page")) || 0);
  const rawSize = Number(url.searchParams.get("size"));
  const size = PAGE_SIZES.includes(rawSize) ? rawSize : PAGE_SIZES[0];
  return { q, status, view, page, size } as const;
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const isAdmin = user.role === "admin";
  const { q, status, view, page, size } = parseFilters(request);

  const conditions: SQL[] = [
    view === "archived" ? isNotNull(tasks.archivedAt) : isNull(tasks.archivedAt),
  ];
  if (!isAdmin) conditions.push(eq(tasks.createdBy, user.id));
  if (STATUSES.includes(status as TaskStatus)) {
    conditions.push(eq(tasks.status, status as TaskStatus));
  }
  if (q) {
    const pattern = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
    conditions.push(
      or(
        ilike(tasks.prompt, pattern),
        ilike(tasks.resultText, pattern),
        ilike(agentDefinitions.name, pattern),
      )!,
    );
  }
  const where = and(...conditions);

  const base = () =>
    db
      .select({
        id: tasks.id,
        status: tasks.status,
        prompt: tasks.prompt,
        createdAt: tasks.createdAt,
        username: users.username,
        agentName: agentDefinitions.name,
      })
      .from(tasks)
      .innerJoin(agentDefinitions, eq(tasks.agentDefinitionId, agentDefinitions.id))
      .leftJoin(users, eq(tasks.createdBy, users.id));

  const [{ total }] = await db
    .select({ total: count() })
    .from(tasks)
    .innerJoin(agentDefinitions, eq(tasks.agentDefinitionId, agentDefinitions.id))
    .where(where);

  // If a stale URL points past the last page (e.g. after archiving), clamp.
  const lastPage = Math.max(0, Math.ceil(total / size) - 1);
  const clampedPage = Math.min(page, lastPage);

  const rows = await base()
    .where(where)
    .orderBy(desc(tasks.createdAt))
    .limit(size)
    .offset(clampedPage * size);

  return { rows, total, page: clampedPage, size, q, status, view, isAdmin };
}

export async function action({ request }: Route.ActionArgs) {
  const user = await requireUser(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const ids = String(form.get("ids") ?? "")
    .split(",")
    .filter(Boolean);
  if (ids.length === 0) return { ok: true };

  const ownTask = user.role === "admin" ? undefined : eq(tasks.createdBy, user.id);

  if (intent === "archive") {
    // Only finished tasks can be archived; active ones must be canceled first.
    await db
      .update(tasks)
      .set({ archivedAt: new Date() })
      .where(and(inArray(tasks.id, ids), inArray(tasks.status, TERMINAL), ownTask));
  } else if (intent === "unarchive") {
    await db
      .update(tasks)
      .set({ archivedAt: null })
      .where(and(inArray(tasks.id, ids), ownTask));
  }
  return { ok: true };
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export default function TaskList({ loaderData }: Route.ComponentProps) {
  const { rows, total, page, size, q, status, view, isAdmin } = loaderData;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher();
  const [selected, setSelected] = React.useState<string[]>([]);
  const archivedView = view === "archived";

  // Selection only survives within the current result page/filter view.
  React.useEffect(() => setSelected([]), [rows]);

  const updateParams = (updates: Record<string, string>, resetPage = true) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (resetPage) next.delete("page");
    setSearchParams(next, { preventScrollReset: true });
  };

  const selectable = archivedView
    ? rows.map((r) => r.id)
    : rows.filter((r) => TERMINAL.includes(r.status)).map((r) => r.id);
  const allSelected = selectable.length > 0 && selectable.every((id) => selected.includes(id));

  const bulkAction = (intent: "archive" | "unarchive") => {
    fetcher.submit({ intent, ids: selected.join(",") }, { method: "post" });
    setSelected([]);
  };

  return (
    <>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 2 }}>
        <Typography variant="h5">Tasks</Typography>
        <Button component={Link} to="/tasks/new" variant="contained" startIcon={<AddIcon />}>
          New Task
        </Button>
      </Box>

      <Box sx={{ display: "flex", gap: 2, mb: 2, flexWrap: "wrap", alignItems: "center" }}>
        <TextField
          key={`${view}:${q}`}
          size="small"
          placeholder="Search prompts, results, agents…"
          defaultValue={q}
          onKeyDown={(e) => {
            if (e.key === "Enter") updateParams({ q: (e.target as HTMLInputElement).value.trim() });
          }}
          onBlur={(e) => {
            if (e.target.value.trim() !== q) updateParams({ q: e.target.value.trim() });
          }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
          sx={{ minWidth: 280 }}
        />
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(e) => updateParams({ status: e.target.value })}
          sx={{ minWidth: 140 }}
        >
          <MenuItem value="">All</MenuItem>
          {STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {s}
            </MenuItem>
          ))}
        </TextField>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={view}
          onChange={(_e, next) => {
            if (next) updateParams({ view: next === "archived" ? "archived" : "" });
          }}
        >
          <ToggleButton value="active">Active</ToggleButton>
          <ToggleButton value="archived">Archived</ToggleButton>
        </ToggleButtonGroup>
        <Box sx={{ flexGrow: 1 }} />
        {selected.length > 0 && (
          <Button
            size="small"
            variant="outlined"
            startIcon={archivedView ? <UnarchiveIcon /> : <ArchiveIcon />}
            onClick={() => bulkAction(archivedView ? "unarchive" : "archive")}
          >
            {archivedView ? "Unarchive" : "Archive"} ({selected.length})
          </Button>
        )}
      </Box>

      {rows.length === 0 ? (
        <Paper sx={{ p: 6, textAlign: "center" }}>
          <Typography color="text.secondary" gutterBottom>
            {q || status
              ? "No tasks match the current filters."
              : archivedView
                ? "No archived tasks."
                : "No tasks yet."}
          </Typography>
          {!q && !status && !archivedView && (
            <Typography color="text.secondary">
              Create a task to send a prompt to one of the configured agents.
            </Typography>
          )}
        </Paper>
      ) : (
        <TableContainer component={Paper}>
          <Table size="small" sx={{ minWidth: 650 }}>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <Checkbox
                    size="small"
                    checked={allSelected}
                    indeterminate={selected.length > 0 && !allSelected}
                    disabled={selectable.length === 0}
                    onChange={() => setSelected(allSelected ? [] : selectable)}
                    slotProps={{ input: { "aria-label": "select all" } }}
                  />
                </TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Agent</TableCell>
                <TableCell>Prompt</TableCell>
                {isAdmin && <TableCell>User</TableCell>}
                <TableCell>Created</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => {
                const canSelect = selectable.includes(row.id);
                return (
                  <TableRow
                    key={row.id}
                    hover
                    onClick={() => navigate(`/tasks/${row.id}`)}
                    sx={{ cursor: "pointer" }}
                  >
                    <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        size="small"
                        checked={selected.includes(row.id)}
                        disabled={!canSelect}
                        onChange={(e) =>
                          setSelected((prev) =>
                            e.target.checked
                              ? [...prev, row.id]
                              : prev.filter((id) => id !== row.id),
                          )
                        }
                        title={canSelect ? undefined : "Only finished tasks can be archived"}
                      />
                    </TableCell>
                    <TableCell sx={{ whiteSpace: "nowrap" }}>
                      <TaskStatusChip status={row.status} />
                    </TableCell>
                    <TableCell sx={{ whiteSpace: "nowrap" }}>{row.agentName}</TableCell>
                    <TableCell
                      title={oneLine(row.prompt, 1000)}
                      sx={{
                        maxWidth: 360,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {oneLine(row.prompt, 300)}
                    </TableCell>
                    {isAdmin && (
                      <TableCell sx={{ whiteSpace: "nowrap" }}>{row.username ?? "—"}</TableCell>
                    )}
                    <TableCell sx={{ whiteSpace: "nowrap" }}>
                      <DateTime value={row.createdAt} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <TablePagination
            component="div"
            count={total}
            page={page}
            rowsPerPage={size}
            rowsPerPageOptions={PAGE_SIZES}
            onPageChange={(_e, next) => updateParams({ page: next ? String(next) : "" }, false)}
            onRowsPerPageChange={(e) => updateParams({ size: e.target.value })}
          />
        </TableContainer>
      )}
    </>
  );
}

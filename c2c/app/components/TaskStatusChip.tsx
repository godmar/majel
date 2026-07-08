import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import type { TaskStatus } from "~/lib/schema.server";

const config: Record<TaskStatus, { label: string; color: "default" | "info" | "success" | "error" | "warning" }> = {
  pending: { label: "Pending", color: "default" },
  scheduled: { label: "Scheduled", color: "info" },
  running: { label: "Running", color: "info" },
  succeeded: { label: "Succeeded", color: "success" },
  failed: { label: "Failed", color: "error" },
  timeout: { label: "Timed out", color: "warning" },
  canceled: { label: "Canceled", color: "default" },
};

export default function TaskStatusChip({ status }: { status: TaskStatus }) {
  const { label, color } = config[status] ?? { label: status, color: "default" as const };
  const busy = status === "running" || status === "scheduled" || status === "pending";
  return (
    <Chip
      size="small"
      label={label}
      color={color}
      icon={busy ? <CircularProgress size={12} color="inherit" /> : undefined}
    />
  );
}

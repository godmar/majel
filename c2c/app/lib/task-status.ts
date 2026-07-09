// Shared between server and client code (route components render status
// logic in the browser), so this must not live in a *.server module.

export type TaskStatus =
  | "pending"
  | "scheduled"
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"
  | "canceled";

export const TERMINAL: TaskStatus[] = ["succeeded", "failed", "timeout", "canceled"];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.includes(status);
}

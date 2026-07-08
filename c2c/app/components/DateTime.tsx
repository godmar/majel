/**
 * Timestamp rendered in the viewer's locale/timezone. The server renders in
 * its own timezone, so the text legitimately differs at hydration —
 * suppressHydrationWarning lets the client value win without a React #418.
 */
export default function DateTime({ value }: { value: string | Date | null }) {
  if (!value) return <>never</>;
  return <span suppressHydrationWarning>{new Date(value).toLocaleString()}</span>;
}

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Render agent-produced markdown with MUI typography. */
export default function MarkdownView({ children }: { children: string }) {
  return (
    <Box
      sx={{
        "& pre": {
          p: 1.5,
          borderRadius: 1,
          bgcolor: "action.hover",
          overflowX: "auto",
          fontSize: "0.85rem",
        },
        "& code": { fontFamily: "monospace" },
        "& :first-of-type": { mt: 0 },
      }}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <Typography variant="h5" gutterBottom {...p} />,
          h2: (p) => <Typography variant="h6" gutterBottom {...p} />,
          h3: (p) => <Typography variant="subtitle1" gutterBottom {...p} />,
          p: (p) => <Typography sx={{ mb: 1 }} {...p} />,
          a: ({ href, children }) => (
            <Link href={href} target="_blank" rel="noreferrer">
              {children}
            </Link>
          ),
          li: ({ children }) => (
            <li>
              <Typography component="span">{children}</Typography>
            </li>
          ),
          table: ({ children }) => (
            <TableContainer sx={{ mb: 2 }}>
              <Table size="small">{children}</Table>
            </TableContainer>
          ),
          thead: (p) => <TableHead {...p} />,
          tbody: (p) => <TableBody {...p} />,
          tr: (p) => <TableRow {...p} />,
          th: ({ children }) => <TableCell sx={{ fontWeight: "bold" }}>{children}</TableCell>,
          td: ({ children }) => <TableCell>{children}</TableCell>,
        }}
      >
        {children}
      </Markdown>
    </Box>
  );
}

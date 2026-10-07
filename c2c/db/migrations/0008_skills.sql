CREATE TABLE "skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"license" text,
	"compatibility" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"agent_definition_id" integer NOT NULL,
	"skill_id" integer NOT NULL,
	CONSTRAINT "agent_skills_agent_definition_id_skill_id_pk" PRIMARY KEY("agent_definition_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "skill_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"skill_id" integer NOT NULL,
	"path" text NOT NULL,
	"content" "bytea" NOT NULL,
	"size_bytes" integer NOT NULL,
	"executable" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_files" ADD CONSTRAINT "skill_files_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_files_skill_path_idx" ON "skill_files" USING btree ("skill_id","path");--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_definition_id_agent_definitions_id_fk" FOREIGN KEY ("agent_definition_id") REFERENCES "public"."agent_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- An example to copy from. It is granted to no agent, so it changes nothing
-- until an admin ticks it on an agent's page.
INSERT INTO "skills" ("name", "description", "license", "compatibility", "metadata", "body") VALUES (
  'xlsx-deliverable',
  'Produce an Excel (.xlsx) file for library staff. Use whenever the task asks for a spreadsheet, a report to open in Excel, or tabular results to hand back as a file.',
  'MIT',
  'opencode',
  '{"audience": "library staff", "version": "1"}'::jsonb,
  $skill$# Excel deliverables for library staff

Staff open these files in Excel and work in them directly, so a spreadsheet
that merely contains the right data is not done. Follow every rule below.

## Build it with openpyxl

`openpyxl` and `pandas` are preinstalled; do not `pip install` anything.
Write the file into the working directory so it is returned with the result.

```python
from openpyxl import Workbook
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter

wb = Workbook()
ws = wb.active
ws.title = "Results"
ws.append(headers)
for row in rows:
    ws.append(row)

for cell in ws[1]:
    cell.font = Font(bold=True)
ws.freeze_panes = "A2"
ws.auto_filter.ref = ws.dimensions

for i, header in enumerate(headers, start=1):
    width = max(len(str(c.value or "")) for c in ws[get_column_letter(i)])
    ws.column_dimensions[get_column_letter(i)].width = min(max(width, len(header)) + 2, 60)

wb.save("results.xlsx")
```

## Rules

1. **Identifiers are text.** ISBNs, ISSNs, OCLC numbers, barcodes, and call
   numbers must be written as strings and formatted as text (`cell.number_format = "@"`).
   Excel otherwise drops leading zeros and turns 13-digit ISBNs into `9.78E+12`.
2. **Dates are dates.** Write `datetime.date` values, not strings, and set
   `number_format = "yyyy-mm-dd"`, so staff can sort and filter on them.
3. **Money is a number** with `number_format = "#,##0.00"`, never a string with a `$`.
4. **One header row**, bold and frozen, with an autofilter. No merged cells,
   no blank spacer rows or columns — they break sorting.
5. **Name the file for its content** (`invoice-2026-0412-lines.xlsx`, not
   `output.xlsx`), and name the sheet too.
6. If you computed totals or flagged problems, put them on a separate
   `Summary` sheet rather than below the data.

## Before you finish

Run the checker that ships with this skill on every workbook you produce:

```
python3 scripts/check_xlsx.py results.xlsx
```

(`scripts/` is relative to this skill's base directory, not your working
directory.) It prints the row count of each sheet and one `PROBLEM:` line per
rule broken. Fix every problem and run it again until it prints `OK`. Then
check the row count against your source, and tell the user the file name, the
number of rows, and any rows you could not process and why.
$skill$
);
--> statement-breakpoint
INSERT INTO "skill_files" ("skill_id", "path", "content", "size_bytes", "executable")
SELECT "id", 'scripts/check_xlsx.py', convert_to($file$#!/usr/bin/env python3
"""Check an .xlsx deliverable against the xlsx-deliverable skill's rules.

Usage: python3 check_xlsx.py FILE.xlsx

Prints one line per problem and exits 1 if there are any, so it can be run
as the last step before handing the file back.
"""
import re
import sys

from openpyxl import load_workbook

# Values that look like identifiers Excel would mangle if stored as numbers.
IDENTIFIER_HEADER = re.compile(r"isbn|issn|oclc|barcode|call ?(no|number)|lccn|\bid\b", re.I)


def check(path):
    problems = []
    wb = load_workbook(path)
    for ws in wb.worksheets:
        where = f"sheet {ws.title!r}"
        if ws.max_row < 2:
            problems.append(f"{where}: no data rows")
            continue
        header = [c.value for c in ws[1]]
        if any(h in (None, "") for h in header):
            problems.append(f"{where}: empty header cell in row 1")
        if not all(c.font and c.font.bold for c in ws[1] if c.value is not None):
            problems.append(f"{where}: header row is not bold")
        if ws.freeze_panes != "A2":
            problems.append(f"{where}: header row is not frozen (freeze_panes = 'A2')")
        if not ws.auto_filter.ref:
            problems.append(f"{where}: no autofilter on the header row")
        if ws.merged_cells.ranges:
            problems.append(f"{where}: merged cells {', '.join(map(str, ws.merged_cells.ranges))}")

        for col, name in enumerate(header, start=1):
            if not name or not IDENTIFIER_HEADER.search(str(name)):
                continue
            numeric = [
                cell.coordinate
                for (cell,) in ws.iter_rows(min_row=2, min_col=col, max_col=col)
                if isinstance(cell.value, (int, float))
            ]
            if numeric:
                more = f" (+{len(numeric) - 3} more)" if len(numeric) > 3 else ""
                problems.append(
                    f"{where}: column {name!r} holds numbers, not text, at "
                    f"{', '.join(numeric[:3])}{more}"
                )
        print(f"{where}: {ws.max_row - 1} data rows, {len(header)} columns")
    return problems


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip().splitlines()[2])
    problems = check(sys.argv[1])
    for p in problems:
        print(f"PROBLEM: {p}")
    print("OK" if not problems else f"{len(problems)} problem(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
$file$, 'UTF8'),
  0, true
FROM "skills" WHERE "name" = 'xlsx-deliverable';
--> statement-breakpoint
UPDATE "skill_files" SET "size_bytes" = octet_length("content");

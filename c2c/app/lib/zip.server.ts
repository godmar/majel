import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  content: Buffer;
  modified?: Date;
}

/**
 * A path that extracts where its name says: no absolute paths, no `..`, no
 * empty segments. Agents name their own output files, and a zip that writes
 * outside the folder it is extracted into is the classic way to hurt
 * whoever unpacks it.
 */
function safePath(name: string): string {
  const parts = name
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p && p !== "." && p !== "..");
  return parts.join("/") || "file";
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Build a ZIP archive in memory. Task files are capped at 100 MB per task
 * (files.server.ts), well inside what the classic (non-ZIP64) format and a
 * single buffer handle. Entries that do not shrink under deflate — xlsx, png
 * and pdf already are compressed — are stored as-is.
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const used = new Set<string>();
  let offset = 0;

  for (const entry of entries) {
    // Two outputs with one name would silently overwrite each other on
    // extraction; keep both.
    const base = safePath(entry.name);
    const dot = base.lastIndexOf(".");
    const [stem, ext] = dot > base.lastIndexOf("/") ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${stem} (${n})${ext}`;
    used.add(name);

    const nameBytes = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(entry.content);
    const stored = deflated.length >= entry.content.length;
    const data = stored ? entry.content : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(entry.content);
    const { time, date } = dosDateTime(entry.modified ?? new Date());
    const UTF8_NAMES = 0x0800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // extra, comment, disk number, internal and external attributes: all 0
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // entries in total
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, ...centrals, end]);
}

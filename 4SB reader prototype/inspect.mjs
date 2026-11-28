import { open } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { scan4sb } from "./reader.ts";

const path = process.argv[2];
if (!path || !isAbsolute(path)) throw new Error("Pass the absolute archive path");
const file = await open(path, "r");
try {
  const { size } = await file.stat();
  const counts = {};
  let expandedBytes = 0;
  let records = 0;
  const source = {
    size,
    async read(offset, length) {
      const data = Buffer.alloc(length);
      const { bytesRead } = await file.read(data, 0, length, offset);
      return data.subarray(0, bytesRead);
    },
  };
  for await (const entry of scan4sb(source)) {
    const kind = entry.ordinal === 1 ? "metadata" : extname(entry.name).toLowerCase() || "(none)";
    counts[kind] = (counts[kind] ?? 0) + 1;
    expandedBytes += entry.expandedBytes;
    records++;
  }
  console.log(JSON.stringify({ size, expandedBytes, records, counts }, null, 2));
} finally {
  await file.close();
}

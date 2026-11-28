import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { defaultLimits, scan4sb } from "./reader.ts";

const metadata = Buffer.from("62706c6973743030d20102030956547261636b73557469746c65a104d20506070857536f6e6720494459536f6e67205261746513ffffffffffffffff233ff00000000000005953796e746865746963080d141a1c2129333c450000000000000101000000000000000a0000000000000000000000000000004f", "hex");
const signature = Buffer.from("<--4SBV03-->");
function record(name, data) {
  const filename = Buffer.from(name);
  const gzip = gzipSync(data);
  const header = Buffer.from([filename.length, gzip.length].map(n => String(n).padStart(16)).join(""));
  return Buffer.concat([header, filename, gzip]);
}
const first = record("synthetic.4sb", metadata);
const name = "Treulich gefu\u0308hrt.pdf";
const nested = gzipSync(metadata);
const entries = [
  record(`{%DOCUMENTS_DIR%}/${name}`, Buffer.from("%PDF-1.7\nsynthetic framing payload")),
  record(`{%AUX_DIR%}/${name}|1.png`, Buffer.from("synthetic PNG payload")),
  record(`{%AUX_DIR%}/${name}|template.4se`, nested),
];
const fixture = Buffer.concat([signature, first, ...entries]);
async function scan(data, limits, signal) {
  const results = [];
  for await (const row of scan4sb({
    size: data.length,
    async read(offset, length) {
      assert.ok(length <= 65536);
      return data.subarray(offset, offset + length);
    },
  }, limits, signal)) results.push(row);
  return results;
}
test("preserves record order, logical paths and decomposed UTF-8 names", async () => {
  const rows = await scan(fixture);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].expandedBytes, metadata.length);
  assert.equal(rows[1].name, `{%DOCUMENTS_DIR%}/${name}`);
  assert.equal(rows[2].name, `{%AUX_DIR%}/${name}|1.png`);
  assert.equal(rows[3].expandedBytes, nested.length); // no second inflation
});
test("rejects a bad gzip CRC trailer", async () => {
  const broken = Buffer.from(fixture);
  broken[broken.length - 8] ^= 1;
  await assert.rejects(scan(broken), /Record 4/);
});
test("rejects truncation, unknown signature and missing metadata", async () => {
  await assert.rejects(scan(fixture.subarray(0, -1)), /Truncated payload/);
  await assert.rejects(scan(Buffer.concat([Buffer.from("<--4SBV04-->"), first])), /Unsupported/);
  await assert.rejects(scan(signature), /Missing metadata/);
});
test("rejects bad lengths and invalid UTF-8", async () => {
  const header = Buffer.from(fixture);
  header[12] = 0xb1;
  await assert.rejects(scan(header), /ASCII length/);
  const filename = Buffer.from(fixture);
  filename[44] = 0xff;
  await assert.rejects(scan(filename), /Record 1/);
});
test("rejects expanded byte limit violations and respects cancellation", async () => {
  await assert.rejects(scan(fixture, { ...defaultLimits, expandedBytes: 8 }), /Expanded payload limit/);
  await assert.rejects(scan(fixture, { ...defaultLimits, totalExpandedBytes: metadata.length }), /Expanded payload limit/);
  await assert.rejects(scan(fixture, defaultLimits, AbortSignal.abort()), { name: "AbortError" });
});

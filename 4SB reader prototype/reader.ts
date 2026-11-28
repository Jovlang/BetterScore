// Read-only V03 framing and payload validation. No Node or Obsidian APIs.
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export const defaultLimits = {
  records: 10_000,
  nameBytes: 4_096,
  compressedBytes: 128 * 1024 ** 2,
  expandedBytes: 128 * 1024 ** 2,
  totalExpandedBytes: 2 * 1024 ** 3,
};

export interface RecordInfo {
  ordinal: number;
  name: string;
  offset: number;
  compressedBytes: number;
  expandedBytes: number;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const chunkSize = 64 * 1024;

function lengthField(field: Uint8Array) {
  if (!field.every(b => b === 32 || (b >= 48 && b <= 57))) {
    throw new Error("Invalid ASCII length field");
  }
  const value = utf8.decode(field);
  if (!/^ *[0-9]+$/.test(value)) throw new Error("Invalid length field");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Invalid length value");
  return n;
}

export async function* scan4sb(
  source: ByteSource,
  limits = defaultLimits,
  signal?: AbortSignal,
): AsyncGenerator<RecordInfo> {
  if (!Number.isSafeInteger(source.size) || source.size < 0) {
    throw new Error("Invalid source size");
  }
  async function exact(offset: number, length: number) {
    signal?.throwIfAborted();
    if (length > source.size - offset) throw new Error("Unexpected EOF");
    const bytes = await source.read(offset, length);
    if (bytes.byteLength !== length) throw new Error("Short read");
    return bytes;
  }
  if (utf8.decode(await exact(0, 12)) !== "<--4SBV03-->") {
    throw new Error("Unsupported 4SB signature");
  }
  let position = 12;
  let ordinal = 0;
  let total = 0;
  while (position < source.size) {
    ordinal++;
    try {
      if (ordinal > limits.records) throw new Error("Record count limit exceeded");
      const header = await exact(position, 32);
      const nameBytes = lengthField(header.subarray(0, 16));
      const compressedBytes = lengthField(header.subarray(16));
      if (nameBytes > limits.nameBytes) throw new Error("Filename limit exceeded");
      if (compressedBytes < 18 || compressedBytes > limits.compressedBytes) {
        throw new Error("Invalid compressed payload size");
      }
      const name = utf8.decode(await exact(position + 32, nameBytes));
      const offset = position + 32 + nameBytes;
      if (compressedBytes > source.size - offset) throw new Error("Truncated payload");
      const end = offset + compressedBytes;
      let cursor = offset;
      const input = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (cursor === end) return controller.close();
          const bytes = await exact(cursor, Math.min(end - cursor, chunkSize));
          cursor += bytes.length;
          controller.enqueue(bytes);
        },
      });
      const payload = input.pipeThrough(new DecompressionStream("gzip")).getReader();
      let expandedBytes = 0;
      let prefix = "";
      try {
        for (;;) {
          signal?.throwIfAborted();
          const { value, done } = await payload.read();
          if (done) break;
          expandedBytes += value.length;
          total += value.length;
          if (expandedBytes > limits.expandedBytes || total > limits.totalExpandedBytes) {
            throw new Error("Expanded payload limit exceeded");
          }
          if (ordinal === 1 && prefix.length < 8) {
            prefix += String.fromCharCode(...value.subarray(0, 8 - prefix.length));
          }
        }
      } finally {
        await payload.cancel().catch(() => {});
        payload.releaseLock();
      }
      if (ordinal === 1 && prefix !== "bplist00") {
        throw new Error("First payload is not a binary plist");
      }
      position = end;
      yield { ordinal, name, offset, compressedBytes, expandedBytes };
    } catch (cause) {
      signal?.throwIfAborted();
      throw new Error(`Record ${ordinal} at byte ${position}: ${String(cause)}`, { cause });
    }
  }
  if (!ordinal) throw new Error("Missing metadata record");
}

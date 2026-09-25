/**
 * Read Device Monitoring Studio `.dmslog8` serial captures.
 *
 * A capture of the vendor software driving a real Gen X Pro is the most
 * trustworthy statement of what the device answers: better than a protocol
 * document, because it is the device itself talking. {@link captureExpectations}
 * turns one into a table of "this command was answered like this", which the
 * conformance suite checks a unit against.
 *
 * ## File format (reverse-engineered)
 *
 * Records are `[u64 id][u64 FILETIME][u32 size][u32 type]` followed by a body,
 * packed into chunks that are not always contiguous — so records are found by
 * scanning for a signature rather than by walking the chunk chain. In the body,
 * `[0..8)` is a reference timestamp, `[13..17)` the IRP major function (4 =
 * write, 3 = read) and `[17..]` the payload. Host writes appear as type 1 with
 * major 4; device reads as type `0x80000001` with major 3, fragmented, so the
 * received bytes are reassembled and split on CRLF.
 */

/** One decoded line of serial traffic. */
export interface CaptureLine {
  /** Seconds since the first record in the file. */
  t: number;
  /** `TX` = host → device, `RX` = device → host. */
  direction: "TX" | "RX";
  /** The line, without its CR/LF. */
  line: string;
}

const RECORD_TYPES = new Set([1, 3, 0x80000001, 0x80000003]);

/** Decode a `.dmslog8` capture into the traffic in both directions. */
export function decodeDmsLog(bytes: Uint8Array): CaptureLine[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The file header carries a FILETIME; its top three bytes are shared by every
  // record written within about 30 hours of it, which makes a cheap signature.
  const signature = [bytes[0x1d]!, bytes[0x1e]!, bytes[0x1f]!];

  /** Is there a record at this offset? Returns its header if so. */
  const recordAt = (offset: number): { size: number; type: number } | null => {
    if (offset < 0 || offset + 24 > bytes.length) return null;
    if (bytes[offset + 13] !== signature[0] || bytes[offset + 14] !== signature[1] || bytes[offset + 15] !== signature[2]) {
      return null;
    }
    // The record id is a u32; its upper half is always zero here.
    if (bytes[offset + 4] !== 0 || bytes[offset + 5] !== 0 || bytes[offset + 6] !== 0) return null;
    const size = view.getUint32(offset + 16, true);
    const type = view.getUint32(offset + 20, true);
    if (size < 24 || size > 70000 || offset + size > bytes.length) return null;
    return RECORD_TYPES.has(type) ? { size, type } : null;
  };

  // Chunks are not contiguous, so every offset is a candidate. Walking the
  // chain from record to record was measured to be no faster: the work is in
  // the records themselves, not in finding them.
  const records = new Map<number, { offset: number; size: number; type: number }>();
  for (let i = 13; i + 3 <= bytes.length; i++) {
    if (bytes[i] !== signature[0] || bytes[i + 1] !== signature[1] || bytes[i + 2] !== signature[2]) continue;
    const offset = i - 13;
    const record = recordAt(offset);
    if (record === null) continue;
    const id = view.getUint32(offset, true);
    if (!records.has(id)) records.set(id, { offset, size: record.size, type: record.type });
  }

  const decoder = new TextDecoder("latin1");
  const lines: CaptureLine[] = [];
  let firstTimestamp: bigint | null = null;
  let received = "";

  for (const id of [...records.keys()].sort((a, b) => a - b)) {
    const { offset, size, type } = records.get(id)!;
    const timestamp = view.getBigUint64(offset + 8, true);
    firstTimestamp ??= timestamp;
    // FILETIME ticks are 100 ns.
    const t = Number(timestamp - firstTimestamp) / 1e7;
    const body = bytes.subarray(offset + 24, offset + size);
    if (body.length < 17) continue;
    const major = view.getUint32(offset + 24 + 13, true);

    if (type === 1 && major === 4) {
      const text = decoder.decode(body.subarray(17)).trim();
      if (text !== "") lines.push({ t, direction: "TX", line: text });
    } else if (type === 0x80000001 && major === 3) {
      received += decoder.decode(body.subarray(17));
      let breakAt: number;
      while ((breakAt = received.indexOf("\r\n")) !== -1) {
        const line = received.slice(0, breakAt);
        received = received.slice(breakAt + 2);
        lines.push({ t, direction: "RX", line });
      }
    }
  }
  return lines;
}

/**
 * The part of a command that decides what the answer should look like: the
 * register or sub-command, without the values.
 *
 * `:w24=3440082640,` and `:w24=0,` both key on `w24`; the `:n` sub-commands key
 * on their marker, because a name query and a program dump are different
 * questions asked through the same letter.
 */
export function expectationKey(command: string): string | null {
  const m = /^:([wr])(\d{1,2})=/.exec(command);
  if (m) return `${m[1]}${m[2]}`;
  const n = /^:n\d{1,2}=(.*)$/.exec(command);
  if (n) {
    const sub = n[1]!;
    return sub === "$" || sub === "?" || sub === "*" || sub === "#" || sub === "," ? `n${sub}` : "n=";
  }
  if (/^:p\d{1,2}=/.test(command)) return "p";
  if (/^:g\d{1,2}=/.test(command)) return "g";
  if (/^:a\d{1,3}=/.test(command)) return "a";
  return null;
}

/**
 * The shape of a reply: its form with the values taken out, so answers can be
 * compared between devices that hold different data.
 *
 * `:r11=46210.` and `:r11=48897.` are the same answer; `:r11=46210.` and `:err`
 * are not. Slot and register numbers are normalised too — the command key
 * already says which one was addressed.
 */
export function replyShape(reply: string): string {
  if (reply === "" || reply === ":ok" || reply === ":err") return reply;
  const m = /^:([a-zA-Z]+)\d*=(.*)$/.exec(reply);
  if (m) {
    const payload = m[2]!;
    const separator = /[.,]$/.exec(payload)?.[0] ?? "";
    const core = payload.slice(0, payload.length - separator.length);
    const body = core === "" ? "" : /^[\d\s,.+-]+$/.test(core) ? "#" : "<text>";
    return `:${m[1]}#=${body}${separator}`;
  }
  return reply.replace(/\d+/g, "#");
}

/** What kind of answer a reply is, independent of the data it carries. */
export type ReplyCategory = "ok" | "err" | "silent" | "data";

/**
 * Sort a reply into the four kinds that mean something across devices.
 *
 * The data in an answer belongs to the unit — its programs, its detector
 * readings, its calibration. What carries over from a capture of one device to
 * a test of another is the *kind* of answer: a command the vendor's unit
 * acknowledged should not be rejected by yours.
 */
export function replyCategory(reply: string): ReplyCategory {
  if (reply === "") return "silent";
  if (reply === ":ok") return "ok";
  if (reply === ":err") return "err";
  return "data";
}

/** The kinds of answer a capture shows for a command. */
export function capturedCategories(
  expectations: ReadonlyMap<string, Set<string>>,
  key: string,
): Set<ReplyCategory> | null {
  const shapes = expectations.get(key);
  if (!shapes) return null;
  return new Set([...shapes].map(replyCategory));
}

/**
 * Pair each command in a capture with the answers the device gave it.
 *
 * A command with no reply before the next command maps to `""` — the device
 * stayed silent, which is itself an expectation (the display answers no `:w`
 * frame).
 */
export function captureExpectations(lines: readonly CaptureLine[]): Map<string, Set<string>> {
  const expectations = new Map<string, Set<string>>();
  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i]!;
    if (entry.direction !== "TX") continue;
    const key = expectationKey(entry.line);
    if (key === null) continue;
    const next = lines[i + 1];
    const reply = next && next.direction === "RX" ? replyShape(next.line) : "";
    let shapes = expectations.get(key);
    if (!shapes) expectations.set(key, (shapes = new Set()));
    shapes.add(reply);
  }
  return expectations;
}

/** Merge one expectation table into another. */
export function mergeExpectations(
  into: Map<string, Set<string>>,
  from: ReadonlyMap<string, Set<string>>,
): Map<string, Set<string>> {
  for (const [key, shapes] of from) {
    let target = into.get(key);
    if (!target) into.set(key, (target = new Set()));
    for (const shape of shapes) target.add(shape);
  }
  return into;
}

/** Load every `.dmslog8` capture in a directory tree into one expectation table. */
export async function loadCaptureExpectations(
  directory: string,
): Promise<{ expectations: Map<string, Set<string>>; files: string[] }> {
  const { readdir, readFile } = await import("node:fs/promises");
  const entries = await readdir(directory, { recursive: true, encoding: "utf8" });
  const expectations = new Map<string, Set<string>>();
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".dmslog8")) continue;
    // One file at a time: a capture can hold hundreds of thousands of lines.
    mergeExpectations(expectations, captureExpectations(decodeDmsLog(await readFile(`${directory}/${entry}`))));
    files.push(entry);
  }
  return { expectations, files };
}

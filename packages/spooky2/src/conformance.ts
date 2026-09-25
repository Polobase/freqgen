/**
 * Gen X Pro conformance suite — drive a real unit and check it against the
 * behaviour recovered from the display MCU's firmware.
 *
 * It exists to compare two firmwares: run it on the original, record the
 * result, flash your own, run it again and diff. Each case does both jobs at
 * once — it asserts what the recovered spec says should happen
 * (`open-spooky2/docs/serial-commands.md`, `docs/spec/protocols.md`), and it
 * records the exact reply so a later run can be diffed byte for byte, which
 * also catches undocumented behaviour a spec assertion would never look for.
 *
 * It covers every command the reference documents, except the ones that would
 * damage or disturb the unit: `:w96=12321,` (erases all programs), `:w95=12021,`
 * (reboot), `:w00=` (writes the bootloader page on the original firmware),
 * `:w91=` (the vendor session handshake), and the calibration *writes*
 * `:w60`/`:w61`/`:w62`/`:w63`/`:w80`. The calibration *read* `:r80=0,` is
 * included. No output is ever enabled, and the one program slot it writes is
 * dumped first and restored afterwards.
 */

import { GenXPro } from "./genx-pro.js";
import { encodeGenXFrequency } from "./genx-wire.js";
import { capturedCategories, expectationKey, replyCategory, replyShape } from "./capture.js";

/** One executed check. */
export interface ConformanceCase {
  /** Stable identifier — the key a baseline diff matches on. */
  id: string;
  group: "link" | "registers" | "programs" | "parser" | "display" | "handshake" | "calibration" | "biofeedback";
  description: string;
  /** Commands sent, in order. */
  sent: string[];
  /** Replies received, in order. `""` is a command the device did not answer. */
  received: string[];
  /** What the spec says to expect, when the case asserts something. */
  expected?: string;
  ok: boolean;
  /** Why it failed, or a note worth carrying into the report. */
  detail?: string;
  /**
   * Replies that legitimately differ every run (live detector readings, a
   * unit's own calibration table). They are checked for shape and recorded, but
   * skipped by {@link compareReports}.
   */
  volatile?: boolean;
  /**
   * Set where the case deliberately does something the vendor software never
   * does — an out-of-range slot, a line built to be dropped. A capture says
   * nothing about those, so it is not consulted for them.
   */
  noVendorCounterpart?: boolean;
  /**
   * The check against a capture of the vendor software driving a real unit,
   * when one was supplied and covers this command.
   */
  capture?: {
    /** The command key the expectation was looked up under. */
    key: string;
    /** The kinds of answer the captured device gave. */
    expected: string[];
    /** The kind of answer this device gave. */
    actual: string;
    ok: boolean;
  };
}

export interface ConformanceReport {
  recordedAt: string;
  device: { firmware: number | null; revision: string | null; authenticated: boolean };
  /** The program slot the suite borrowed. */
  slot: number;
  cases: ConformanceCase[];
}

export interface ConformanceDifference {
  id: string;
  description: string;
  baseline: string | null;
  current: string | null;
}

/**
 * How long to leave a display-handled `:w` frame to be processed before
 * sending the next command. While one is pending the link discards incoming
 * bytes (open-spooky2 `src/link.c:284`), so a command sent too soon is lost.
 */
const DISPLAY_SETTLE_MS = 150;

/** Every group, in the order the suite runs them. */
export const CONFORMANCE_GROUPS = [
  "link",
  "registers",
  "programs",
  "parser",
  "handshake",
  "calibration",
  "biofeedback",
  "display",
] as const;

export interface ConformanceOptions {
  /**
   * Program slot to borrow for the read/write cases, 1–30. Its contents are
   * dumped first and restored afterwards. Default 30, the slot a preset load
   * reaches last.
   */
  slot?: number;
  /** Only run these groups. Default: all of them. */
  groups?: ReadonlyArray<ConformanceCase["group"]>;
  /**
   * What a real device answered, from captures of the vendor software
   * (`loadCaptureExpectations`). Where a capture covers a command this suite
   * sends, the reply must be the same *kind* of answer — acknowledged, rejected,
   * silent or data. The data itself is not compared: it belongs to the unit the
   * capture was taken from.
   */
  expectations?: ReadonlyMap<string, Set<string>>;
  /** Called as each case finishes, for progress output. */
  onCase?: (result: ConformanceCase) => void;
}

/** Run the suite against a connected, opened {@link GenXPro}. */
export async function runConformance(
  pro: GenXPro,
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const slot = options.slot ?? 30;
  if (!Number.isInteger(slot) || slot < 1 || slot > 30) {
    throw new Error(`conformance slot must be an integer 1…30, got ${slot}`);
  }
  const wanted = (group: ConformanceCase["group"]) => !options.groups || options.groups.includes(group);
  const cases: ConformanceCase[] = [];
  const ss = String(slot).padStart(2, "0");

  // Anything the handshake left in the buffer would answer the first case.
  await pro.resync();
  const device = {
    firmware: await pro.readFirmwareVersion(),
    revision: await pro.readDisplayRevision(),
    authenticated: pro.authenticated,
  };

  /** Run one case: send commands, record replies, judge the result. */
  const check = async (
    spec: Omit<ConformanceCase, "sent" | "received" | "ok" | "detail">,
    commands: string[],
    judge: (replies: string[]) => string | null,
  ): Promise<ConformanceCase> => {
    const received: string[] = [];
    let detail: string | null;
    try {
      for (const command of commands) received.push(await pro.raw(command));
      detail = judge(received);
    } catch (error) {
      detail = `threw: ${(error as Error).message}`;
    }

    // Second opinion: what the vendor's own software got out of a real unit.
    let capture: ConformanceCase["capture"];
    const key = options.expectations && !spec.noVendorCounterpart ? expectationKey(commands.at(-1) ?? "") : null;
    const expectedKinds = key === null ? null : capturedCategories(options.expectations!, key);
    if (key !== null && expectedKinds !== null) {
      const actual = replyCategory(received.at(-1) ?? "");
      const ok = expectedKinds.has(actual);
      capture = { key, expected: [...expectedKinds], actual, ok };
      if (!ok && detail === null) {
        detail =
          `the capture shows the device answering ${[...expectedKinds].join(" or ")} here, ` +
          `this one answered ${actual} (${JSON.stringify(replyShape(received.at(-1) ?? ""))})`;
      }
    }

    const result: ConformanceCase = {
      ...spec,
      sent: commands,
      received,
      ok: detail === null,
      ...(detail ? { detail } : {}),
      ...(capture ? { capture } : {}),
    };
    cases.push(result);
    options.onCase?.(result);
    return result;
  };

  const is = (expected: string) => (replies: string[]) =>
    replies.at(-1) === expected ? null : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(replies.at(-1))}`;
  const matches = (re: RegExp) => (replies: string[]) =>
    re.test(replies.at(-1) ?? "") ? null : `expected ${re}, got ${JSON.stringify(replies.at(-1))}`;
  /** A write the generator acknowledges — or rejects, if it has no such register. */
  const acknowledged = matches(/^:(ok|err)$/);

  // ── link ────────────────────────────────────────────────────────────────
  if (wanted("link")) {
    await check(
      { id: "link-revision", group: "link", description: "display revision (:n00=$), answered even when locked", expected: ":Rev<n>" },
      [":n00=$"],
      matches(/^:Rev\d+$/),
    );
    await check(
      { id: "link-firmware", group: "link", description: "generator firmware version (:r02=0,)", expected: ":r02=<n>." },
      [":r02=0,"],
      matches(/^:r02=\d+\.?$/),
    );
    await check(
      {
        id: "link-w16-display-only",
        group: "link",
        description: "register 16 exists only in the display, so the generator rejects it",
        expected: ":err (or :ok on a generator that has it)",
      },
      [":w16=0,"],
      // The display defers w16 and does nothing with it; the reply comes from
      // the generator, which has no such register.
      matches(/^(:ok|:err)?$/),
    );
  }

  // ── live registers (outputs stay off, amplitude stays at 0) ─────────────
  if (wanted("registers")) {
    const reg = (id: string, description: string, commands: string[]) =>
      check({ id, group: "registers", description, expected: ":ok" }, commands, acknowledged);

    await reg("reg-frequency", "Out 1 / Out 2 frequency (:w24=/:w25=)", [
      `:w24=${encodeGenXFrequency(727.5)},`,
      `:w25=${encodeGenXFrequency(727.5)},`,
    ]);
    await reg("reg-frequency-idle", "idle frequency (:w24=0,)", [":w24=0,"]);
    await reg("reg-amplitude", "amplitude, both outputs (:w28=/:w29=)", [":w28=0,", ":w29=0,"]);
    await reg("reg-offset", "offset / header value 2 (:w32=120,/:w33=120,)", [":w32=120,", ":w33=120,"]);
    await reg("reg-waveform", "waveform of each output (:w20=/:w21=)", [":w20=11,", ":w21=11,"]);
    await reg("reg-sync", "Out 2 follows Out 1 (:w14=)", [":w14=1,", ":w14=0,"]);
    await reg("reg-inversion", "the display's idle-configuration write (:w17=0,1,)", [":w17=0,1,", ":w17=0,0,"]);
    await reg("reg-w13", "sent by Spooky2 before a step, meaning unknown (:w13=0,)", [":w13=0,"]);
    await reg("reg-w15", "sent 1,1 during setup and 0,0 when PC mode ends (:w15=)", [":w15=1,1,", ":w15=0,0,"]);
    await reg("reg-w40", "sent around gate changes, meaning unknown (:w40=0,)", [":w40=0,"]);
    await reg("reg-jig-w36-w37", "calibration-jig registers (:w36=0,/:w37=0,)", [":w36=0,", ":w37=0,"]);
    await reg("reg-gate-times", "gate parameters, 5 digits each (:w50=/:w51=)", [
      ":w50=00125,00125,",
      ":w51=00125,00125,",
    ]);
    await reg("reg-gating", "gating on then off (:w12=), both fields and one", [
      ":w12=1,1,",
      ":w12=0,0,",
      ":w12=0,,",
      ":w12=,0,",
    ]);
    await reg("reg-output-single-field", "one output addressed, the other left alone (:w11=0,,)", [
      ":w11=0,,",
      ":w11=,0,",
      ":w11=0,0,",
    ]);
  }

  // ── borrowed slot: everything that writes program memory ────────────────
  if (wanted("programs") || wanted("parser")) {
    const savedName = await pro.raw(`:n${ss}=?`);
    const savedProgram = await pro.raw(`:n${ss}=*`);
    const savedGate = await pro.raw(`:n${ss}=#`);

    try {
      if (wanted("programs")) {
        await check(
          { id: "prog-upload", group: "programs", description: "gate, parameters and name accepted", expected: ":ok" },
          [`:g${ss}=0,0,125,125,`, `:p${ss}=41,2000,120,180,2,7836,10008,`, `:n${ss}=freqgen conformance`],
          is(":ok"),
        );
        await check(
          { id: "prog-name-readback", group: "programs", description: "name reads back (:n=?)", expected: `:n${ss}=freqgen conformance` },
          [`:n${ss}=?`],
          is(`:n${ss}=freqgen conformance`),
        );
        await check(
          {
            id: "prog-dump-roundtrip",
            group: "programs",
            description: "program dump (:n=*) returns the stored line, re-uploadable as-is",
            expected: `:p${ss}=41,2000,120,180,2,7836,10008,`,
          },
          [`:n${ss}=*`],
          is(`:p${ss}=41,2000,120,180,2,7836,10008,`),
        );
        await check(
          {
            id: "prog-gate-dump-200",
            group: "programs",
            description: "gate dump (:n=#) returns 200 of the 400 values, ours first",
            expected: "200 values starting 0,0,125,125",
          },
          [`:n${ss}=#`],
          (replies) => {
            const values = dumpValues(replies.at(-1) ?? "", "g", ss);
            if (values === null) return `expected a :g${ss}= dump, got ${JSON.stringify(replies.at(-1))}`;
            if (values.slice(0, 4).join(",") !== "0,0,125,125") {
              return `the written pair did not come back: ${values.slice(0, 4).join(",")}`;
            }
            return values.length === 200 ? null : `expected 200 values, got ${values.length}`;
          },
        );
        await check(
          { id: "prog-slot-31-rejected", group: "programs", description: "slot 31 is out of range", expected: ":err", noVendorCounterpart: true },
          [":p31=41,2000,120,180,1,7836,"],
          is(":err"),
        );
        await check(
          { id: "prog-slot-0-rejected", group: "programs", description: "slot 0 is not a program slot", expected: ":err", noVendorCounterpart: true },
          [":p00=41,2000,120,180,1,7836,"],
          is(":err"),
        );
        await check(
          { id: "prog-erase-slot", group: "programs", description: "single-slot erase (:n=,) leaves the slot empty", expected: `:p${ss}=` },
          [`:n${ss}=,`, `:n${ss}=*`],
          is(`:p${ss}=`),
        );
      }

      // ── parser rules the reference sets out ─────────────────────────────
      if (wanted("parser")) {
        await check(
          {
            id: "parser-dot-separator",
            group: "parser",
            description: "a dot separates values exactly like a comma",
            expected: `:p${ss}=0,2000,120,1,1,100007,`,
          },
          [`:g${ss}=0.0.`, `:p${ss}=0.2000.120.1.1.100007.`, `:n${ss}=*`],
          is(`:p${ss}=0,2000,120,1,1,100007,`),
        );
        await check(
          {
            id: "parser-trailing-value-dropped",
            group: "parser",
            description: "a value with no comma after it is never evaluated",
            expected: "the dump does not contain 200007",
          },
          [`:p${ss}=0,2000,120,1,2,100007,200007`, `:n${ss}=*`],
          (replies) => {
            const values = dumpValues(replies.at(-1) ?? "", "p", ss);
            if (values === null) return `expected a :p${ss}= dump, got ${JSON.stringify(replies.at(-1))}`;
            // The program array is persistent RAM written by index, so the
            // dropped value leaves whatever the previous upload put there —
            // what matters is that 200007 never arrived.
            return values.includes(200007) ? `200007 was stored: ${values.join(",")}` : null;
          },
        );
        await check(
          {
            id: "parser-empty-value-all-ones",
            group: "parser",
            description: "an empty value stores all-ones, which the dump then reports as an empty table",
            // The dump sends nothing when the first entry is 0xFFFF
            // (open-spooky2 src/link.c:502), so an empty answer here is the
            // proof that the empty value became all-ones.
            expected: `:g${ss}= (empty)`,
          },
          [`:g${ss}=,,`, `:p${ss}=0,2000,120,1,1,100007,`, `:n${ss}=#`],
          is(`:g${ss}=`),
        );
        await check(
          {
            id: "parser-long-name-dropped",
            group: "parser",
            description: "a name of 60+ characters aborts the line, so nothing is answered",
            expected: "no reply",
            noVendorCounterpart: true,
          },
          [`:n${ss}=${"x".repeat(60)}`],
          is(""),
        );
        await check(
          {
            id: "parser-long-token-dropped",
            group: "parser",
            description: "a value token of 27+ characters drops the whole line",
            expected: "no reply",
            noVendorCounterpart: true,
          },
          [`:p${ss}=${"1".repeat(27)},`],
          is(""),
        );
      }
    } finally {
      await restoreSlot(pro, ss, savedName, savedProgram, savedGate);
    }
  }

  // ── the display's own handshake answer ──────────────────────────────────
  if (wanted("handshake")) {
    // `:w92` with no response value is not a handshake. The original firmware
    // rejects it and stays quiet; a firmware that accepts any value pulses PB2
    // and sends a `:w91=0,` of its own about 20 ms later. Both are recorded —
    // this is a difference a baseline diff should report, not a failure.
    const answer = await pro.raw(":w92=,");
    const following = await pro.readUnsolicited(300);
    const acceptable = /^(:ok|:err|:w91=0,)?$/.test(answer) && /^(:w91=0,)?$/.test(following);
    cases.push({
      id: "handshake-w92",
      group: "handshake",
      description: "answer to :w92, and the :w91 the display may send after it",
      sent: [":w92=,"],
      received: [answer, following],
      expected: ":ok/:err, then :w91=0, or nothing",
      ok: acceptable,
      noVendorCounterpart: true,
      ...(acceptable ? {} : { detail: `unexpected pair ${JSON.stringify([answer, following])}` }),
    });
    options.onCase?.(cases.at(-1)!);
    // That PB2 pulse and any extra line must not bleed into the next case.
    await pro.resync();
  }

  // ── calibration, read only ──────────────────────────────────────────────
  if (wanted("calibration")) {
    await check(
      {
        id: "cal-read-table",
        group: "calibration",
        description: "read the calibration table (:r80=0,)",
        expected: ":w80=13583792,<21 values>,",
        volatile: true, // every unit's table is its own
      },
      [":r80=0,"],
      (replies) => {
        // Confirmed on a real unit: the generator answers the host with all 21
        // values. (An earlier run saw silence here — that was a desynchronised
        // link, not the device.)
        const reply = replies.at(-1) ?? "";
        const m = /^:w80=13583792,(.*)$/.exec(reply);
        if (!m) return `expected :w80=13583792,…, got ${JSON.stringify(reply)}`;
        const values = m[1]!.split(",").filter((v) => v !== "");
        return values.length === 21 ? null : `expected 21 values, got ${values.length}`;
      },
    );
  }

  // ── biofeedback (read-only, values vary every read) ─────────────────────
  if (wanted("biofeedback")) {
    await check(
      { id: "bfb-current", group: "biofeedback", description: "current detector (:r11=,)", expected: ":r11=<n>.", volatile: true },
      [":r11=,"],
      matches(/^:r11=-?\d+\.?$/),
    );
    await check(
      { id: "bfb-angle", group: "biofeedback", description: "phase detector (:r12=,)", expected: ":r12=<n>.", volatile: true },
      [":r12=,"],
      matches(/^:r12=-?\d+\.?$/),
    );
  }

  // ── display: the visible ones, run last and put back ────────────────────
  if (wanted("display")) {
    const savedTitle = await pro.raw(":n00=?");
    const title = /^:n00=(.*)$/.exec(savedTitle)?.[1] ?? "";

    /**
     * A display-handled `:w` frame is processed in the main loop, and while it
     * is pending the link discards every byte that arrives (open-spooky2
     * src/link.c:284). Sending the next one straight away loses it — which is
     * how a backlight restore goes missing and leaves the screen dark.
     */
    const settle = () => new Promise((r) => setTimeout(r, DISPLAY_SETTLE_MS));

    await check(
      { id: "display-title", group: "display", description: "PC-mode title (:n00=<text>), shown on screen in PC mode", expected: ":n00=freqgen conformance" },
      [":n00=freqgen conformance", ":n00=?"],
      is(":n00=freqgen conformance"),
    );
    await check(
      {
        id: "display-pc-reset",
        group: "display",
        description: "clear this link's PC display state (:w97=12621,)",
        expected: "the title is cleared",
      },
      [":w97=12621,"],
      () => null, // the display answers nothing; the check is the read below
    );
    await settle();
    await check(
      {
        id: "display-pc-reset-cleared",
        group: "display",
        description: "after :w97 the PC-mode title is gone",
        expected: ":n00=",
      },
      [":n00=?"],
      is(":n00="),
    );

    // Put the title back, then leave a frequency on screen: in PC mode the
    // display mirrors :w24, so the unit ends showing 727.5 Hz rather than 0.
    await pro.raw(`:n00=${title}`);
    await check(
      {
        id: "display-frequency-mirror",
        group: "display",
        description: "frequency shown in PC mode (:w24=), left on screen",
        expected: ":ok",
      },
      [`:w24=${encodeGenXFrequency(727.5)},`],
      acknowledged,
    );

    await check(
      {
        id: "display-backlight-off",
        group: "display",
        description: "backlight off (:w64=10000001,) — the screen goes dark",
        expected: "no reply from the display",
      },
      [":w64=10000001,"],
      matches(/^(:ok|:err)?$/),
    );
    await settle();
    await check(
      {
        id: "display-backlight-on",
        group: "display",
        description: "backlight on again (:w64=18888881,) — the screen comes back",
        expected: "no reply from the display",
      },
      [":w64=18888881,"],
      matches(/^(:ok|:err)?$/),
    );
    await settle();
  }

  return { recordedAt: new Date().toISOString(), device, slot, cases };
}

/** Values from a `:p<slot>=…` / `:g<slot>=…` dump line, or `null` if it is not one. */
function dumpValues(reply: string, letter: "p" | "g", ss: string): number[] | null {
  const m = new RegExp(`^:${letter}${ss}=(.*)$`).exec(reply);
  if (!m) return null;
  return m[1]!.split(",").filter((v) => v !== "").map(Number);
}

/** Put back whatever the borrowed slot held before the suite ran. */
async function restoreSlot(
  pro: GenXPro,
  ss: string,
  savedName: string,
  savedProgram: string,
  savedGate: string,
): Promise<void> {
  const name = new RegExp(`^:n${ss}=(.*)$`).exec(savedName)?.[1] ?? "";
  const program = new RegExp(`^:p${ss}=(.+)$`).exec(savedProgram)?.[1];
  const gate = new RegExp(`^:g${ss}=(.+)$`).exec(savedGate)?.[1];

  if (program === undefined) {
    // The slot was empty: leave it that way, but put the name back if it had one.
    await pro.raw(`:n${ss}=,`);
    if (name !== "") await pro.raw(`:n${ss}=${name}`);
    return;
  }
  if (name !== "") await pro.raw(`:n${ss}=${name}`);
  // Only the values the program actually uses were stored; the dump is the
  // authoritative copy, and `:g` has to precede `:p` to reach flash.
  if (gate !== undefined) await pro.raw(`:g${ss}=${trimGateDump(gate, program)}`);
  await pro.raw(`:p${ss}=${program}`);
}

/**
 * The gate dump is padded out to 200 values; a program only uses two per
 * frequency. Send back just those, so the slot ends up as it started.
 */
function trimGateDump(gate: string, program: string): string {
  const count = Number(program.split(",")[4]);
  const values = gate.split(",").filter((v) => v !== "");
  const used = Number.isFinite(count) && count > 0 ? values.slice(0, 2 * count) : values;
  return used.length > 0 ? `${used.join(",")},` : "";
}

/**
 * Diff a run against a recorded baseline — the original firmware's replies
 * against your own build's.
 *
 * Cases marked {@link ConformanceCase.volatile} are skipped: a live detector
 * reading is never the same twice. A case missing from either side is reported
 * as a difference, so a suite that fails to run a check does not pass silently.
 */
export function compareReports(
  baseline: ConformanceReport,
  current: ConformanceReport,
): ConformanceDifference[] {
  const differences: ConformanceDifference[] = [];
  const currentById = new Map(current.cases.map((c) => [c.id, c]));

  for (const before of baseline.cases) {
    const after = currentById.get(before.id);
    if (before.volatile) continue;
    if (!after) {
      differences.push({ id: before.id, description: before.description, baseline: before.received.join(" | "), current: null });
      continue;
    }
    const a = before.received.join(" | ");
    const b = after.received.join(" | ");
    if (a !== b) differences.push({ id: before.id, description: before.description, baseline: a, current: b });
  }

  const baselineIds = new Set(baseline.cases.map((c) => c.id));
  for (const after of current.cases) {
    if (!baselineIds.has(after.id)) {
      differences.push({ id: after.id, description: after.description, baseline: null, current: after.received.join(" | ") });
    }
  }
  return differences;
}

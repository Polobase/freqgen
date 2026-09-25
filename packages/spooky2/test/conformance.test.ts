import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RecordingTransport } from "@freqgen/core/testing";
import { GenXPro } from "../src/genx-pro.js";
import { runConformance, compareReports } from "../src/conformance.js";

/**
 * A stand-in for the display MCU, behaving as open-spooky2's spec describes
 * (docs/spec/protocols.md §3.3, src/link.c). Only what the suite exercises.
 *
 * `deviations` bends individual behaviours so a test can prove the suite
 * notices — the same thing it has to do against a real custom firmware.
 */
class FakeDisplay {
  slots = new Map<number, { name: string; p: number[]; g: number[] }>();
  staged = new Map<number, number[]>();
  erasedAll = false;
  backlightOn = true;
  /**
   * A frame that arrives while the previous one is still pending is discarded
   * (link.c:284). Display-handled `:w` frames are processed in the main loop,
   * so a command sent straight after one is lost — which is how a backlight
   * restore goes missing and leaves the screen dark.
   */
  private busyUntil = 0;
  settleMs = 20;

  constructor(
    private deviations: { gateDumpLength?: number; acceptAnySlot?: boolean; silentCalRead?: boolean } = {},
  ) {}

  respond = (raw: string): string | string[] | undefined => {
    const cmd = raw.trim();
    const n = (s: string) => Number.parseInt(s, 10);

    // A value token of 27 characters or more aborts the frame (link.c:242-243).
    const payload = /^:[wpgn]\d\d=(.*)$/.exec(cmd)?.[1];
    if (payload !== undefined && !cmd.startsWith(":n") && payload.split(/[,.]/).some((t) => t.length >= 27)) {
      return undefined;
    }

    const name = /^:n(\d\d)=(.*)$/.exec(cmd);
    if (name) {
      const slot = n(name[1]!);
      const text = name[2]!;
      if (text === "$") return ":Rev201";
      if (slot > 30 && !this.deviations.acceptAnySlot) return ":err";
      const entry = this.slots.get(slot);
      if (text === "?") return `:n${name[1]}=${entry?.name ?? ""}`;
      if (text === "*") return entry ? `:p${name[1]}=${entry.p.join(",")},` : `:p${name[1]}=`;
      if (text === "#") {
        if (!entry || entry.g[0] === 0xffff) return `:g${name[1]}=`;
        // The firmware dumps the first 200 of the 400 stored values.
        const len = this.deviations.gateDumpLength ?? 200;
        const padded = [...entry.g, ...new Array(Math.max(0, len - entry.g.length)).fill(0)].slice(0, len);
        return `:g${name[1]}=${padded.join(",")},`;
      }
      if (text === ",") {
        this.slots.delete(slot);
        return ":ok";
      }
      if (text.length > 59) return undefined; // line dropped, no reply
      this.slots.set(slot, { name: text, p: entry?.p ?? [], g: entry?.g ?? [] });
      return ":ok";
    }

    const gate = /^:g(\d\d)=(.*)$/.exec(cmd);
    if (gate) {
      const slot = n(gate[1]!);
      if ((slot < 1 || slot > 30) && !this.deviations.acceptAnySlot) return ":err";
      this.staged.set(slot, values(gate[2]!));
      return ":ok";
    }

    const prog = /^:p(\d\d)=(.*)$/.exec(cmd);
    if (prog) {
      const slot = n(prog[1]!);
      if ((slot < 1 || slot > 30) && !this.deviations.acceptAnySlot) return ":err";
      const entry = this.slots.get(slot);
      // The program array is persistent RAM written by index, so a value the
      // parser never evaluated leaves whatever was in that slot before.
      const merged = [...(entry?.p ?? [])];
      values(prog[2]!).forEach((v, i) => (merged[i] = v));
      // :g is only persisted when the next :p arrives.
      this.slots.set(slot, { name: entry?.name ?? "", p: merged, g: this.staged.get(slot) ?? entry?.g ?? [] });
      return ":ok";
    }

    if (cmd.startsWith(":w96=")) {
      this.erasedAll = true;
      this.slots.clear();
      return ":ok";
    }
    if (cmd.startsWith(":w64=") || cmd.startsWith(":w97=")) {
      if (Date.now() < this.busyUntil) return undefined; // discarded, still pending
      this.busyUntil = Date.now() + this.settleMs;
    }
    if (cmd.startsWith(":w64=")) this.backlightOn = cmd.startsWith(":w64=18888881");
    if (cmd.startsWith(":w97=")) {
      // Clears this link's frequencies and both PC-mode names (slots 0 and 31).
      this.slots.delete(0);
      this.slots.delete(31);
      return ":ok";
    }
    if (cmd.startsWith(":r02=")) return ":r02=200.";
    if (cmd.startsWith(":r11=")) return ":r11=46210.";
    if (cmd.startsWith(":r12=")) return ":r12=5784.";
    // A w92 without a valid response value is rejected by the generator; the
    // display still pulses PB2 and sends its own w91.
    if (cmd.startsWith(":w92=")) return [":err", ":w91=0,"];
    // The generator answers the calibration read with its 21 values.
    if (cmd.startsWith(":r80=")) {
      return this.deviations.silentCalRead
        ? undefined
        : `:w80=13583792,${new Array(21).fill(0).map((_, i) => 1000 + i).join(",")},`;
    }
    // Register 16 exists only in the display; the generator rejects it.
    if (cmd.startsWith(":w16=")) return ":err";
    return ":ok"; // the generator answers every other :w
  };
}

/**
 * Parse a value list the way the firmware's line parser does: `.` separates
 * like `,`, an empty value is all-ones, and a value with no separator after it
 * is never evaluated (docs/serial-commands.md §2).
 */
const values = (s: string, allOnes = 0xffff) => {
  const tokens = s.split(/[,.]/);
  tokens.pop(); // the text after the last separator is dropped
  return tokens.map((t) => (t === "" ? allOnes : Number(t)));
};

async function device(display: FakeDisplay) {
  const transport = new RecordingTransport({ responder: display.respond });
  const pro = new GenXPro(transport, { replyTimeoutMs: 20, authProvider: null });
  await pro.open();
  return { pro, transport };
}

describe("conformance suite", () => {
  it("passes in full against a firmware that follows the spec", async () => {
    const display = new FakeDisplay();
    const { pro } = await device(display);

    const report = await runConformance(pro, { slot: 29 });

    const failed = report.cases.filter((c) => !c.ok);
    assert.deepEqual(failed.map((c) => `${c.id}: ${c.detail}`), []);
    assert.ok(report.cases.length >= 12, `expected a real suite, got ${report.cases.length} cases`);
    assert.equal(report.device.revision, "Rev201");
    assert.equal(report.device.firmware, 200);
  });

  it("never erases the device's program memory", async () => {
    const display = new FakeDisplay();
    const { pro, transport } = await device(display);
    await runConformance(pro, { slot: 29 });
    assert.equal(display.erasedAll, false);
    assert.ok(!transport.writes.some((w) => w.includes(":w96")));
  });

  it("leaves the slot it used exactly as it found it", async () => {
    const display = new FakeDisplay();
    display.slots.set(29, { name: "Mine", p: [41, 2000, 120, 180, 1, 7836], g: [0, 0] });
    const { pro } = await device(display);

    await runConformance(pro, { slot: 29 });

    assert.deepEqual(display.slots.get(29), { name: "Mine", p: [41, 2000, 120, 180, 1, 7836], g: [0, 0] });
  });

  it("leaves a slot that was empty empty", async () => {
    const display = new FakeDisplay();
    const { pro } = await device(display);
    await runConformance(pro, { slot: 29 });
    assert.equal(display.slots.has(29), false);
  });

  it("fails the case a deviating firmware breaks, and only that one", async () => {
    // A firmware that dumps all 400 gate values instead of the original's 200.
    const display = new FakeDisplay({ gateDumpLength: 400 });
    const { pro } = await device(display);

    const report = await runConformance(pro, { slot: 29 });

    const failed = report.cases.filter((c) => !c.ok);
    assert.equal(failed.length, 1, `unexpected failures: ${failed.map((c) => c.id).join(", ")}`);
    assert.match(failed[0]!.id, /gate/);
    assert.match(failed[0]!.detail!, /200/);
  });

  it("diffs a run against a baseline, ignoring readings that always vary", async () => {
    const baseline = await runConformance((await device(new FakeDisplay())).pro, { slot: 29 });
    const current = await runConformance((await device(new FakeDisplay({ gateDumpLength: 400 }))).pro, { slot: 29 });

    const diffs = compareReports(baseline, current);
    // Only the case that dumps a populated table sees the longer reply; the
    // all-ones one is empty whatever the dump length.
    assert.deepEqual(diffs.map((d) => d.id), ["prog-gate-dump-200"]);
    for (const d of diffs) assert.ok(d.current!.length > d.baseline!.length, `${d.id} should be longer`);
    // The volatile calibration and detector reads never show up as differences.
    assert.ok(!diffs.some((d) => /^(cal-|bfb-)/.test(d.id)));
  });

  it("exercises every command the reference documents as safe to send", async () => {
    const display = new FakeDisplay();
    const { pro, transport } = await device(display);
    await runConformance(pro, { slot: 29 });

    // docs/serial-commands.md §3 and §4, minus the excluded set below.
    const documented = [
      ":n00=$", ":n00=?", ":n29=?", ":n29=*", ":n29=#", ":n29=,",
      ":g29=", ":p29=",
      ":r02=", ":r11=", ":r12=", ":r80=",
      ":w11=", ":w12=", ":w13=", ":w14=", ":w15=", ":w16=", ":w17=",
      ":w20=", ":w21=", ":w24=", ":w25=", ":w28=", ":w29=", ":w32=", ":w33=",
      ":w36=", ":w37=", ":w40=", ":w50=", ":w51=", ":w64=", ":w92=", ":w97=",
    ];
    const sent = transport.writes.map((w) => w.trimEnd());
    const missing = documented.filter((c) => !sent.some((w) => w.startsWith(c)));
    assert.deepEqual(missing, [], `commands never sent: ${missing.join(" ")}`);
  });

  it("never sends a command that erases, resets or writes calibration", async () => {
    const display = new FakeDisplay();
    const { pro, transport } = await device(display);
    await runConformance(pro, { slot: 29 });

    // :w80 is write-only calibration; :r80 reads it and is allowed.
    const forbidden = [":w00=", ":w60=", ":w61=", ":w62=", ":w63=", ":w80=", ":w91=", ":w95=", ":w96="];
    const sent = transport.writes.map((w) => w.trimEnd());
    const used = forbidden.filter((c) => sent.some((w) => w.startsWith(c)));
    assert.deepEqual(used, [], `must not be sent: ${used.join(" ")}`);
  });

  it("restores the display title and the backlight it switched", async () => {
    const display = new FakeDisplay();
    display.slots.set(0, { name: "Port 3 - Stopped", p: [], g: [] });
    const { pro, transport } = await device(display);

    await runConformance(pro, { slot: 29 });

    assert.equal(display.slots.get(0)?.name, "Port 3 - Stopped");
    assert.equal(transport.writes.map((w) => w.trimEnd()).at(-1), ":w64=18888881,");
  });

  it("fails a case the vendor's device acknowledged but this one rejects", async () => {
    // What a capture of the real device establishes: w13 is acknowledged.
    const expectations = new Map([["w13", new Set([":ok"])]]);
    const display = new FakeDisplay();
    const rejectsW13 = new FakeDisplay();
    rejectsW13.respond = (raw) => (raw.startsWith(":w13=") ? ":err" : display.respond(raw));

    const { pro } = await device(rejectsW13);
    const report = await runConformance(pro, { slot: 29, expectations });

    const failed = report.cases.filter((c) => !c.ok);
    assert.deepEqual(failed.map((c) => c.id), ["reg-w13"]);
    assert.match(failed[0]!.detail!, /capture/i);
  });

  it("accepts data that differs from the capture, as long as the answer is the same kind", async () => {
    // The vendor only ever dumped empty slots (":p29="); ours holds a program,
    // so the bytes differ but both are data, not a rejection.
    const expectations = new Map([
      ["n*", new Set([":p#="])],
      ["n?", new Set([":n#="])],
      ["p", new Set([":ok"])],
      ["g", new Set([":ok"])],
    ]);
    const { pro } = await device(new FakeDisplay());

    const report = await runConformance(pro, { slot: 29, expectations });

    assert.deepEqual(report.cases.filter((c) => !c.ok).map((c) => c.id), []);
    const dump = report.cases.find((c) => c.id === "prog-dump-roundtrip")!;
    assert.equal(dump.capture?.key, "n*");
    assert.equal(dump.capture?.ok, true);
  });

  it("leaves the backlight on, even though the device drops a frame sent too soon", async () => {
    const display = new FakeDisplay();
    const { pro, transport } = await device(display);

    await runConformance(pro, { slot: 29, groups: ["display"] });

    // Both halves of the blink have to land: the restore is what matters.
    const sent = transport.writes.map((w) => w.trimEnd());
    assert.ok(sent.includes(":w64=10000001,"), "backlight was switched off");
    assert.equal(display.backlightOn, true, "backlight was left off");
  });

  it("records the handshake answer and any :w91 that follows, without demanding one", async () => {
    // The original firmware rejects a :w92 that carries no response value and
    // sends no :w91; a firmware that accepts any value answers one. Both are
    // recorded, and the baseline diff is what reports the difference.
    const { pro } = await device(new FakeDisplay());
    const report = await runConformance(pro, { slot: 29, groups: ["handshake"] });

    const handshake = report.cases.find((c) => c.group === "handshake")!;
    assert.equal(handshake.ok, true, handshake.detail);
    assert.deepEqual(handshake.received, [":err", ":w91=0,"]);
  });

  it("fails when the calibration read goes unanswered", async () => {
    const { pro } = await device(new FakeDisplay({ silentCalRead: true }));
    const report = await runConformance(pro, { slot: 29, groups: ["calibration"] });

    const cal = report.cases.find((c) => c.id === "cal-read-table")!;
    assert.equal(cal.ok, false);
    assert.match(cal.detail!, /:w80=/);
  });

  it("reports no differences between two runs of the same firmware", async () => {
    const a = await runConformance((await device(new FakeDisplay())).pro, { slot: 29 });
    const b = await runConformance((await device(new FakeDisplay())).pro, { slot: 29 });
    assert.deepEqual(compareReports(a, b), []);
  });
});

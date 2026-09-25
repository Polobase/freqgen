import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  decodeDmsLog,
  captureExpectations,
  expectationKey,
  replyShape,
  replyCategory,
} from "../src/capture.js";

// These read real Device Monitoring Studio captures of Spooky2 driving a Gen X
// Pro, which live in the gitignored `local/` tree. Present locally, skipped in CI.
const localDir = fileURLToPath(new URL("../../../local/", import.meta.url));

describe("reply shapes", () => {
  it("keeps the answer's form and drops the numbers that vary", () => {
    assert.equal(replyShape(":ok"), ":ok");
    assert.equal(replyShape(":err"), ":err");
    assert.equal(replyShape(":r02=200."), ":r#=#.");
    assert.equal(replyShape(":r11=46210."), ":r#=#.");
    assert.equal(replyShape(":n01=Schumann Resonance (CAFL)"), ":n#=<text>");
    assert.equal(replyShape(":p07="), ":p#=");
    assert.equal(replyShape(":Rev201"), ":Rev#");
    assert.equal(replyShape(""), "");
  });

  it("sorts an answer into acknowledged, rejected, silent or data", () => {
    // What a comparison between two devices can rely on: the data itself
    // differs from unit to unit, but ":ok where the vendor's device said :ok"
    // holds everywhere.
    assert.equal(replyCategory(":ok"), "ok");
    assert.equal(replyCategory(":err"), "err");
    assert.equal(replyCategory(""), "silent");
    assert.equal(replyCategory(":r11=46210."), "data");
    assert.equal(replyCategory(":p07="), "data");
  });

  it("keys a command by what it addresses, not by its values", () => {
    assert.equal(expectationKey(":w24=3440082640,"), "w24");
    assert.equal(expectationKey(":w24=0,"), "w24");
    assert.equal(expectationKey(":r11=,"), "r11");
    assert.equal(expectationKey(":n00=$"), "n$");
    assert.equal(expectationKey(":n01=?"), "n?");
    assert.equal(expectationKey(":n07=*"), "n*");
    assert.equal(expectationKey(":n07=#"), "n#");
    assert.equal(expectationKey(":n07=,"), "n,");
    assert.equal(expectationKey(":n07=Schumann"), "n=");
    assert.equal(expectationKey(":p07=41,2000,"), "p");
    assert.equal(expectationKey(":g07=0,0,"), "g");
  });
});

(existsSync(localDir) ? describe : describe.skip)("real Spooky2 captures", () => {
  const logs = readdirSync(localDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".dmslog8"))
    .map((f) => `${localDir}${f}`);

  it("finds the capture files", () => {
    assert.ok(logs.length > 0, "no .dmslog8 captures found under local/");
  });

  it("decodes a capture into the traffic both ways", () => {
    const capture6 = logs.find((f) => f.includes("capture6"));
    if (!capture6) return; // a different local/ tree
    const lines = decodeDmsLog(readFileSync(capture6));

    // Same totals the Python decoder reports for this file.
    assert.equal(lines.length, 3756);
    assert.equal(lines[0]!.direction, "TX");
    assert.equal(lines[0]!.line, ":n00=Port 4 - Running Biofeedback");
    assert.equal(lines[1]!.direction, "RX");
    assert.equal(lines[1]!.line, ":ok");
    // Timestamps run forwards, in seconds from the file's first record — which
    // precedes the first line of traffic, so line 0 lands just after zero.
    assert.ok(lines[0]!.t > 0 && lines[0]!.t < 0.01, `first line at ${lines[0]!.t}s`);
    assert.ok(lines.at(-1)!.t > 90);
  });

  it("learns what the real device answers, per command", () => {
    const expectations = captureExpectations(logs.map((f) => decodeDmsLog(readFileSync(f))).flat());

    // The vendor software asks for these on every connect.
    assert.deepEqual([...(expectations.get("n$") ?? [])], [":Rev#"]);
    assert.deepEqual([...(expectations.get("r02") ?? [])], [":r#=#."]);
    // Register writes are acknowledged.
    assert.deepEqual([...(expectations.get("w24") ?? [])], [":ok"]);
    assert.deepEqual([...(expectations.get("w28") ?? [])], [":ok"]);
    // The detectors answer with a number.
    assert.deepEqual([...(expectations.get("r11") ?? [])], [":r#=#."]);
    assert.deepEqual([...(expectations.get("r12") ?? [])], [":r#=#."]);
    // The vendor only ever dumped empty slots, so a dump's data shape is not a
    // usable expectation — its category (data, not :err) is.
    assert.deepEqual([...(expectations.get("n*") ?? [])], [":p#="]);
    assert.deepEqual([...(expectations.get("n#") ?? [])], [":g#="]);
    // The erase-all command was never answered.
    assert.deepEqual([...(expectations.get("w96") ?? [])], [""]);
    // Program storage and name queries.
    assert.deepEqual([...(expectations.get("p") ?? [])], [":ok"]);
    assert.deepEqual([...(expectations.get("g") ?? [])], [":ok"]);
    assert.ok((expectations.get("n?") ?? new Set()).has(":n#=<text>"));
    // Every live register write the vendor made was acknowledged.
    for (const reg of ["w11", "w12", "w13", "w14", "w15", "w17", "w20", "w21", "w25", "w29", "w32", "w33", "w40", "w92"]) {
      assert.deepEqual([...(expectations.get(reg) ?? [])], [":ok"], reg);
    }
  });
});

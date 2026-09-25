import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseCliArgs } from "../src/cli.js";
import { SPOOKY2_DEVICES } from "../src/devices.js";
import { DeviceRegistry } from "@freqgen/core";

describe("parseCliArgs", () => {
  it("treats no arguments as a help request", () => {
    assert.equal(parseCliArgs([]).command, "help");
    assert.equal(parseCliArgs(["--help"]).command, "help");
  });

  it("parses a set command", () => {
    const { command, values } = parseCliArgs([
      "set",
      "--device",
      "xm",
      "--freq",
      "727.5",
      "--on",
    ]);
    assert.equal(command, "set");
    assert.equal(values["device"], "xm");
    assert.equal(values["freq"], "727.5");
    assert.equal(values["on"], true);
  });

  it("rejects contradictory output flags", () => {
    assert.throws(() => parseCliArgs(["set", "--on", "--off"]), /mutually exclusive/);
  });

  it("rejects an unknown command", () => {
    assert.throws(() => parseCliArgs(["frobnicate"]), /Unknown command/);
  });

  it("parses a conformance run that records a baseline", () => {
    const { command, values } = parseCliArgs([
      "conformance",
      "--port",
      "/dev/cu.usbserial-1",
      "--record",
      "original.json",
      "--slot",
      "29",
    ]);
    assert.equal(command, "conformance");
    assert.equal(values["port"], "/dev/cu.usbserial-1");
    assert.equal(values["record"], "original.json");
    assert.equal(values["slot"], "29");
  });

  it("parses a conformance run that compares against one", () => {
    const { values } = parseCliArgs(["conformance", "-p", "/dev/x", "--compare", "original.json"]);
    assert.equal(values["compare"], "original.json");
  });
});

describe("SPOOKY2_DEVICES", () => {
  it("registers every driver", () => {
    const registry = new DeviceRegistry().registerAll(SPOOKY2_DEVICES);
    assert.deepEqual(
      registry.list().map((d) => d.id).sort(),
      ["genx", "genx-pro", "xm"],
    );
  });

  it("marks every driver as unverified, with a note saying what is untested", () => {
    // If one of these ever becomes hardware-verified, this test should be the
    // thing that fails and forces the README matrix to be updated with it.
    for (const d of SPOOKY2_DEVICES) {
      assert.equal(d.verified, false, `${d.id} claims verification it does not have`);
      assert.ok(d.note && d.note.length > 0, `${d.id} has no note`);
    }
  });

  it("explains itself when asked for a driver it does not have", () => {
    const registry = new DeviceRegistry().registerAll(SPOOKY2_DEVICES);
    assert.throws(
      () => registry.create("fy6300", {} as never),
      /Unknown device "fy6300" — registered devices: /,
    );
  });
});

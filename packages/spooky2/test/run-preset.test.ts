import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RecordingTransport } from "@freqgen/core/testing";
import { GenXPro } from "../src/genx-pro.js";
import { parsePreset, presetToProgram } from "../src/presets.js";
import { runPresetRun } from "../src/run-preset.js";

const MANIFESTATION = `"[Preset]"
"PresetName=Spooky Radionics (Boost) Manifestation"
"Sine_WCM=11"
"Out1_Amplitude=20"
"Out2_Amplitude=20"
"Out1_Offset=-100"
"Out2_Offset=100"
"Out1_Sine=True"
"Loaded_Programs=Reality Engineering 1 (CUST)"
"Loaded_Frequencies=36-198=11,396=11,792-4356=11,"
"[/Preset]"`;

const PLANT_GROWTH = `"[Preset]"
"PresetName=Spooky Radionics Plant Growth "
"Out1_Amplitude=20"
"Out1_Offset=100"
"Loaded_Programs=Plant Growth (CUST)"
"Loaded_Frequencies=183.58=2700,"
"[/Preset]"`;

const DNA = `"[Preset]"
"PresetName=Acholeplasma (DNA) (R) - JW"
"Loaded_Programs=Acholeplasma (DNA) (R) - JW (CUST)"
"Loaded_Frequencies=~6891BC97498,~4397BC0540064,"
"[/Preset]"`;

describe("presetToProgram", () => {
  it("turns ranges into ÷WCM sweeps and radionics singles into ÷WCM steps", () => {
    const run = presetToProgram(parsePreset(MANIFESTATION), { channels: [0] });
    assert.equal(run.outputs.length, 1);
    assert.equal(run.outputs[0]!.amplitudeVpp, 20);
    assert.equal(run.outputs[0]!.offsetV, -10); // -100 % of 20 Vpp → −10 V
    assert.equal(run.outputs[0]!.waveform, "sine");

    assert.equal(run.segments.length, 3);
    // 36-198=11 → sweep 36/11 → 198/11 = 3.2727 → 18 Hz, 11 s total
    assert.deepEqual(run.segments[0], {
      type: "sweep",
      startHz: 36 / 11,
      endHz: 198 / 11,
      steps: 84,
      dwellPerStepSeconds: 11 / 84,
    });
    // 396=11 → 396/11 = 36 Hz for 11 s
    assert.deepEqual(run.segments[1], { type: "step", frequencyHz: 36, dwellSeconds: 11 });
    // 792-4356=11 → sweep 72 → 396 Hz
    assert.deepEqual(run.segments[2], {
      type: "sweep",
      startHz: 72,
      endHz: 396,
      steps: 84,
      dwellPerStepSeconds: 11 / 84,
    });
  });

  it("maps Out1/Out2 offsets to volts per channel", () => {
    const run = presetToProgram(parsePreset(MANIFESTATION));
    assert.deepEqual(run.outputs, [
      { channel: 0, amplitudeVpp: 20, offsetV: -10, waveform: "sine", freqFactor: 1, freqConstant: 0 },
      { channel: 1, amplitudeVpp: 20, offsetV: 10, waveform: "sine", freqFactor: 1, freqConstant: 0 },
    ]);
    // full −100 %/+100 % offset clips a 20 Vpp signal → reported, not clamped
    assert.ok(run.warnings.some((w) => w.includes("will clip")));
  });

  it("derives Out 2's frequency transform from Out2_Hz_Factor/Constant", () => {
    const dual = `"[Preset]"
"PresetName=Dual"
"Out2_Hz_Factor=.25"
"Out2_Hz_Constant=358500"
"Out1_Sine=True"
"Loaded_Programs=P (CUST)"
"Loaded_Frequencies=1000=180,"
"[/Preset]"`;
    const run = presetToProgram(parsePreset(dual));
    assert.deepEqual(
      run.outputs.map((o) => [o.channel, o.freqFactor, o.freqConstant]),
      [
        [0, 1, 0], // Out 1: program frequency as-is
        [1, 0.25, 358500], // Out 2 = Out 1 × .25 + 358500
      ],
    );
  });

  it("keeps standard singles at their literal frequency and dwell", () => {
    const run = presetToProgram(parsePreset(PLANT_GROWTH), { channels: [0] });
    assert.deepEqual(run.segments, [
      { type: "step", frequencyHz: 183.58, dwellSeconds: 2700 },
    ]);
  });

  it("skips DNA entries and reports them", () => {
    const run = presetToProgram(parsePreset(DNA), { channels: [0] });
    assert.equal(run.segments.length, 0);
    assert.ok(run.warnings.some((w) => w.includes("6891BC97498")));
  });
});

describe("runPresetRun", () => {
  async function pro(): Promise<{ transport: RecordingTransport; device: GenXPro }> {
    const transport = new RecordingTransport({ defaultResponse: ":ok" });
    const device = new GenXPro(transport, { replyTimeoutMs: 20, authProvider: null });
    await device.open();
    transport.clear();
    return { transport, device };
  }

  it("configures once, then loops frequency, matching the capture's structure", async () => {
    const { transport, device } = await pro();
    const run = presetToProgram(parsePreset(MANIFESTATION), { channels: [0] });

    await runPresetRun(device, run, { sleep: async () => {} });

    const writes = transport.writes.map((w) => w.trimEnd());
    // setup: waveform 11 (sine), amplitude 20 Vpp → peak centivolts 1000,
    // offset −100 % → 20, output on
    assert.ok(writes.includes(":w20=11,"));
    assert.ok(writes.includes(":w28=1000,"));
    assert.ok(writes.includes(":w32=20,"));
    assert.ok(writes.includes(":w11=1,,"));

    // amplitude and offset written once, not per step
    assert.equal(writes.filter((w) => w.startsWith(":w28=")).length, 1);
    assert.equal(writes.filter((w) => w.startsWith(":w32=")).length, 1);

    // frequency loop: first sweep starts at 36/11 = 3.2727 Hz (exponent-encoded),
    // then the 36 Hz single, then the high sweep from 72 Hz
    const freqs = writes.filter((w) => w.startsWith(":w24="));
    assert.equal(freqs[0], ":w24=3272727270,"); // 3.2727 Hz
    assert.ok(freqs.includes(":w24=368,")); // 36 Hz single (minimal encoding)
    assert.ok(freqs.includes(":w24=728,")); // 72 Hz (high sweep start)
    // 2 sweeps × (84 steps + 1) + 1 single = 171 frequency writes
    assert.equal(freqs.length, 171);

    // output off at the end
    assert.equal(writes.at(-1), ":w11=0,,");
  });

  it("drives both channels with their own offset, ending output off", async () => {
    const { transport, device } = await pro();
    const run = presetToProgram(parsePreset(MANIFESTATION));

    await runPresetRun(device, run, { sleep: async () => {} });

    const writes = transport.writes.map((w) => w.trimEnd());
    // both channels driven: w28/w29 amplitudes, w32/w33 offsets
    assert.ok(writes.includes(":w28=1000,"));
    assert.ok(writes.includes(":w29=1000,"));
    assert.ok(writes.includes(":w32=20,")); // Out 1 −100 %
    assert.ok(writes.includes(":w33=220,")); // Out 2 +100 %
  });

  it("drives Out 2 at Out 1 × factor (the DNA octave), not the same frequency", async () => {
    const { transport, device } = await pro();
    const dual = `"[Preset]"
"PresetName=Octave"
"Out2_Hz_Factor=64"
"Out1_Sine=True"
"Loaded_Programs=P (CUST)"
"Loaded_Frequencies=1000=180,"
"[/Preset]"`;
    const run = presetToProgram(parsePreset(dual));
    await runPresetRun(device, run, { sleep: async () => {} });

    const writes = transport.writes.map((w) => w.trimEnd());
    assert.ok(writes.includes(":w24=10008,")); // Out 1 = 1000 Hz
    assert.ok(writes.includes(":w25=640008,")); // Out 2 = 64000 Hz (1000 × 64)
  });
});

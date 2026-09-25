import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RecordingTransport } from "@freqgen/core/testing";
import { GenXPro } from "../src/genx-pro.js";
import { GenXPair } from "../src/genx-pair.js";
import { generateNonce } from "../src/auth.js";

async function pro(options = {}) {
  const transport = new RecordingTransport({ defaultResponse: ":ok" });
  const device = new GenXPro(transport, { replyTimeoutMs: 20, ...options });
  await device.open();
  transport.clear();
  return { transport, device };
}

const stripCRLF = (writes: string[]) => writes.map((w) => w.trimEnd());

describe("GenXPro link setup", () => {
  it("opens the port at the documented framing", async () => {
    const transport = new RecordingTransport({ defaultResponse: ":ok" });
    await new GenXPro(transport, { replyTimeoutMs: 20 }).open();
    assert.deepEqual(transport.openOptions, {
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
    });
  });

  it("connects without an authProvider but reports output as gated", async () => {
    const { device } = await pro();
    assert.equal(device.authenticated, false);
    assert.equal(device.capabilities.requiresAuth, true);
    // The arm/ramp requirement was an artefact of a mis-read register map.
    assert.equal(device.capabilities.requiresFrequencyRamp, false);
  });
});

describe("GenXPro register map (hardware-confirmed)", () => {
  it("writes an exponent-encoded frequency to the output's own register, field 1", async () => {
    // Confirmed by reading the device display: :w24=10008, → 1000.0 Hz on Out1,
    // :w25=10008, → 1000.0 Hz on Out2. The value goes in field 1 for BOTH.
    const { transport, device } = await pro();
    await device.setFrequency(0, 1000);
    await device.setFrequency(1, 1000);
    assert.deepEqual(stripCRLF(transport.writes), [":w24=10008,", ":w25=10008,"]);
  });

  it("encodes fractional frequencies with the exponent digit", async () => {
    // 727.5 Hz → mantissa 7275, exponent code 7 → 72757 (display 727.5 Hz).
    const { transport, device } = await pro();
    await device.setFrequency(0, 727.5);
    assert.deepEqual(stripCRLF(transport.writes), [":w24=72757,"]);
  });

  it("writes amplitude to register 28/29, field 1 (peak centivolts)", async () => {
    const { transport, device } = await pro();
    await device.setAmplitude(0, 5);
    await device.setAmplitude(1, 3.3);
    // peak centivolts = vpp × 50, matching the capture's :w28=1000, for 20 Vpp
    assert.deepEqual(stripCRLF(transport.writes), [":w28=250,", ":w29=165,"]);
  });

  it("writes waveform to register 20/21, field 1", async () => {
    const { transport, device } = await pro();
    assert.equal((await device.setWaveform(0, "sine")).code, 11);
    assert.equal((await device.setWaveform(1, "square")).code, 12);
    assert.deepEqual(stripCRLF(transport.writes), [":w20=11,", ":w21=12,"]);
  });

  it("writes offset to register 32/33, field 1, centred on 120", async () => {
    const { transport, device } = await pro();
    await device.setOffsetRatio(0, 0);
    await device.setOffsetRatio(0, 1);
    await device.setOffsetRatio(1, -1);
    // Span ±100 confirmed from the capture: offset −100 → :w32=20, +100 → :w33=220.
    assert.deepEqual(stripCRLF(transport.writes), [":w32=120,", ":w32=220,", ":w33=20,"]);
  });

  it("addresses one output at a time on the shared output register", async () => {
    const { transport, device } = await pro();
    await device.setOutput(0, true);
    await device.setOutput(1, true);
    await device.setOutput(0, false);
    // The empty field leaves the other output alone (open-spooky2 src/link.c:116-127).
    assert.deepEqual(stripCRLF(transport.writes), [
      ":w11=1,,",
      ":w11=,1,",
      ":w11=0,,",
    ]);
  });
});

describe("GenXPro phase", () => {
  it("sets Out 2 phase on register 40, field 1", async () => {
    const { transport, device } = await pro();
    await device.setPhase(1, 90);
    assert.deepEqual(stripCRLF(transport.writes), [":w40=90,"]);
  });

  it("refuses an Out 1 phase, which the device has no register for", async () => {
    const { device } = await pro();
    await device.setPhase(0, 0); // 0 is a no-op
    await assert.rejects(device.setPhase(0, 45), /no Out 1 phase register/);
  });
});

describe("GenXPro per-output extras", () => {
  it("drives gating, modulation, sync, inversion and low-frequency mode", async () => {
    const { transport, device } = await pro();
    await device.setGating(0, true);        // gating → w12, TWO fields (per capture)
    await device.setGating(1, true);        // Out2 gating → w12 field 2 (not w70)
    await device.setModulation(true);       // Out2 modulation → w13, field 1
    await device.setSync(true);             // Out2 sync → w14, field 1
    await device.setInversion(0, true);     // inversion → w17, TWO fields (shared)
    await device.setLowFrequencyMode(1, true); // Out2 LF mode → w15 field 2 (per capture)
    assert.deepEqual(stripCRLF(transport.writes), [
      ":w12=1,,",
      ":w12=,1,",
      ":w13=1,",
      ":w14=1,",
      ":w17=1,,",
      ":w15=,1,",
    ]);
  });

  it("sets gate times and resets", async () => {
    const { transport, device } = await pro();
    await device.setGateTimes(0, 125, 125);
    await device.reset();
    assert.deepEqual(stripCRLF(transport.writes), [":w50=00125,00125,", ":w95=12021,"]);
  });
});

describe("GenXPro unsupported parameters", () => {
  it("accepts a 50 % duty (the neutral every preset carries) and refuses others", async () => {
    const { device } = await pro();
    await device.setDutyCycle(0, 50);
    await assert.rejects(device.setDutyCycle(0, 25), /No duty-cycle register/);
  });
});

describe("GenXPro applyStep", () => {
  it("drives the channel as plain register writes, output last", async () => {
    const { transport, device } = await pro();
    await device.applyStep(0, {
      waveform: "square",
      frequencyHz: 1000,
      amplitudeVpp: 5,
      output: true,
    });
    assert.deepEqual(stripCRLF(transport.writes), [
      ":w20=12,",
      ":w24=10008,",
      ":w28=250,",
      ":w11=1,,",
    ]);
  });
});

describe("GenXPro device info", () => {
  it("reads the firmware version off :r02, matching the capture", async () => {
    const transport = new RecordingTransport({
      responder: (cmd) => (cmd.startsWith(":r02=") ? ":r02=200." : ":ok"),
    });
    const device = new GenXPro(transport, { replyTimeoutMs: 20, authProvider: null });
    await device.open();
    assert.equal(await device.readFirmwareVersion(), 200);
  });

  it("returns null when the device does not answer with a number", async () => {
    const transport = new RecordingTransport({
      responder: () => ":err",
    });
    const device = new GenXPro(transport, { replyTimeoutMs: 20, authProvider: null });
    await device.open();
    assert.equal(await device.readFirmwareVersion(), null);
  });
});

describe("GenXPro biofeedback", () => {
  it("reads current and phase angle off the detector registers", async () => {
    const transport = new RecordingTransport({
      responder: (cmd) => {
        if (cmd.startsWith(":r11=")) return ":r11=41123.";
        if (cmd.startsWith(":r12=")) return ":r12=5186.";
        return ":ok";
      },
    });
    const device = new GenXPro(transport, { replyTimeoutMs: 20, authProvider: null });
    await device.open();
    assert.deepEqual(await device.readBiofeedback(), { current: 41123, phaseAngle: 5186 });
    assert.equal(await device.readCurrent(), 41123);
    assert.equal(await device.readPhaseAngle(), 5186);
  });

  it("returns null for a reading the device refuses (:err)", async () => {
    const transport = new RecordingTransport({
      responder: (cmd) => (cmd.startsWith(":r1") ? ":err" : ":ok"),
    });
    const device = new GenXPro(transport, { replyTimeoutMs: 20, authProvider: null });
    await device.open();
    assert.deepEqual(await device.readBiofeedback(), { current: null, phaseAngle: null });
  });

  it("scans a frequency range the way the captured Spooky2 loop does", async () => {
    // Per the serial capture: for each frequency, write w24, read r11 + r12.
    let freq = 0;
    const transport = new RecordingTransport({
      responder: (cmd) => {
        if (cmd.startsWith(":r11=")) return `:r11=${1000 + freq}.`;
        if (cmd.startsWith(":r12=")) return ":r12=5000.";
        const m = /:w24=(\d+),/.exec(cmd);
        if (m) freq = Number(m[1]);
        return ":ok";
      },
    });
    const device = new GenXPro(transport, { replyTimeoutMs: 20, authProvider: null });
    await device.open();
    transport.clear();

    const samples = await device.biofeedbackScan({ startHz: 1000, endHz: 2000, steps: 4 });
    assert.equal(samples.length, 5); // 0..steps inclusive
    assert.equal(samples[0]!.hz, 1000);
    assert.equal(samples.at(-1)!.hz, 2000);
    for (const s of samples) assert.equal(typeof s.current, "number");

    // each step wrote a frequency and read both detectors
    assert.ok(transport.writes.some((w) => w.startsWith(":w24=")));
    assert.ok(transport.writes.some((w) => w === ":r11=\r\n"));
    assert.ok(transport.writes.some((w) => w === ":r12=\r\n"));
    // output turned off at the end
    assert.equal(transport.writes.at(-1), ":w11=,0,\r\n");
  });

  it("stops a scan early when aborted", async () => {
    const transport = new RecordingTransport({
      responder: (cmd) => (cmd.startsWith(":r1") ? ":r11=1." : ":ok"),
    });
    const device = new GenXPro(transport, { replyTimeoutMs: 20, authProvider: null });
    await device.open();
    const controller = new AbortController();
    const samples = await device.biofeedbackScan({
      startHz: 1000,
      endHz: 100000,
      steps: 1000,
      signal: controller.signal,
      onSample: () => controller.abort(),
    });
    assert.ok(samples.length < 5, `expected an early stop, got ${samples.length} samples`);
  });

  it("subtracts a baseline sweep from the loop average", async () => {
    // Frequencies 1..4. The baseline reads the drifting impedance (1000 + 100·i);
    // the loops read that plus a 200-count resonance bump at step 2.
    let call = 0;
    const transport = new RecordingTransport({
      responder: (cmd) => {
        if (cmd.startsWith(":r11=")) {
          const i = call++;
          const step = i % 4;
          const isBaseline = i < 4;
          const current = 1000 + step * 100 + (!isBaseline && step === 2 ? 200 : 0);
          return `:r11=${current}.`;
        }
        if (cmd.startsWith(":r12=")) return ":r12=0.";
        return ":ok";
      },
    });
    const device = new GenXPro(transport, { replyTimeoutMs: 20, authProvider: null });
    await device.open();
    transport.clear();

    const samples = await device.biofeedbackScan({
      startHz: 1,
      endHz: 4,
      steps: 3,
      loops: 2,
      baseline: true,
    });

    // current = loop avg − baseline. Step 2 keeps the 200-count resonance bump.
    assert.equal(samples[0]!.current, 0);
    assert.equal(samples[1]!.current, 0);
    assert.equal(samples[2]!.current, 200);
    assert.equal(samples[3]!.current, 0);
  });
});

describe("GenXPro link resynchronisation", () => {
  // The display answers :w92 with :w91=0, of its own about 20 ms later
  // (open-spooky2 src/link.c:624-629), on the same line as the generator's :ok.
  const withStraggler = () =>
    new RecordingTransport({
      responder: (cmd) => {
        if (cmd.startsWith(":r90=")) return ":r90=472513247,432598671.";
        if (cmd.startsWith(":w92=")) return [":ok", ":w91=0,"];
        if (cmd.startsWith(":r02=")) return ":r02=200.";
        return ":ok";
      },
    });

  it("does not let the display's :w91 answer become the next command's reply", async () => {
    const transport = withStraggler();
    const device = new GenXPro(transport, { replyTimeoutMs: 20 });
    await device.open();

    assert.equal(device.authenticated, true);
    assert.equal(await device.readFirmwareVersion(), 200);
  });

  it("clears a stray line on demand", async () => {
    const transport = new RecordingTransport({
      responder: (cmd) => (cmd.startsWith(":r02=") ? ":r02=200." : ":ok"),
    });
    const device = new GenXPro(transport, { replyTimeoutMs: 20, authProvider: null });
    await device.open();

    transport.push(":w91=0,"); // left over from something earlier
    await device.resync(0);

    assert.equal(await device.readFirmwareVersion(), 200);
  });
});

// Conformance with the display MCU's recovered firmware behaviour
// (open-spooky2 docs/spec/protocols.md §3.3, src/link.c, src/runner.c).
describe("GenXPro ↔ display firmware", () => {
  async function dev(responder?: (cmd: string) => string | undefined) {
    const transport = new RecordingTransport({ defaultResponse: ":ok", responder });
    const device = new GenXPro(transport, { replyTimeoutMs: 20, authProvider: null });
    await device.open();
    transport.clear();
    return { transport, device };
  }

  it("uploads a program as name, gate, parameters — the order the firmware stores", async () => {
    const { transport, device } = await dev();

    await device.uploadProgram(7, { waveformSlot: 41, amplitudeVpp: 20, dwell: 600, frequenciesHz: [7.83], name: "Schumann" });

    // :g is held in RAM and written to flash by the *next* :p (link.c:666-682),
    // so the gate table has to precede the parameters.
    assert.deepEqual(stripCRLF(transport.writes), [
      ":n07=Schumann",
      ":g07=0,0,",
      ":p07=41,2000,120,600,1,7836,",
    ]);
  });

  it("never sends the erase-all command while uploading", async () => {
    const { transport, device } = await dev();
    await device.uploadProgram(7, { waveformSlot: 41, amplitudeVpp: 20, frequenciesHz: [7.83] });
    // :w96 erases slots 1..30 and every name (link.c:634-639) — it is not a commit.
    assert.ok(!transport.writes.some((w) => w.includes(":w96")));
  });

  it("erases all programs only when asked", async () => {
    const { transport, device } = await dev();
    await device.eraseAllPrograms();
    assert.deepEqual(stripCRLF(transport.writes), [":w96=12321,"]);
  });

  it("rejects program slots the firmware answers with :err", async () => {
    const { device } = await dev();
    for (const slot of [0, 31]) {
      await assert.rejects(
        device.uploadProgram(slot, { waveformSlot: 41, amplitudeVpp: 20, frequenciesHz: [7.83] }),
        /slot/,
        `slot ${slot}`,
      );
    }
  });

  it("rejects a name the firmware's parser would drop", async () => {
    const { device } = await dev();
    // 60+ characters abort the line (link.c:261-264).
    await assert.rejects(
      device.uploadProgram(7, { waveformSlot: 41, amplitudeVpp: 20, frequenciesHz: [7.83], name: "x".repeat(60) }),
      /59/,
    );
  });

  it("reads back a name, a program and its gate table", async () => {
    const { transport, device } = await dev((cmd) => {
      if (cmd.startsWith(":n07=?")) return ":n07=Schumann Resonance (CAFL)";
      if (cmd.startsWith(":n07=*")) return ":p07=41,2000,120,600,1,7836,";
      if (cmd.startsWith(":n07=#")) return ":g07=0,0,125,125,";
      return ":ok";
    });

    assert.equal(await device.readProgramName(7), "Schumann Resonance (CAFL)");
    assert.deepEqual(await device.readProgram(7), {
      waveformSlot: 41,
      amplitudeVpp: 20,
      offsetRatio: 0,
      dwell: 600,
      frequenciesHz: [7.83],
    });
    assert.deepEqual(await device.readGateTable(7), [0, 0, 125, 125]);
    assert.deepEqual(stripCRLF(transport.writes), [":n07=?", ":n07=*", ":n07=#"]);
  });

  it("reports an empty slot as null", async () => {
    const { device } = await dev((cmd) => (cmd.startsWith(":n09=*") ? ":p09=" : cmd.startsWith(":n09=#") ? ":g09=" : ":ok"));
    assert.equal(await device.readProgram(9), null);
    assert.equal(await device.readGateTable(9), null);
  });

  it("reads the display firmware revision, which works while locked", async () => {
    const { transport, device } = await dev((cmd) => (cmd.startsWith(":n00=$") ? ":Rev201" : ":ok"));
    assert.equal(await device.readDisplayRevision(), "Rev201");
    assert.deepEqual(stripCRLF(transport.writes), [":n00=$"]);
  });

  it("erases a single slot, keeping its name", async () => {
    const { transport, device } = await dev();
    await device.eraseProgram(7);
    assert.deepEqual(stripCRLF(transport.writes), [":n07=,"]);
  });

  it("sets the per-step gate times as a zero-padded pair", async () => {
    const { transport, device } = await dev();
    await device.setGateTimes(0, 7, 65535);
    await device.setGateTimes(1, 125, 125);
    // link_send_w_pair5: 5 digits per field (link.c:413-422, runner.c:60-64).
    assert.deepEqual(stripCRLF(transport.writes), [":w50=00007,65535,", ":w51=00125,00125,"]);
  });

  it("switches the backlight and resets the PC display state", async () => {
    const { transport, device } = await dev();
    await device.setBacklight(true);
    await device.setBacklight(false);
    await device.resetPcDisplayState();
    assert.deepEqual(stripCRLF(transport.writes), [":w64=18888881,", ":w64=10000001,", ":w97=12621,"]);
  });

  it("addresses one output without disturbing the other", async () => {
    const { transport, device } = await dev();
    await device.setOutput(0, true);
    await device.setOutput(1, true);
    await device.allOutputsOff();
    // An empty field means "leave unchanged" (link.c:116-127); Spooky2 uses this form.
    assert.deepEqual(stripCRLF(transport.writes), [":w11=1,,", ":w11=,1,", ":w11=0,0,"]);
  });
});

// Parity with Spooky2's "General Biofeedback Scan (SD) - JW" on a Gen X Pro,
// from the 2026-09-21 serial capture (41 kHz → 1.8 MHz, 0.025 % steps,
// Start Delay 200, Out 2 following Out 1 inverted, 20 V on both outputs).
describe("GenXPro biofeedback scan — Spooky2 parity", () => {
  async function scanDevice() {
    let hz = "";
    const readsAt = new Map<string, number>();
    const transport = new RecordingTransport({
      responder: (cmd) => {
        const m = /^:w24=(\d+),/.exec(cmd);
        if (m) hz = m[1]!;
        if (cmd.startsWith(":r11=")) {
          readsAt.set(hz, (readsAt.get(hz) ?? 0) + 1);
          return ":r11=46210.";
        }
        if (cmd.startsWith(":r12=")) return ":r12=5784.";
        return ":ok";
      },
    });
    const device = new GenXPro(transport, { replyTimeoutMs: 20, authProvider: null });
    await device.open();
    transport.clear();
    return { transport, device, readsAt };
  }

  const decode = (v: string) => Math.floor(Number(v) / 10) * 10 ** ((Number(v) % 10) - 8);

  it("steps by a percentage, reproducing Spooky2's 0.025 % frequency grid", async () => {
    // The first five :w24 writes Spooky2 made.
    const captured = ["41009", "41010256", "4102050256251", "41030757688140", "41041015377560"].map(decode);
    const { transport, device } = await scanDevice();

    const samples = await device.biofeedbackScan({ startHz: 41000, endHz: 41045, stepPercent: 0.025 });

    // 41051.28 would be the next step — past the end, so the grid stops.
    assert.equal(samples.length, captured.length);
    const written = stripCRLF(transport.writes)
      .filter((w) => w.startsWith(":w24="))
      .map((w) => decode(w.slice(5, -1)));
    for (const [i, hz] of captured.entries()) {
      assert.ok(Math.abs(samples[i]!.hz - hz) < 1e-8, `sample ${i}: ${samples[i]!.hz} vs ${hz}`);
      assert.ok(Math.abs(written[i]! - hz) < 1e-8, `write ${i}: ${written[i]} vs ${hz}`);
    }
  });

  it("rejects a percentage step combined with another step size", async () => {
    const { device } = await scanDevice();
    await assert.rejects(
      device.biofeedbackScan({ startHz: 41000, endHz: 42000, stepPercent: 0.025, stepHz: 10 }),
      /stepPercent/,
    );
  });

  it("takes Spooky2's start-delay readings before each pass and discards them", async () => {
    const { device, readsAt } = await scanDevice();
    let reported = 0;

    const samples = await device.biofeedbackScan({
      startHz: 1000,
      endHz: 2000,
      steps: 1,
      baseline: true,
      startDelay: 200,
      onSample: () => reported++,
    });

    // Spooky2 read 202 times at the start frequency in every pass of two
    // captures with Start Delay 200: 201 discarded readings plus the kept one.
    assert.equal(readsAt.get("10008"), 2 * 202); // baseline pass + one loop
    assert.equal(readsAt.get("20008"), 2);
    assert.equal(samples.length, 2);
    assert.equal(reported, 4); // discarded readings are not reported
  });

  it("drives both outputs like Spooky2: Out 2 synced, inverted, same amplitude", async () => {
    const { transport, device } = await scanDevice();

    await device.biofeedbackScan({ startHz: 41000, endHz: 42000, steps: 1, amplitudeVpp: 40 });

    const writes = stripCRLF(transport.writes);
    const setup = writes.slice(0, writes.indexOf(":r11="));
    assert.ok(setup.includes(":w14=1,"), "Out 2 follows Out 1's frequency");
    assert.ok(setup.includes(":w17=,1,"), "Out 2 inverted");
    assert.ok(setup.includes(":w28=2000,"));
    assert.ok(setup.includes(":w29=2000,"));
    // Spooky2's own pair of per-output enables, verbatim from the capture.
    assert.ok(setup.includes(":w11=1,,") && setup.includes(":w11=,1,"), "both outputs on before the first read");
    // Out 2 follows in hardware, so the scan never writes its frequency.
    assert.ok(!writes.some((w) => w.startsWith(":w25=")));
    assert.equal(writes.at(-1), ":w11=,0,");
  });

  it("drives only the requested output with bothOutputs: false", async () => {
    const { transport, device } = await scanDevice();

    await device.biofeedbackScan({ startHz: 41000, endHz: 42000, steps: 1, amplitudeVpp: 40, bothOutputs: false });

    const writes = stripCRLF(transport.writes);
    assert.ok(!writes.some((w) => /^:w(14|17|29)=/.test(w)));
    assert.ok(writes.includes(":w11=1,,"));
  });

  it("scans Out 2 alone — hardware sync only runs Out 1 → Out 2", async () => {
    const { transport, device } = await scanDevice();

    await device.biofeedbackScan({ startHz: 41000, endHz: 42000, steps: 1, channel: 1 });
    assert.ok(stripCRLF(transport.writes).includes(":w11=,1,"));

    await assert.rejects(
      device.biofeedbackScan({ startHz: 41000, endHz: 42000, steps: 1, channel: 1, bothOutputs: true }),
      /bothOutputs/,
    );
  });
});

describe("GenXPro frequency sweep", () => {
  it("steps the frequency register linearly, like the captured Spooky2 sweep", async () => {
    const transport = new RecordingTransport({ defaultResponse: ":ok" });
    const device = new GenXPro(transport, { replyTimeoutMs: 20, authProvider: null });
    await device.open();
    transport.clear();

    const swept = await device.frequencySweep({
      startHz: 3.44,
      endHz: 17.93,
      steps: 76,
      amplitudeVpp: 10,
      offsetRatio: -1,
    });

    assert.equal(swept.length, 77); // 0..steps inclusive
    assert.equal(swept[0], 3.44);
    assert.equal(swept.at(-1), 17.93);

    const writes = transport.writes.map((w) => w.trimEnd());
    // setup: amplitude (peak centivolts = vpp × 50), offset, output on
    assert.ok(writes.includes(":w28=500,"));
    assert.ok(writes.includes(":w32=20,")); // offset −1 → 120 − 100
    assert.ok(writes.includes(":w11=1,,"));
    // each step wrote an exponent-encoded frequency to w24
    const freqWrites = writes.filter((w) => w.startsWith(":w24="));
    assert.equal(freqWrites.length, 77);
    // 3.44 Hz → mantissa 344, code 6 (Spooky2 writes the same value with full
    // 8-place precision, 3440082640; both decode to 3.44 Hz on the device)
    assert.equal(freqWrites[0], ":w24=3446,");
    // output turned off at the end
    assert.equal(writes.at(-1), ":w11=0,,");
  });

  it("stops a sweep early when aborted", async () => {
    const transport = new RecordingTransport({ defaultResponse: ":ok" });
    const device = new GenXPro(transport, { replyTimeoutMs: 20, authProvider: null });
    await device.open();
    const controller = new AbortController();
    const swept = await device.frequencySweep({
      startHz: 1000,
      endHz: 100000,
      steps: 1000,
      signal: controller.signal,
      onStep: () => controller.abort(),
    });
    assert.ok(swept.length < 5, `expected an early stop, got ${swept.length} steps`);
  });
});

describe("GenXPro waveform upload & offline commands (decoded from capture)", () => {
  it("uploads a normalised table as one :a<slot>= command, scaled to 10-bit", async () => {
    const { transport, device } = await pro();
    // −1 → 0, 0 → 512 (round of 511.5), +1 → 1023
    await device.uploadWaveform(13, [-1, 0, 1]);
    assert.equal(transport.writes[0], ":a13=0,512,1023,\r\n");
  });

  it("passes raw 10-bit samples through unchanged, clamped to range", async () => {
    const { transport, device } = await pro();
    await device.uploadWaveform(11, [512, 1200, -5], { raw: true });
    assert.equal(transport.writes[0], ":a11=512,1023,0,\r\n");
  });

  it("sets display text via :n00=", async () => {
    const { transport, device } = await pro();
    await device.setDisplayText("Port 3 - General Biofeedback");
    assert.equal(transport.writes[0], ":n00=Port 3 - General Biofeedback\r\n");
  });

  it("writes offline-program slot fields (:n / :p / :g)", async () => {
    const { transport, device } = await pro();
    await device.writeOfflineSlot("n", 6, "(-)-beta-Elemene");
    await device.writeOfflineSlot("p", 6, "46,2000,120,180,7,20");
    await device.writeOfflineSlot("g", 6, "0,0,0,0,0,0,0,0,0,0,");
    assert.deepEqual(
      transport.writes.map((w) => w.trimEnd()),
      [":n06=(-)-beta-Elemene", ":p06=46,2000,120,180,7,20", ":g06=0,0,0,0,0,0,0,0,0,0,"],
    );
  });

  it("builds an offline program with exponent-encoded frequencies, matching the capture", async () => {
    const { transport, device } = await pro();
    await device.uploadProgram(1, {
      waveformSlot: 41,
      amplitudeVpp: 20, // → 2000
      dwell: 600,
      name: "Schumann Resonance (CAFL)",
      // 7.83 Hz Schumann — captured as :p01=41,2000,120,600,1,7836,
      frequenciesHz: [7.83],
    });
    const writes = transport.writes.map((w) => w.trimEnd());
    assert.equal(writes[0], ":n01=Schumann Resonance (CAFL)");
    // :p01 = wfSlot, amp×100, offset(120), dwell, count, f0 (exponent-encoded)
    assert.equal(writes[2], ":p01=41,2000,120,600,1,7836,");
    // one frequency → two gate values, sent before the parameters
    assert.equal(writes[1], ":g01=0,0,");
  });

  it("encodes a fractional program frequency with the exponent digit, matching the capture", async () => {
    const { transport, device } = await pro();
    await device.uploadProgram(4, {
      waveformSlot: 44,
      amplitudeVpp: 20,
      dwell: 2700,
      name: "Plant Growth (CUST)",
      // 183.58 Hz — captured as :p04=44,2000,120,2700,1,183586,
      frequenciesHz: [183.58],
    });
    const writes = transport.writes.map((w) => w.trimEnd());
    assert.equal(writes[2], ":p04=44,2000,120,2700,1,183586,");
    assert.equal(writes[1], ":g04=0,0,");
  });

  it("writes two gate values per frequency, matching the 6-frequency capture", async () => {
    const { transport, device } = await pro();
    await device.uploadProgram(7, {
      waveformSlot: 47,
      amplitudeVpp: 20,
      dwell: 180,
      // captured :p07=47,2000,120,180,6,5481257,548758,8564455,135866253,8574218752,136021253,
      frequenciesHz: [54812.5, 54875, 856.445, 135.86625, 857.421875, 136.02125],
    });
    const writes = transport.writes.map((w) => w.trimEnd());
    assert.equal(
      writes[1],
      ":p07=47,2000,120,180,6,5481257,548758,8564455,135866253,8574218752,136021253,",
    );
    // six frequencies → twelve gate values, sent first
    assert.equal(writes[0], ":g07=0,0,0,0,0,0,0,0,0,0,0,0,");
  });

  it("keeps exponent precision without overflow at high frequencies", async () => {
    const { transport, device } = await pro();
    await device.uploadProgram(1, {
      waveformSlot: 11,
      amplitudeVpp: 5,
      frequenciesHz: [40_000_000], // 40 MHz → mantissa 40000000, code 8
    });
    // exact, no floating-point corruption
    assert.ok(transport.writes.some((w) => w.includes("400000008,")));
  });

  it("rejects a bad waveform slot", async () => {
    const { device } = await pro();
    await assert.rejects(device.uploadWaveform(-1, [0]), /slot must be a non-negative integer/);
  });
});

describe("GenXPro waveforms", () => {
  it("reports a sawtooth request as substituted, not silently swapped", async () => {
    const { device } = await pro();
    const applied = await device.setWaveform(0, "ramp-up");
    assert.equal(applied.requested, "ramp-up");
    assert.equal(applied.actual, "sine");
    assert.equal(applied.substituted, true);
  });
});

describe("GenXPro authentication", () => {
  it("uses the bundled provider by default", async () => {
    // A working challenge → the bundled transform computes a response → :ok unlocks.
    let sawResponse = false;
    const responder = (cmd: string) => {
      if (cmd.startsWith(":r90=")) return "123456789,987654321";
      if (cmd.startsWith(":w92=")) {
        sawResponse = true;
        return ":ok";
      }
      return ":ok";
    };
    const device = new GenXPro(new RecordingTransport({ responder }), { replyTimeoutMs: 20 });
    await device.open();
    assert.equal(device.authenticated, true);
    assert.equal(sawResponse, true);
  });

  it("can be disabled with authProvider: null", async () => {
    const device = new GenXPro(new RecordingTransport({ defaultResponse: ":ok" }), {
      replyTimeoutMs: 20,
      authProvider: null,
    });
    await device.open();
    assert.equal(device.authenticated, false);
    await assert.rejects(device.authenticate(), /ships no response algorithm/);
  });

  it("runs two challenge rounds and passes the device's values to the provider", async () => {
    const seen: Array<{ nonce: string; v1: string; v2: string }> = [];
    const transport = new RecordingTransport({
      responder: (cmd) => (cmd.startsWith(":r90=") ? "123456789,987654321" : ":ok"),
    });
    const device = new GenXPro(transport, {
      replyTimeoutMs: 20,
      authProvider: {
        respond(challenge) {
          seen.push(challenge);
          return "111111111";
        },
      },
    });
    await device.open();

    assert.equal(device.authenticated, true);
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.v1, "123456789");
    assert.equal(seen[0]!.v2, "987654321");
    assert.match(seen[0]!.nonce, /^[1-9]{9}$/);
    assert.ok(transport.writes.some((w) => w === ":w92=111111111.\r\n"));
  });

  it("keeps registers usable when authentication fails", async () => {
    const transport = new RecordingTransport({
      responder: (cmd) => (cmd.startsWith(":r90=") ? "garbage" : ":ok"),
    });
    const device = new GenXPro(transport, {
      replyTimeoutMs: 20,
      authProvider: { respond: () => "0" },
    });
    await device.open();
    assert.equal(device.authenticated, false);
    await device.setAmplitude(0, 5);
    assert.ok(transport.writes.some((w) => w === ":w28=250,\r\n"));
  });
});

describe("generateNonce", () => {
  it("is a permutation of 1–9, never containing a zero", () => {
    for (let i = 0; i < 50; i++) {
      const nonce = generateNonce();
      assert.equal(nonce.length, 9);
      assert.deepEqual([...nonce].sort().join(""), "123456789");
    }
  });

  it("is deterministic for a given random source", () => {
    assert.equal(generateNonce(() => 0), generateNonce(() => 0));
    assert.equal(generateNonce(() => 0), "234567891");
  });
});

describe("GenXPair channel mapping", () => {
  function pair(identities: [string | null, string | null]) {
    const a = new GenXPro(new RecordingTransport({ defaultResponse: ":ok" }));
    const b = new GenXPro(new RecordingTransport({ defaultResponse: ":ok" }));
    return { a, b, pair: new GenXPair([a, b], identities) };
  }

  it("uses self-reported identity when the units disagree", () => {
    // Confirmed on hardware: the two ports report G1/G2 and it does not follow
    // connection order.
    const { a, b, pair: p } = pair(["G2", "G1"]);
    assert.equal(p.unitForChannel(0), b);
    assert.equal(p.unitForChannel(1), a);
  });

  it("falls back to connection order when both report the same identity", () => {
    const { a, b, pair: p } = pair(["G2", "G2"]);
    assert.equal(p.unitForChannel(0), a);
    assert.equal(p.unitForChannel(1), b);
  });

  it("reports authenticated only when every unit is", () => {
    const { pair: p } = pair([null, null]);
    assert.equal(p.authenticated, false);
  });
});

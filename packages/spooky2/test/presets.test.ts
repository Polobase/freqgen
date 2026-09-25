import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RecordingTransport } from "@freqgen/core/testing";
import { GenXPro } from "../src/genx-pro.js";
import {
  parsePreset,
  parseFrequencyLine,
  presetProgramsForUpload,
  presetToProgram,
  resolvePresetChain,
  activeWaveformWcm,
} from "../src/presets.js";

const PLANT_GROWTH = `"[Preset]"
"PresetName=Spooky Radionics Plant Growth "
"Out1_Amplitude=20"
"Out2_Amplitude=20"
"Out1_Offset=100"
"Out2_Offset=100"
"Loaded_Programs=Plant Growth (CUST)"
"Loaded_Frequencies=183.58=2700,"
"[/Preset]"`;

const BIRD_MITES = `"[Preset]"
"PresetName=Bird Mites (R) - DB"
"Amplitude=20"
"Out1_Offset=0"
"Loaded_Programs=Ornithonyssus Bird Mite_1 (HC)"
"Loaded_Programs=Ornithonyssus Bird Mite_2 (HC)"
"Loaded_Frequencies=877000=180,"
"Loaded_Frequencies=13703.12=180,2173.86=180,"
"[/Preset]"`;

const MANIFESTATION = `"[Preset]"
"PresetName=Spooky Radionics (Boost) Manifestation"
"Out1_Sine=True"
"Sine_WCM=11"
"Out1_Offset=-100"
"Out2_Offset=100"
"Loaded_Programs=Reality Engineering 1 (CUST)"
"Loaded_Frequencies=36-198=11,396=11,792-4356=11,"
"[/Preset]"`;

const DNA = `"[Preset]"
"PresetName=Acholeplasma (DNA) (R) - JW"
"Loaded_Programs=Acholeplasma (DNA) (R) - JW (CUST)"
"Loaded_Frequencies=~6891BC97498,~4397BC0540064,"
"[/Preset]"`;

describe("parsePreset", () => {
  it("parses settings, program names and frequency lines", () => {
    const preset = parsePreset(PLANT_GROWTH);
    assert.equal(preset.name, "Spooky Radionics Plant Growth ");
    assert.equal(preset.settings["Out1_Amplitude"], "20");
    assert.equal(preset.settings["Out1_Offset"], "100");
    assert.equal(preset.programs.length, 1);
    assert.equal(preset.programs[0]!.name, "Plant Growth (CUST)");
    assert.deepEqual(preset.programs[0]!.frequencies, [
      { hz: 183.58, endHz: null, dwellOrWcm: 2700, dna: null },
    ]);
  });

  it("pairs repeated Loaded_Programs with repeated Loaded_Frequencies in order", () => {
    const preset = parsePreset(BIRD_MITES);
    assert.equal(preset.programs.length, 2);
    assert.equal(preset.programs[0]!.name, "Ornithonyssus Bird Mite_1 (HC)");
    assert.deepEqual(preset.programs[0]!.frequencies, [
      { hz: 877000, endHz: null, dwellOrWcm: 180, dna: null },
    ]);
    assert.equal(preset.programs[1]!.name, "Ornithonyssus Bird Mite_2 (HC)");
    assert.deepEqual(preset.programs[1]!.frequencies, [
      { hz: 13703.12, endHz: null, dwellOrWcm: 180, dna: null },
      { hz: 2173.86, endHz: null, dwellOrWcm: 180, dna: null },
    ]);
  });

  it("parses range entries with their wave-cycle multiplier", () => {
    const preset = parsePreset(MANIFESTATION);
    assert.deepEqual(preset.programs[0]!.frequencies, [
      { hz: 36, endHz: 198, dwellOrWcm: 11, dna: null },
      { hz: 396, endHz: null, dwellOrWcm: 11, dna: null },
      { hz: 792, endHz: 4356, dwellOrWcm: 11, dna: null },
    ]);
  });

  it("preserves DNA entries raw", () => {
    const preset = parsePreset(DNA);
    assert.deepEqual(preset.programs[0]!.frequencies, [
      { hz: NaN, endHz: null, dwellOrWcm: 0, dna: "6891BC97498" },
      { hz: NaN, endHz: null, dwellOrWcm: 0, dna: "4397BC0540064" },
    ]);
  });
});

describe("parseFrequencyLine", () => {
  it("splits comma-separated entries and drops empties", () => {
    assert.deepEqual(parseFrequencyLine("877000=180,"), [
      { hz: 877000, endHz: null, dwellOrWcm: 180, dna: null },
    ]);
    assert.deepEqual(parseFrequencyLine("36-198=11,396=11,"), [
      { hz: 36, endHz: 198, dwellOrWcm: 11, dna: null },
      { hz: 396, endHz: null, dwellOrWcm: 11, dna: null },
    ]);
  });
});

describe("presetProgramsForUpload", () => {
  it("keeps single-frequency programs with their dwell", () => {
    const programs = presetProgramsForUpload(parsePreset(BIRD_MITES));
    assert.deepEqual(programs, [
      { name: "Ornithonyssus Bird Mite_1 (HC)", dwell: 180, frequenciesHz: [877000] },
      {
        name: "Ornithonyssus Bird Mite_2 (HC)",
        dwell: 180,
        frequenciesHz: [13703.12, 2173.86],
      },
    ]);
  });

  it("excludes ranges and DNA, and decodes radionics singles (÷WCM)", () => {
    // The Manifestation program's ranges are excluded; its single `396=11` is a
    // radionics single — frequency stored as base × WCM, played at 396/11 = 36 Hz.
    assert.deepEqual(presetProgramsForUpload(parsePreset(MANIFESTATION)), [
      { name: "Reality Engineering 1 (CUST)", dwell: 11, frequenciesHz: [36] },
    ]);
    assert.deepEqual(presetProgramsForUpload(parsePreset(DNA)), []);
  });
});

// These read the real Spooky2 preset `.txt` files from `local/capture4/`, which
// is gitignored (raw captures stay off the repo), so they run only where those
// captures are present — locally — and are skipped in CI. The inline fixtures
// above (PLANT_GROWTH, MANIFESTATION, DNA) cover the same parsing logic with
// committed data.
const captureDir = fileURLToPath(
  new URL("../../../local/capture4/", import.meta.url),
);

(existsSync(captureDir) ? describe : describe.skip)("real capture4 preset files", () => {
  function readPreset(rel: string): string {
    return readFileSync(`${captureDir}${rel}`, "utf8");
  }

  it("parses the Plant Growth preset to the captured program", () => {
    const preset = parsePreset(readPreset("Radionics/Spooky Radionics Plant Growth - AW.txt"));
    assert.equal(preset.name, "Spooky Radionics Plant Growth ");
    assert.equal(preset.programs.length, 1);
    assert.equal(preset.programs[0]!.name, "Plant Growth (CUST)");
    // captured as :p04=44,2000,120,2700,1,183586,
    assert.deepEqual(presetProgramsForUpload(preset), [
      { name: "Plant Growth (CUST)", dwell: 2700, frequenciesHz: [183.58] },
    ]);
  });

  it("parses the Radionics General preset to the captured Schumann program", () => {
    const preset = parsePreset(readPreset("Radionics/Spooky Radionics General - AW.txt"));
    // captured as :p01=41,2000,120,600,1,7836, (7.83 Hz, dwell 600)
    assert.deepEqual(presetProgramsForUpload(preset), [
      { name: "Schumann Resonance (CAFL)", dwell: 600, frequenciesHz: [7.83] },
    ]);
  });

  it("parses the Bird Mites preset's four programs", () => {
    const preset = parsePreset(readPreset("Bird Mites (R) - DB.txt"));
    assert.equal(preset.programs.length, 4);
    assert.equal(preset.settings["Hz_Gate"], "4");
    assert.equal(preset.settings["Sine_WCM"], "1");
    // 1 + 1 + 2 + 2 = 6 frequencies, matching the capture's 6-frequency p07
    const total = preset.programs.reduce((n, p) => n + p.frequencies.length, 0);
    assert.equal(total, 6);
  });

  it("parses the Manifestation preset's six range programs", () => {
    const preset = parsePreset(
      readPreset("Radionics/Spooky Radionics (Boost) Manifestation - AW.txt"),
    );
    assert.equal(preset.programs.length, 6);
    assert.equal(preset.settings["Out1_Offset"], "-100");
    assert.equal(preset.settings["Out2_Offset"], "100");
    // each program: range, single, range — all WCM 11
    for (const program of preset.programs) {
      assert.equal(program.frequencies.length, 3);
      assert.equal(program.frequencies[0]!.endHz! > program.frequencies[0]!.hz, true);
      assert.equal(program.frequencies[0]!.dwellOrWcm, 11);
      assert.equal(program.frequencies[1]!.endHz, null);
    }

    // The singles are radionics-encoded (base × WCM 11): 396→36, 417→37.909…,
    // 528→48, 639→58.09…, 741→67.36…, 852→77.45… Hz.
    const uploaded = presetProgramsForUpload(preset);
    assert.equal(uploaded.length, 6);
    assert.deepEqual(
      uploaded.map((p) => p.frequenciesHz[0]),
      [
        396 / 11,
        417 / 11,
        528 / 11,
        639 / 11,
        741 / 11,
        852 / 11,
      ],
    );
  });

  it("parses the DNA preset's raw DNA frequencies", () => {
    const preset = parsePreset(readPreset("Acholeplasma (DNA) (R) - JW.txt"));
    assert.equal(preset.programs.length, 1);
    assert.equal(preset.programs[0]!.frequencies.length, 5);
    assert.equal(preset.programs[0]!.frequencies[0]!.dna, "6891BC97498");
  });
});

describe("GenXPro.loadPreset", () => {
  it("uploads each program the way the capture does, matching the captured payloads", async () => {
    const transport = new RecordingTransport({ defaultResponse: ":ok" });
    const device = new GenXPro(transport, { replyTimeoutMs: 20, authProvider: null });
    await device.open();
    transport.clear();

    const count = await device.loadPreset(parsePreset(PLANT_GROWTH));
    assert.equal(count, 1);

    const writes = transport.writes.map((w) => w.trimEnd());
    // waveform uploaded to slot 41 (base), then n/p/g to slot 1
    assert.ok(writes[0]!.startsWith(":a41="));
    assert.equal(writes[1], ":n01=Plant Growth (CUST)");
    // captured payload: :p04=44,2000,120,2700,1,183586, (slot 4 / wf 44 in the
    // real capture; here slot 1 / wf 41, same encoding). Offset stays at
    // centre 120 even though the preset sets Out1_Offset=100 — Spooky2 applies
    // offsets at run time, not in the stored program.
    assert.equal(writes[3], ":p01=41,2000,120,2700,1,183586,");
    assert.equal(writes[2], ":g01=0,0,");
  });

  it("maps the preset's Out1_Amplitude setting to the amplitude field", async () => {
    const transport = new RecordingTransport({ defaultResponse: ":ok" });
    const device = new GenXPro(transport, { replyTimeoutMs: 20, authProvider: null });
    await device.open();
    transport.clear();

    const preset = parsePreset(
      `"[Preset]"
"PresetName=Amplitude Test"
"Out1_Amplitude=20"
"Loaded_Programs=Amplitude Test (CUST)"
"Loaded_Frequencies=7.83=600,"
"[/Preset]"`,
    );
    await device.loadPreset(preset);
    // 20 V → 2000, matching the captured :p01=41,2000,120,600,1,7836,
    const writes = transport.writes.map((w) => w.trimEnd());
    assert.ok(writes.some((w) => w === ":p01=41,2000,120,600,1,7836,"));
  });
});

describe("resolvePresetChain (Base_Preset inheritance)", () => {
  // A thin child that inherits its settings from a base shell, in memory.
  const files: Record<string, string> = {
    "/Preset Collections/Remote/Child (R).txt": `"[Preset]"
"Base_Preset=\\Shell\\DNA (Dual) (R)"
"PresetName=Child (R)"
"Out1_Square=True"
"Loaded_Programs=Child (CUST)"
"Loaded_Frequencies=1000=180,"
"[/Preset]"`,
    "/Preset Collections/Shell/DNA (Dual) (R).txt": `"[Preset]"
"PresetName=DNA (Dual) (R)"
"Out1_Amplitude=20"
"Out2_Hz_Factor=64"
"Out2_Hz_Constant=0"
"Out1_Sawtooth=True"
"Sine_WCM=11"
"[/Preset]"`,
  };
  const read = (p: string) => {
    const t = files[p];
    if (t === undefined) throw new Error(`no such file: ${p}`);
    return t;
  };

  it("merges base settings under the child's, keeping the child's frequencies", () => {
    const preset = resolvePresetChain("/Preset Collections/Remote/Child (R).txt", read);
    // inherited from the base shell:
    assert.equal(preset.settings["Out1_Amplitude"], "20");
    assert.equal(preset.settings["Out2_Hz_Factor"], "64");
    assert.equal(preset.settings["Sine_WCM"], "11");
    // child overrides win, and its own keys survive:
    assert.equal(preset.settings["PresetName"], "Child (R)");
    assert.equal(preset.programs[0]!.name, "Child (CUST)");
    assert.equal(preset.programs[0]!.frequencies[0]!.hz, 1000);
  });

  it("clears the base's waveform flag when the child selects one (radio group)", () => {
    const preset = resolvePresetChain("/Preset Collections/Remote/Child (R).txt", read);
    // child picks Square, so the base's Out1_Sawtooth must not survive
    assert.equal(preset.settings["Out1_Square"], "True");
    assert.equal(preset.settings["Out1_Sawtooth"], undefined);
  });

  it("resolves the Out 2 factor into the run plan", () => {
    const run = presetToProgram(resolvePresetChain("/Preset Collections/Remote/Child (R).txt", read));
    assert.equal(run.outputs[1]!.freqFactor, 64); // Out 2 = Out 1 × 64
  });

  it("warns and falls back to overrides when the base is missing", () => {
    const warnings: string[] = [];
    const preset = resolvePresetChain(
      "/Preset Collections/Remote/Child (R).txt",
      (p) => {
        if (p.includes("DNA (Dual)")) throw new Error("missing");
        return read(p);
      },
      { onWarn: (m) => warnings.push(m) },
    );
    assert.equal(preset.settings["Out2_Hz_Factor"], undefined);
    assert.ok(warnings.some((w) => /not found/.test(w)));
  });
});

describe("activeWaveformWcm + radionics guard", () => {
  it("reads the active waveform's WCM, not just any WCM in the file", () => {
    const settings = { Out1_Square: "True", Sine_WCM: "11", Square_WCM: "7" };
    assert.equal(activeWaveformWcm(settings), 7); // Square is active
  });

  it("treats a sawtooth/triangle preset as WCM 1 (no radionics division)", () => {
    assert.equal(activeWaveformWcm({ Out1_Sawtooth: "True", Sine_WCM: "11" }), 1);
  });

  it("divides a single only when its value is the active WCM (> 1), not a coincidental dwell", () => {
    // active Sine_WCM=11: 396=11 is radionics (396/11=36); 500=11 dwell would
    // also match — but 500=180 must stay a plain 180 s dwell, unaffected.
    const preset = parsePreset(
      `"[Preset]"
"PresetName=Guard"
"Out1_Sine=True"
"Sine_WCM=11"
"Loaded_Programs=P (CUST)"
"Loaded_Frequencies=396=11,500=180,"
"[/Preset]"`,
    );
    const [prog] = presetProgramsForUpload(preset);
    assert.deepEqual(prog!.frequenciesHz, [36, 500]); // 396/11=36, 500 kept
  });
});
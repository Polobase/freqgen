import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectHits, convertBiofeedback, toBfbCsv, toBfbFrequenciesCsv, type BiofeedbackPoint } from "../src/biofeedback.js";

// First 12 rows of Spooky2's RawAnalysisData.tmp (freq, Data, RA, Data-PrevRA, Hit),
// captured verbatim. Hits at 2.25 and 3.5; 1.5 is a peak but ranks below them.
const CAPTURE: Array<[number, number]> = [
  [1, -0.3],
  [1.25, 0.1],
  [1.5, 0.215],
  [1.75, 0.09],
  [2, 0.095],
  [2.25, 0.39],
  [2.5, 0.02],
  [2.75, -0.445],
  [3, 0.06],
  [3.25, -0.07],
  [3.5, 0.445],
  [3.75, -0.295],
];

describe("detectHits", () => {
  it("reproduces Spooky2's running-average deviation and peak hits", () => {
    const points: BiofeedbackPoint[] = CAPTURE.map(([hz, value]) => ({ hz, value }));
    const hits = detectHits(points, { window: 20, maxHits: 2 });

    // 3.5 has the largest deviation, then 2.25 — both are positive peaks.
    assert.deepEqual(hits.map((h) => h.hz), [3.5, 2.25]);
    // 1.5 is a peak too but its deviation (0.315) ranks below 2.25 (0.35).
    assert.ok(!hits.some((h) => h.hz === 1.5));
  });

  it("computes the running average as the mean of previous `window` values", () => {
    // Single rising ramp: RA[k] = mean of values[0..k-1] (cumulative while < window).
    const ramp: BiofeedbackPoint[] = [0, 2, 4, 6].map((value, i) => ({ hz: i, value }));
    const hits = detectHits(ramp, { window: 20, maxHits: 1 });
    // A monotonic ramp has no local maxima, so no hits.
    assert.equal(hits.length, 0);
  });

  it("detects valleys with detect: 'min'", () => {
    const wave: BiofeedbackPoint[] = [3, 0, 3, 1, 3].map((value, i) => ({ hz: i, value }));
    const hits = detectHits(wave, { window: 5, maxHits: 2, detect: "min" });
    assert.deepEqual(hits.map((h) => h.hz), [1, 3]);
  });

  it("caps the result at maxHits", () => {
    const wave: BiofeedbackPoint[] = [0, 5, 0, 4, 0, 3, 0].map((value, i) => ({ hz: i, value }));
    const hits = detectHits(wave, { window: 7, maxHits: 2 });
    assert.equal(hits.length, 2);
    assert.deepEqual(hits.map((h) => h.hz), [1, 3]);
  });
});

describe("convertBiofeedback / toBfbCsv", () => {
  it("defaults to Spooky2's display scale: raw counts / 100", () => {
    // 2026-09-21 capture, Gen X Pro with no load: the device answered
    // `:r11=46210.` / `:r12=5784.` and Spooky2 displayed 462.10 / 57.84.
    const { currentMa, angleDeg } = convertBiofeedback(46210, 5784);
    assert.equal(Math.round(currentMa * 100) / 100, 462.1);
    assert.equal(Math.round(angleDeg * 100) / 100, 57.84);
  });

  it("converts raw counts using the device-spec scale and a baseline", () => {
    const spec = { currentUaPerCount: 3.4, angleDegPerCount: 0.0015 };
    // 42448 counts, 3.4 µA/count, baseline 42448 → 0 mA.
    assert.equal(convertBiofeedback(42448, 0, { ...spec, currentBaseline: 42448 }).currentMa, 0);
    // 50 counts above baseline → 50 × 3.4 µA = 0.17 mA.
    assert.equal(
      Math.round(convertBiofeedback(42498, 0, { ...spec, currentBaseline: 42448 }).currentMa * 1000) / 1000,
      0.17,
    );
    // 0.0015°/count.
    assert.equal(convertBiofeedback(0, 5208, { ...spec, angleBaseline: 5208 }).angleDeg, 0);
  });

  it("reproduces the values of Spooky2's own BFB CSV by default", () => {
    // 2026-08-21 capture (scan1): raw loop-1 reading minus the baseline sweep,
    // and the rows Spooky2 wrote for them to BFB_20260821_1410_35.csv.
    const samples = [
      { hz: 1, current: 42433 - 42460, phaseAngle: 6649 - 5398 },
      { hz: 1.25, current: 42473 - 42436, phaseAngle: 5911 - 5290 },
      { hz: 1.5, current: 42463 - 42407, phaseAngle: 5519 - 5703 },
    ];
    const spooky2 = [
      [12.51, -0.27, 12.24],
      [6.21, 0.37, 6.58],
      [-1.84, 0.56, -1.28],
    ];
    const rows = toBfbCsv(samples, { dateTime: "20260821_1411_32" }).trim().split("\n").slice(1);
    assert.deepEqual(
      rows.map((r) => r.split(",").slice(4, 7).map(Number)),
      spooky2,
    );
  });

  it("renders Spooky2's BFB CSV column layout", () => {
    const csv = toBfbCsv(
      [{ hz: 1, current: 42448, phaseAngle: 5208 }],
      { dateTime: "20260821_1411_32", calibration: { currentBaseline: 42448, angleBaseline: 5208 } },
    );
    assert.equal(
      csv,
      "Date_Time,Frequency,BPM,HRV,Angle,Current,Angle + Current,Spare,Spare,Spare,Spare,Spare\n" +
        "20260821_1411_32,1,0,0,0,0,0,0,0,0,0,0\n",
    );
  });

  it("renders a BFB_Frequencies.csv program row (Spooky2-loadable)", () => {
    const row = toBfbFrequenciesCsv([95.5, 73, 69.75, 3.5, 2.25], {
      name: "BFB 20260821 Low Frequency",
      createdAt: new Date(2026, 7, 21, 14, 14, 3),
    });
    assert.equal(
      row,
      '"BFB 20260821 Low Frequency",BFB,,"Program Created 21.08.2026 14:14:03","95.5,73,69.75,3.5,2.25",,,180\n',
    );
  });
});

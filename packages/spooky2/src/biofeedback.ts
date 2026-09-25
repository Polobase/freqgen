/**
 * Biofeedback scan analysis: running-average hit detection.
 *
 * The Gen X Pro's high-side detector reads output current (`:r11`) and phase
 * angle (`:r12`) at each frequency. Spooky2 turns those into a biofeedback scan
 * and flags "hit frequencies" — the frequencies where the response peaks.
 *
 * This module implements the *hit-detection* half of that, reverse-engineered
 * from Spooky2's own scan export (`RawAnalysisData.tmp` in the captures) and
 * confirmed against its `BFB_Frequencies.csv`:
 *
 * 1. `value` = the response at a frequency (current, in the capture).
 * 2. A running average (`window`, default 20) tracks the slow drift.
 * 3. `deviation = value − runningAverage` is the response strength.
 * 4. Peaks (local maxima of `value`, for `detect: "max"`) are candidate hits.
 * 5. The top `maxHits` peaks by deviation are the hits.
 *
 * The conversion of the raw register values into milliamps/degrees is *not*
 * here — that is hardware- and amplitude-dependent and, for hit detection,
 * irrelevant: a linear scale does not change which frequencies peak. The
 * caller passes whatever `value` it wants (raw `:r11` counts work).
 */

/** One measured point in a scan. */
export interface BiofeedbackPoint {
  hz: number;
  /** The response value (raw counts, mA, degrees — any monotonic scale). */
  value: number;
}

export interface DetectHitsOptions {
  /** Running-average window. Default 20 (Spooky2's `BFB_RA_Window_1`). */
  window?: number;
  /** Detect peaks of `value`. Default "max" (Spooky2's `BFB_Detect_Max`). */
  detect?: "max" | "min";
  /** Maximum hits to return. Default 60. */
  maxHits?: number;
}

/** A detected hit: the frequency and its response deviation from the average. */
export interface BiofeedbackHit {
  hz: number;
  deviation: number;
}

/**
 * Detect hit frequencies from a scan's samples.
 *
 * Pure: takes the measured points and returns the hit frequencies, ordered by
 * response strength (largest deviation first). The running average is the mean
 * of the previous `window` values (a cumulative mean while fewer than `window`
 * points exist), matching Spooky2's export exactly.
 */
export function detectHits(
  points: readonly BiofeedbackPoint[],
  options: DetectHitsOptions = {},
): BiofeedbackHit[] {
  const window = options.window ?? 20;
  const maxHits = options.maxHits ?? 60;
  const sign = options.detect === "min" ? -1 : 1;

  // Running average of previous values (cumulative during warm-up).
  const average: number[] = new Array(points.length);
  let sum = 0;
  for (let k = 0; k < points.length; k++) {
    if (k === 0) {
      average[0] = points[0]!.value;
      continue;
    }
    sum += points[k - 1]!.value;
    if (k - window - 1 >= 0) sum -= points[k - window - 1]!.value;
    average[k] = sum / (k - Math.max(0, k - window));
  }

  const deviation = points.map((p, k) => sign * (p.value - average[k]!));

  // Peaks: local maxima of `value` (for detect "max").
  const peaks: BiofeedbackHit[] = [];
  for (let k = 1; k < points.length - 1; k++) {
    const v = sign * points[k]!.value;
    const prev = sign * points[k - 1]!.value;
    const next = sign * points[k + 1]!.value;
    if (v > prev && v > next) {
      peaks.push({ hz: points[k]!.hz, deviation: deviation[k]! });
    }
  }

  peaks.sort((a, b) => b.deviation - a.deviation);
  return peaks.slice(0, maxHits);
}

/**
 * Raw-to-display-unit scale for the biofeedback detector.
 *
 * The detector returns 16-bit raw counts for current (`:r11`) and phase angle
 * (`:r12`). Spooky2 shows and exports both as **count / 100** — confirmed by
 * capture: `:r11=46210.` / `:r12=5784.` displayed as 462.10 / 57.84, and its
 * BFB CSV rows equal (loop − baseline) / 100 exactly. That is the default here,
 * so `toBfbCsv` reproduces Spooky2's CSV values. Spooky2 labels neither
 * number, so whether they are really mA and degrees is unverified.
 *
 * The device spec quotes 3.4 µA and 0.0015° per count instead; pass
 * `{ currentUaPerCount: 3.4, angleDegPerCount: 0.0015 }` for that scale.
 *
 * The scan values Spooky2 writes are *deltas* from a baseline that depends on
 * the sample, amplitude and wiring (with nothing connected, a Gen X Pro still
 * reads ≈ 462 / 57.8°), so the baseline must be measured on the hardware you
 * are driving.
 */
export interface BiofeedbackCalibration {
  /** Microamps per raw current count. Default: 10 (Spooky2's count / 100). */
  currentUaPerCount?: number;
  /** Degrees per raw phase-angle count. Default: 0.01 (Spooky2's count / 100). */
  angleDegPerCount?: number;
  /** Raw current count that reads as 0 mA (the sample's resting current). */
  currentBaseline?: number;
  /** Raw phase-angle count that reads as 0° (the sample's resting phase). */
  angleBaseline?: number;
}

/** A calibrated reading: current in mA and phase angle in degrees. */
export interface CalibratedBiofeedback {
  currentMa: number;
  angleDeg: number;
}

/** Convert raw detector counts to mA and degrees. */
export function convertBiofeedback(
  current: number | null,
  phaseAngle: number | null,
  calibration: BiofeedbackCalibration = {},
): CalibratedBiofeedback {
  const uaPerCount = calibration.currentUaPerCount ?? 10;
  const degPerCount = calibration.angleDegPerCount ?? 0.01;
  const currentBaseline = calibration.currentBaseline ?? 0;
  const angleBaseline = calibration.angleBaseline ?? 0;
  return {
    currentMa: current === null ? NaN : (current - currentBaseline) * uaPerCount / 1000,
    angleDeg: phaseAngle === null ? NaN : (phaseAngle - angleBaseline) * degPerCount,
  };
}

/**
 * Render scan samples in Spooky2's `BFB_<date>.csv` column layout:
 *
 * `Date_Time,Frequency,BPM,HRV,Angle,Current,Angle + Current,Spare,…`
 *
 * BPM and HRV are always 0 for a GeneratorX scan (no physiological sensor), and
 * `Angle + Current` is the arithmetic sum, exactly as Spooky2 writes it.
 */
export function toBfbCsv(
  samples: ReadonlyArray<{
    hz: number;
    current: number | null;
    phaseAngle: number | null;
  }>,
  options: {
    /** `Date_Time` stamp for every row, e.g. `20260821_1411_32`. */
    dateTime: string;
    calibration?: BiofeedbackCalibration;
  },
): string {
  const header = "Date_Time,Frequency,BPM,HRV,Angle,Current,Angle + Current,Spare,Spare,Spare,Spare,Spare";
  const rows = samples.map((s) => {
    const { currentMa, angleDeg } = convertBiofeedback(s.current, s.phaseAngle, options.calibration);
    const fmt = (n: number) => (Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "0");
    const angle = fmt(angleDeg);
    const current = fmt(currentMa);
    const sum = fmt(angleDeg + currentMa);
    return `${options.dateTime},${s.hz},0,0,${angle},${current},${sum},0,0,0,0,0`;
  });
  return [header, ...rows].join("\n") + "\n";
}

/**
 * Render one row of Spooky2's `BFB_Frequencies.csv` — the program file the
 * Spooky2 application loads back in. Each row is a program: a name, a `BFB`
 * marker, a creation stamp, the comma-separated hit frequencies, and a dwell:
 *
 * `"BFB 20260821 Low Frequency",BFB,,"Program Created 21.08.2026 14:14:03","95.5,73,…",,,180`
 */
export function toBfbFrequenciesCsv(
  hits: readonly number[],
  options: {
    /** Program name (first field). Default `BFB <date>`. */
    name?: string;
    /** Creation time for the "Program Created" field. Default now. */
    createdAt?: Date;
    /** Dwell in seconds (last field). Default 180. */
    dwellSeconds?: number;
  } = {},
): string {
  const now = options.createdAt ?? new Date();
  const stamp = `Program Created ${fmtDate(now)} ${fmtTime(now)}`;
  const name = options.name ?? `BFB ${compactDate(now)}`;
  const dwell = options.dwellSeconds ?? 180;
  // Minimal decimal places, like Spooky2 writes them ("95.5", "73", "69.75").
  const freqs = hits.map((h) => String(Number(h.toFixed(4)))).join(",");
  return `"${name}",BFB,,"${stamp}","${freqs}",,,${dwell}\n`;
}

function compactDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function fmtTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

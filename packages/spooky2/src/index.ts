/**
 * `@freqgen/spooky2` — drivers for Spooky2 signal generators.
 *
 * ```ts
 * import { NodeSerialTransport } from "@freqgen/core/node";
 * import { Spooky2XM } from "@freqgen/spooky2";
 *
 * const xm = new Spooky2XM(new NodeSerialTransport("/dev/cu.usbserial-1120"));
 * await xm.open();
 * await xm.applyStep(0, {
 *   waveform: "square",
 *   frequencyHz: 727.5,
 *   amplitudeVpp: 20,
 *   output: true,
 * });
 * ```
 *
 * ## Verification
 *
 * **None of these drivers has been checked against hardware.** They implement
 * protocols documented by third-party reverse engineering, and their tests
 * assert conformance to that documentation — which is not the same as proving
 * the documentation right. Every driver reports `capabilities.limits.verified
 * === false`. Confirm output with a scope before relying on any of it.
 *
 * The Gen X Pro additionally gates physical output behind a challenge/response
 * handshake, and this package ships no response algorithm. See
 * {@link AuthProvider}.
 */

export { Spooky2XM, XM_REGISTERS, XM_RANGE_BOUNDARY_HZ } from "./xm.js";
export type { Spooky2XmOptions } from "./xm.js";

export { GenXClassic, GENX_CLASSIC_REGISTERS } from "./genx-classic.js";
export type { GenXClassicOptions } from "./genx-classic.js";

export {
  GenXPro,
  GENX_PRO_REGISTERS,
  GENX_AMPLITUDE_SCALE,
  GENX_OFFSET_CENTRE,
  GENX_OFFSET_SPAN,
} from "./genx-pro.js";
export type { GenXProOptions, BiofeedbackSample } from "./genx-pro.js";

export { GenXPair } from "./genx-pair.js";

export { generateNonce } from "./auth.js";
export type { AuthProvider, AuthChallenge } from "./auth.js";

export { genXAuthResponse, GENX_AUTH_PROVIDER } from "./genx-auth-transform.js";

export {
  amplitudeRegisterValue,
  channelSlot,
  outField,
  encodeGenXFrequency,
  decodeGenXFrequency,
} from "./genx-wire.js";

export { SPOOKY2_DEVICES } from "./devices.js";

export {
  spectrum,
  spectrumFrequencies,
  frequencySpacing,
  spectrumPercent,
} from "./spectrum.js";
export type { SpectrumParameters } from "./spectrum.js";

export {
  SPOOKY2_WAVEFORMS,
  SPOOKY2_WAVEFORM_NAMES,
  SPOOKY2_WAVEFORM_SAMPLES,
  spooky2Waveform,
} from "./waveforms.js";
export type { Spooky2WaveformName } from "./waveforms.js";

export {
  parsePreset,
  parseFrequencyLine,
  resolvePresetChain,
  activeWaveformWcm,
  presetProgramsForUpload,
  presetToProgram,
} from "./presets.js";
export type {
  Spooky2Preset,
  PresetProgram,
  PresetFrequency,
  PresetRun,
  PresetOutput,
  PresetSegment,
  SweepSegment,
  StepSegment,
  PresetRunOptions,
  ResolvePresetOptions,
} from "./presets.js";
export { runPresetRun } from "./run-preset.js";
export type { RunPresetOptions } from "./run-preset.js";
export { detectHits, convertBiofeedback, toBfbCsv, toBfbFrequenciesCsv } from "./biofeedback.js";
export type {
  BiofeedbackPoint,
  BiofeedbackHit,
  DetectHitsOptions,
  BiofeedbackCalibration,
  CalibratedBiofeedback,
} from "./biofeedback.js";
export { runConformance, compareReports, CONFORMANCE_GROUPS } from "./conformance.js";
export {
  decodeDmsLog,
  captureExpectations,
  loadCaptureExpectations,
  mergeExpectations,
  expectationKey,
  replyShape,
  replyCategory,
  capturedCategories,
} from "./capture.js";
export type { CaptureLine, ReplyCategory } from "./capture.js";
export type {
  ConformanceCase,
  ConformanceReport,
  ConformanceDifference,
  ConformanceOptions,
} from "./conformance.js";

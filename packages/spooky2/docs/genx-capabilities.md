# Gen X Pro capabilities vs. this driver

What the GeneratorX Pro can do, and how much of it `@freqgen/spooky2` currently
covers. Specifications are from the manufacturer; the "confirmed" column records
what has been verified against a real unit (firmware 200) during this work.

## Device specification

| Spec | Value |
| --- | --- |
| Configuration | 2 independent DDS generators (**4 outputs**), per-generator biofeedback |
| Frequency range | 0 – 40 MHz, all waveforms |
| Frequency resolution | 8 decimal places across the whole range |
| Frequency precision | 50 ppm |
| Waveform | 10-bit × 1024-sample, 300 MSPS sampling |
| Amplitude | 20 Vpp max, 0.01 V resolution |
| Output impedance | 50 Ω, short-circuit protected, ≤ 200 mA |
| Modulation | AM (Out 2 modulates Out 1) |
| Measurement | current + phase angle, high-side, 100 Hz – 40 MHz, 16-bit |
| Measurement resolution | current 3.4 µA, phase 0.0015° |
| Offline operation | up to 30 programs, 200 frequencies each |
| USB | 115200 bps |

Two of these directly confirm decisions in the driver:

- **8 decimal places across the range** matches the exponent frequency encoding
  (`encodeGenXFrequency`): the exponent code carries up to eight places. Verified
  by reading frequencies back off the device display.
- **0.01 V amplitude resolution** confirms the amplitude register is centivolts
  of **peak** amplitude: 0–1000 counts cover 0–10 V peak (0.01 V per count),
  i.e. 0–20 Vpp at `vpp × 50`. Confirmed by a capture where a `20` preset drove
  the live register `:w28=1000,` while the offline `:p` field stored `2000`
  (peak-to-peak centivolts, `vpp × 100`).

## Coverage

| Capability | Register(s) | Status | In driver |
| --- | --- | --- | --- |
| Frequency (both outputs) | 24 / 25 | **confirmed on display** | ✅ `setFrequency` |
| Amplitude | 28 / 29 | assignment confirmed (biofeedback); peak-centivolt scale confirmed by capture | ✅ `setAmplitude` |
| Offset | 32 / 33 | **confirmed by capture** (span ±100: `:w32=20,` ⇔ −100, `:w33=220,` ⇔ +100) | ✅ `setOffset` / `setOffsetRatio` |
| Phase (Out 2) | 40 | vendor label | ✅ `setPhase` |
| Output on/off (4 outputs) | 11 | confirmed driving | ✅ `setOutput`, `GenXPair` |
| Waveform: sine, square | 20 / 21 | confirmed (current signature) | ✅ `setWaveform` |
| Waveform inversion | 17 | vendor label | ✅ `setInversion` |
| Gating on/off | 12 / 70 | vendor label | ✅ `setGating` |
| Out 2 modulation on/off | 13 | vendor label | ✅ `setModulation` |
| Out 2 sync | 14 | vendor label | ✅ `setSync` |
| Low-frequency mode | 15 (two fields) | **confirmed by capture** (`:w15=<a>,<b>,`; 51 never sent) | ✅ `setLowFrequencyMode` |
| Gate times (per output) | 50 / 51 | **confirmed from the display firmware** (`runner.c:60-66`: `:w50=aaaaa,bbbbb,` before `:w12=1,1,`) | ✅ `setGateTimes` |
| Calibration | — | a vendor debug string calls 50 "Calibrate no load", but the firmware uses 50/51 as gate times and never uses 71 | ❌ withdrawn |
| Program/name readback | `:n<NN>=?` / `*` / `#` | **confirmed from the display firmware** (`link.c:476-526`) | ✅ `readProgramName` / `readProgram` / `readGateTable` |
| Display revision | `:n00=$` → `:Rev201` | **confirmed** (`link.c:549-551`); ungated, Spooky2 sends it on connect | ✅ `readDisplayRevision` |
| Erase one slot / all slots | `:n<NN>=,` / `:w96=12321,` | **confirmed** (`link.c:552-556`, `634-639`); `w96` erases slots 1–30 + names, once per power cycle | ✅ `eraseProgram` / `eraseAllPrograms` |
| Backlight | 64 | **confirmed** (`link.c:606-611`), not gated by auth | ✅ `setBacklight` |
| PC display-state reset | 97 | **confirmed** (`link.c:640-651`) | ✅ `resetPcDisplayState` |
| Reset | 95 | vendor label | ✅ `reset` |
| Authentication | 90 / 92 | **confirmed on hardware** | ✅ bundled provider |
| Biofeedback read (current, angle) | r11 / r12 | **confirmed reading live values** | ✅ `readBiofeedback` (raw counts) |
| Biofeedback scan | w24 sweep + r11/r12 | **confirmed by Spooky2 capture** | ✅ `biofeedbackScan` |
| Waveform upload (10-bit × 1024) | `:a<slot>=` | decoded from capture, not HW-tested | ✅ `uploadWaveform` |
| Display text | `:n00=` | confirmed in capture | ✅ `setDisplayText` |
| Offline program upload | `:n`/`:p`/`:g<slot>=` | **confirmed by capture** (freqs = exponent, gate = 2×count zeros, offset always 120) | ✅ `uploadProgram` / `loadPreset` / `writeOfflineSlot` |
| Frequency sweep | w24 loop | **confirmed by capture** (linear steps, ~82–84/range) | ✅ `frequencySweep` |
| Firmware version | `:r02=` | **confirmed by capture** (`:r02=200.`) | ✅ `readFirmwareVersion` |
| Program running (host-side, dwell) | — | device-agnostic | ✅ `runProgram` |

## Gaps

Ranked by value against how reachable each is without an oscilloscope.

### Reachable now

- **Biofeedback scan.** `readBiofeedback()` / `readCurrent()` / `readPhaseAngle()`
  are exposed by `readBiofeedback()` (raw counts, confirmed live on hardware),
  and `biofeedbackScan()` performs the scan.
- **Raw-count → amps/degrees calibration.** The spec gives 3.4 µA and 0.0015°
  resolution. Spooky2 displays and exports **exactly `r11 / 100` and
  `r12 / 100`**. Its BFB CSV rows are `(loop − baseline) / 100`, confirmed row
  for row against the capture (2026-08-21), and its display showed `:r11=46210.`
  / `:r12=5784.` as 462.10 / 57.84 (2026-09-21). Its scan flags a "hit" when the
  value deviates from a running average — a simple resonance detector. The
  library uses the `/100` scale by default. Absolute amps still need a
  reference meter. With nothing connected, the detector still reads about 462 /
  57.8°, flat across frequency (±0.02 over a 3 % sweep, where capacitive current
  would rise by ~15). That no-load reading is a fixed baseline; a load (a
  Sample Digitizer: +27 / +17°) adds to it.
- **Offset scale confirmation.** Frequency is display-verified and amplitude is
  capture-confirmed (peak centivolts, `vpp × 50`); the offset span is now
  **confirmed ±100** by the capture (`:w32=20,` ⇔ Offset −100, `:w33=220,` ⇔
  Offset +100), so the driver's `GENX_OFFSET_SPAN = 100` is no longer assumed.

### What a Spooky2 serial capture settled

A capture of the real Spooky2 ↔ device traffic (biofeedback scan + wobble +
running programs) showed that **Spooky2 uses no register this driver does not
already map**. The features that looked like gaps are host-side loops over the
frequency register, not device functions:

- **Biofeedback scan** = write `w24` (frequency), read `r11` (current) and `r12`
  (phase), step, repeat — 92k reads across a fine frequency sweep. Implemented as
  `biofeedbackScan()`.
- **Wobble** = rapid `w24` frequency writes (with `w28`/`w29` amplitude changes) —
  61k writes. No wobble register exists; it is frequency modulation in software,
  reproducible with `setFrequency` in a loop.
- **Running programs** = `w24`/`w28`/`w29` sequencing — covered by
  `runProgram()`.
- **Display text** = `:n00=<text>` (e.g. "Port 3 - General Biofeedback").

### Waveform upload — protocol decoded

The 23 Spooky2 waveforms are uploaded, not selected from 23 live slots. The
capture revealed the command: **`:a<slot>=<s0>,<s1>,…,`** carries the whole
1024-point table in one write, each sample a 10-bit value (0–1023, mid-scale
512). `uploadWaveform(slot, samples)` now emits exactly this (scaling a
normalised −1…+1 table, e.g. `SPOOKY2_WAVEFORMS`, to 10-bit); `setWaveform(ch,
slot)` selects it. Not yet hardware-verified, but reproduced from the captured
form. This is the path to the full waveform set.

### Offline program upload — decoded and implemented

Standalone programs are stored across per-slot commands, all decoded from the
capture:

- `:n<slot>=<name>` — program/waveform name (`:n06=(-)-beta-Elemene`)
- `:p<slot>=<waveformSlot>,<amp×100>,<offset=120>,<dwell>,<count>,<f0>,…,` — parameters
- `:g<slot>=<gate schedule>` — gating (all-zero = none)
- `:a<slot>=<samples>` — the waveform table (above)

The frequency field uses the **same exponent encoding as live `w24`** —
`round(Hz × 1000) + 6` for Hz values, e.g. `:p01=41,2000,120,600,1,7836,` =
7.83 Hz and `:p04=44,2000,120,2700,1,183586,` = 183.58 Hz. (An earlier claim
that it was integer nanohertz was a fluke: values ending in `0` decode
identically both ways.) The **gate field is `2 × count` zeros** (`:g01=0,0,` for
one frequency, `:g07=0,0,0,0,0,0,0,0,0,0,0,0,` for six), and offline programs are
stored with **offset 120 (centre) regardless of the preset's `Out1_Offset`** —
offsets are applied at run time via registers 32/33. `uploadProgram(slot, {...})`
builds the whole sequence; `loadPreset()` parses a Spooky2 preset `.txt` and
uploads its single-frequency programs 1:1. Ranges are run-time sweeps;
radionics/spectrum singles (`396=11`) are decoded `freq ÷ wcm` → 36 Hz; DNA
`~…` strings are preserved raw (their decode is an open research item).
`writeOfflineSlot()` remains for raw field access. The dwell unit is assumed to
match the live device and isn't independently verified, and none of it is
hardware-tested yet.

### Frequency sweep — decoded and implemented

A second capture (running a preset) shows Spooky2 sweeping frequencies with a
plain host-side loop: sequential `:w24=<freq>,` writes, **no biofeedback reads**,
linear in Hz within each segment (~0.18 Hz/step at 3.44 Hz, ~3.9 Hz/step at
72 Hz), ~72–84 steps per range, six programs × three segments (low sweep /
single / high sweep). **Both ranges and singles are played at `÷ wcm`** — the
range `36-198=11` sweeps `36/11 → 198/11` = 3.27→18 Hz, and the single `396=11`
is 36 Hz. Each single and each sweep lasts `wcm` seconds (11 s), so a program is
33 s and the whole preset ≈ 3.3 min. `frequencySweep()` reproduces a single
sweep; `presetToProgram()` + `runPresetRun()` reproduce the whole preset on any
`SignalGenerator` (Gen X Pro, FeelTech, …).

One known artefact: the very first sweep in the capture is preceded by a
two-value **wobble/ramp lead-in** (`3.440` Hz for 0.83 s, then `4.737` Hz for
0.04 s) whose step sizes and dwells differ from the regular sweep. It is a
one-off at capture start (programs 2–6 start cleanly at `÷ wcm`) and is not
reproduced by the library, which sweeps the clean `÷ wcm` range.

### Spectrum — understood, math implemented

The Spooky2 User's Guide settled how "Spectrum" (and the DNA molecular
frequencies) reach the device: a Spectrum is **not** thousands of frequency
commands. One center frequency plus a tolerance and a Wave Cycle Multiplier
defines a cluster of child frequencies, which Spooky2 bakes into a computed
1024-sample waveform (the `:a<slot>=` upload) played at the center. The `spectrum`
helpers implement the guide's formulas exactly:

```
Frequency Spacing = Center × Tolerance
Spectrum %        = WCM × 100 × FrequencySpacing ÷ Center
children          = Center + k × Spacing,  k = −WCM … +WCM   (2·WCM+1 total)
```

Verified against the guide's worked examples. What the guide does **not** give is
the sample-by-sample algorithm that turns a child-frequency cluster into the
1024-point waveform, so generating the actual composite table is still open —
but the frequency math, and the fact that it rides in a waveform rather than a
command stream, are settled. The guide's nine base waveforms (sine, square,
sawtooth, inverted sawtooth, triangle, damped sine/square, sine/square H-bomb)
match `SPOOKY2_WAVEFORMS`.

## Summary

A capture of the real Spooky2 protocol confirmed the important thing: **the
live-control register map is complete.** Frequency, amplitude, offset, phase,
waveform (sine/square), output, inversion, gating/sync/modulation toggles,
low-frequency mode, calibration, reset, authentication, biofeedback read **and
scan**, and program running are all implemented, and the core path plus the
biofeedback detector are hardware-verified. Spooky2's wobble and scan turned out
to be host-side loops over the frequency register, not device features, so they
need no new protocol.

A second capture (preset loading + running) settled the **offline program
upload** (`:n`/`:p`/`:g<slot>=` — exponent-encoded frequencies, `2 × count` gate
zeros, offset always 120) and the **frequency sweep** (plain `w24` loop, linear
steps). Both are implemented: `loadPreset()` parses Spooky2 preset `.txt` files
and uploads their single-frequency programs 1:1, and `frequencySweep()`
reproduces the sweep. The preset parser also handles range entries (run-time
sweeps), decodes radionics/spectrum singles (`396=11` → 36 Hz, `freq ÷ wcm`),
and preserves DNA `~…` strings raw — decoding those is the one open protocol
question left.

What genuinely remains: the **full waveform set via upload** (the device takes
1024-sample tables, which we ship but don't yet push), **live gating**
(register 12; the offline gate schedule is implemented), and absolute
**calibration** of amplitude/offset/biofeedback counts, which needs a meter, not
more protocol work.

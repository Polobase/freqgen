# @freqgen/spooky2

TypeScript drivers for **Spooky2** signal generators — XM, Gen X and Gen X Pro —
over USB serial, in Node.js and the browser. Part of the
[`@freqgen`](../../README.md#feature-matrix) monorepo — see the main README for
the device × capability feature matrix.

> ### ⚠️ Output is not hardware-verified
>
> These drivers implement protocols documented by third-party reverse
> engineering. Their tests assert conformance to that documentation, which is
> **not** the same as proving the documentation right. Each reports
> `capabilities.limits.verified === false`. **Confirm output with a scope.**
>
> The Gen X Pro driver's *link layer* has been checked against a real unit
> (firmware 200): connecting, identity readback, the lock state and the
> challenge exchange all behave as documented. Nothing past the lock could be
> tested, because a locked unit rejects every register write.

## Install

```bash
npm install @freqgen/spooky2
```

## Use

```ts
import { NodeSerialTransport } from "@freqgen/core/node";
import { Spooky2XM } from "@freqgen/spooky2";

const xm = new Spooky2XM(new NodeSerialTransport("/dev/cu.usbserial-1120"));
await xm.open();
await xm.applyStep(0, {
  waveform: "square",
  frequencyHz: 727.5,
  amplitudeVpp: 20,
  output: true,
});
await xm.close();
```

## CLI

```bash
npx @freqgen/spooky2 devices                 # drivers + verification status
npx @freqgen/spooky2 list                    # serial ports
npx @freqgen/spooky2 set --device xm --port /dev/cu.usbserial-1120 \
    --waveform square --freq 727.5 --amp 20 --on
```

## Comparing two firmwares on a Gen X Pro

The display board's behaviour has been recovered from its firmware
([open-spooky2](https://github.com/Polobase/open-spooky2)), so a unit can be
checked against it — which is what you want when you flash your own build and
need to know what changed:

```bash
# on the original firmware
npx @freqgen/spooky2 conformance --port /dev/cu.usbserial-X --record original.json
# flash your build, then
npx @freqgen/spooky2 conformance --port /dev/cu.usbserial-X --compare original.json
```

Each case asserts what the spec says *and* records the exact reply, so the diff
catches both spec violations and undocumented behaviour your build dropped.

Point it at your `.dmslog8` captures and it adds a third opinion — what the
vendor software actually got out of a real unit:

```bash
npx @freqgen/spooky2 conformance --port /dev/cu.usbserial-X --captures ./local
# Expectations from 8 capture(s) in ./local: 29 commands the real device answered.
#   ✔ reg-frequency   Out 1 / Out 2 frequency (:w24=/:w25=)  ⟦capture ✔⟧
```

A capture settles what no document can: `:w13=0,` is acknowledged, `:n00=$`
answers with a revision, every live register write is met with `:ok`. The check
compares the *kind* of answer — acknowledged, rejected, silent or data — not the
data itself, which belongs to the unit the capture came from. Cases with no
vendor counterpart (an out-of-range slot, a line built to be dropped) are not
compared. Reading ~100 MB of captures takes about 20 seconds; point `--captures`
at one capture folder to keep it quick.
Groups (`--groups`): `link`, `registers`, `programs`, `parser`, `handshake`,
`calibration`, `biofeedback`, `display`.

It covers every command in open-spooky2's `docs/serial-commands.md` except the
ones that would damage or disturb the unit, which it never sends:

| Not sent | Why |
| --- | --- |
| `:w96=12321,` | erases all 30 programs and every name |
| `:w95=12021,` | reboots the display MCU |
| `:w00=` | writes the bootloader flash page on the original firmware |
| `:w91=` | the vendor's session handshake — the driver already runs it |
| `:w60` `:w61` `:w62` `:w63` `:w80` | calibration **writes**; the read `:r80=0,` is included |

No output is ever enabled and amplitude is only ever written as 0, so a scope
stays quiet. It borrows one program slot (`--slot`, default 30), dumping its
contents first and restoring them afterwards. The visible cases run last: the
PC-mode title is set and put back, a frequency is left on screen, and the
backlight blinks off and on — so you can see the run finish on the device.

A display-handled `:w` frame (`:w64`, `:w97`) is processed in the device's main
loop, and while one is pending the link **discards every byte that arrives**
(`src/link.c:284`). Anything sent straight after one is lost, so the suite
leaves a gap between them — without it, a backlight restore goes missing and
the screen stays dark.

## Reading the device back

Program memory is readable, so you can verify what is actually stored:

```ts
await pro.readDisplayRevision();   // "Rev201"  (:n00=$)
await pro.readProgramName(7);      // ":n07=?"
await pro.readProgram(7);          // ":n07=*" → the same shape uploadProgram takes
await pro.readGateTable(7);        // ":n07=#" — 200 of the 400 stored values
await pro.eraseProgram(7);         // ":n07=,"
await pro.eraseAllPrograms();      // ":w96=12321," — wipes slots 1–30 AND every name
```

`eraseAllPrograms()` is destructive and the device honours it only once per
power cycle. Spooky2 sends it *before* rewriting the whole slot set.

## Devices

| Driver | Device | Protocol | Notes |
| --- | --- | --- | --- |
| `Spooky2XM` | XM | 57600 8N1, `:w<reg><val>` + `ok` | Sawtooth slot direction unconfirmed |
| `GenXClassic` | Gen X (classic) | 115200 8N1, `:w<reg>=<a>,<b>,` | Experimental; audio/RF boundary is a default, not a measurement |
| `GenXPro` | Gen X Pro | as above, plus an arm/ramp sequence | Output gated behind authentication — see below |
| `GenXPair` | two Gen X Pros | two ports, one per unit | The Pro's dual-port bridge exposes each generator separately |

Protocol references: [`docs/xm-protocol.md`](docs/xm-protocol.md),
[`docs/genx-protocol.md`](docs/genx-protocol.md).

## The register map is the vendor's own

The Gen X Pro driver was rebuilt on the register assignments Spooky2's own
application prints in its debug strings (`:w24` = "Out 1 Frequency", `:w28` =
"Out 1 Amplitude", …) — see [`docs/spooky2-command-set.md`](docs/spooky2-command-set.md).
That map was cross-checked on a real Gen X Pro: with the output running, stepping
`:w28` moved the device's own biofeedback current sensor and stepping `:w17` did
not, confirming `:w28` is amplitude.

It replaced an earlier third-party map that treated `:w28`/`:w29` as a frequency
"ramp" and needed an elaborate arm-and-ramp sequence to get output. That
sequence was really ramping the *amplitude* up from zero. **The Gen X drives
like any register device** — plain writes, no ramp — so `applyStep()` is now the
ordinary sequential application, and `capabilities.requiresFrequencyRamp` is
`false`.

The *scale factors* (counts per hertz, per volt) are not yet scope-confirmed;
the driver uses XM-analogous defaults and marks them in code.

### Beyond the basics

The Gen X Pro exposes the per-output functions Spooky2 shells use, all from the
vendor labels: `setGating`, `setModulation`, `setSync`, `setInversion`,
`setLowFrequencyMode`, `calibrate` and `reset`.

## Gen X Pro output is gated behind a handshake

The outputs accept writes and reads only after a register-92 challenge/response
succeeds. `GenXPro` authenticates automatically with a bundled provider
({@link GENX_AUTH_PROVIDER}), confirmed working on real hardware, so a Pro you
own drives out of the box:

```ts
const pro = new GenXPro(transport);   // authenticates on open()
```

The response transform is an interoperability key for the device — a small
arithmetic function that lets your own hardware talk to non-vendor software. To
use a different one, or none:

```ts
new GenXPro(transport, { authProvider: myProvider }); // override
new GenXPro(transport, { authProvider: null });       // disable; outputs stay gated
```

## Waveform tables

`SPOOKY2_WAVEFORMS` ships the eleven real Spooky2 waveform sample tables (sine,
square, sawtooth, inverted sawtooth, triangle, the damped pair, the H-bomb pair,
and two user-defined slots), taken verbatim from the vendor's `Waveforms.csv` at
1024 samples each, normalised to −1…+1.

Live waveform selection (`setWaveform`) covers the built-in sine and square; the
other Spooky2 shapes are uploaded sample tables via `uploadWaveform(slot,
samples)` (the `:a<slot>=` command, decoded from a real capture). See
[`docs/genx-capabilities.md`](docs/genx-capabilities.md) for the full
capability/gap analysis.

## Biofeedback

The Gen X Pro's high-side detector reads output current and phase angle, live:

```ts
const { current, phaseAngle } = await pro.readBiofeedback(); // raw detector counts
```

Confirmed reading live values on hardware. Spooky2 shows both as **count / 100**
(`:r11=46210.` → Current 462.10), and `convertBiofeedback()` / `toBfbCsv()` use
that scale by default, so their values match Spooky2's display and BFB CSV. The
absolute conversion to amps/degrees is not calibrated. An unloaded Gen X Pro
still reads about 462 / 57.8° — a fixed baseline. A load only adds to it, so
biofeedback works on changes from a baseline, never the absolute number.

`biofeedbackScan()` reproduces Spooky2's biofeedback scan. The settings below are
Spooky2's "General Biofeedback Scan (SD)", checked against a serial capture of
it. Each step and each settle reading goes out on the wire exactly as Spooky2
sends it:

```ts
const samples = await pro.biofeedbackScan({
  startHz: 41_000, endHz: 1_800_000,
  stepPercent: 0.025,   // BFB_Initial_Step_Size_% — 41000 × 1.00025^k
  startDelay: 200,      // BFB_Start_Delay — settle readings, discarded
  loops: 2, baseline: true, dwellMs: 70,
  amplitudeVpp: 40,     // :w28=2000, — what Spooky2 wrote for "20v"
});
const hits = detectHits(samples.map((s) => ({ hz: s.hz, value: s.current })));
```

Like Spooky2, it drives both outputs: Out 2 follows Out 1's frequency in
hardware, inverted, at the same amplitude. Pass `bothOutputs: false` to drive
only `channel`.

## Running a program

A frequency program — a list of steps with dwell times — runs on any driver via
`runProgram()` from `@freqgen/core`:

```ts
import { runProgram } from "@freqgen/core";

await runProgram(xm, [
  { frequencyHz: 727.5, dwellSeconds: 180 },
  { frequencyHz: 787,   dwellSeconds: 180 },
  { frequencyHz: 880,   dwellSeconds: 180 },
], { repeat: 3, signal: abortController.signal });
```

## Preset loading

A Spooky2 preset `.txt` can be parsed and its single-frequency programs uploaded
to the Gen X Pro's offline slots, matching what a real capture shows:

```ts
import { parsePreset, GenXPro } from "@freqgen/spooky2";

const preset = parsePreset(await readFile("preset.txt", "utf8"));
const count = await pro.loadPreset(preset); // uploads waveform + n/p/g per program
```

Real presets are thin: a shipped preset is often nine lines that inherit their
amplitude, offset, active waveform and Out 2 frequency factor from a
`Base_Preset` shell they point at. `resolvePresetChain` follows that chain (it
takes an injected file reader, so it stays browser-safe), merging child over
base into one preset — use it instead of `parsePreset` when loading a file from
disk:

```ts
import { resolvePresetChain } from "@freqgen/spooky2";
import { readFileSync } from "node:fs";

const preset = resolvePresetChain("Acholeplasma (DNA) (R).txt", (p) =>
  readFileSync(p, "utf8"),
);
```

`loadPreset` uploads each program 1:1 (waveform to slot 41+index, name/gate/
parameters to slot 1+index), using the preset's `Out1_Amplitude` for the
amplitude field. Range entries (`36-198=11`) are run-time sweeps, not offline
slots, so they're excluded. Radionics/spectrum singles (`396=11`) are decoded as
`freq ÷ wcm` → 36 Hz (confirmed against a capture). DNA `~…` strings are
preserved raw (their decode is an open research item). Offline programs are
stored with offset 120 (centre) — Spooky2 applies the preset's `Out1_Offset` at
run time via registers 32/33.

## Running a preset on any device

A preset can also be *run* — not just uploaded — on any `SignalGenerator` (Gen X
Pro, FeelTech FY, …), reproducing what a Spooky2 capture shows the generator
actually plays:

```ts
import { parsePreset, presetToProgram, runPresetRun } from "@freqgen/spooky2";

const run = presetToProgram(parsePreset(await readFile("preset.txt", "utf8")));
await runPresetRun(device, run); // device: any SignalGenerator
```

`presetToProgram` turns the preset into a device-agnostic run plan: ranges become
sweeps at `freq ÷ wcm` (`36-198=11` → 3.27→18 Hz), radionics singles decode to
`freq ÷ wcm` (held `wcm` seconds), and `Out1/Out2_Offset` percentages become DC
offsets in volts. Each output also carries its own frequency transform, so Out 2
rides at `Out 1 × Out2_Hz_Factor + Out2_Hz_Constant` (the DNA octave, a spectrum
carrier) rather than both outputs sharing one frequency. `runPresetRun` configures
the outputs once, loops the frequency per step, and switches off at the end — the
same structure the capture shows.

The CLI does the same thing:

```bash
spooky2 run-preset --device genx-pro --port /dev/cu.usbserial-1120 \
    --preset "Manifestation.txt"
feeltech run-preset --port /dev/cu.usbserial-1420 --preset "Manifestation.txt"
```

## Frequency sweep

The capture shows Spooky2 sweeping frequencies with a plain host-side loop of
`:w24=` writes (linear in Hz, ~82–84 steps per range). `frequencySweep()`
reproduces it:

```ts
const swept = await pro.frequencySweep({
  startHz: 36, endHz: 198, steps: 84,
  amplitudeVpp: 20, dwellMs: 100, stopOutputAtEnd: true,
});
```

## Unsupported parameters

Duty cycle has no register on the Gen X, so the drivers accept `dutyCyclePct: 50`
(the neutral every preset carries) and **throw** on anything else rather than
silently running the wrong shape. On the Gen X Pro, Out 1 also has no phase
register — phase is set on Out 2 relative to Out 1.

## License

MIT

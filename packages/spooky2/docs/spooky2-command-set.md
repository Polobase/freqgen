# Spooky2 serial command set — extracted from the vendor application

Source: `Spooky.exe` (VB6, 5.1 MB) from a Spooky2 installation, plus its
`Data/Waveforms.csv` and `Data/SettingsCFG.txt`.

## Why this document supersedes the other two

The register maps in `xm-protocol.md` and `genx-protocol.md` came from
third-party reverse engineering. This one comes from **Spooky2's own debug and
logging strings** — the labels the vendor's software prints next to each command
as it sends it:

```
:w24=   " Out 1 Frequency"
:w28=   " Out 1 Amplitude"
:w32=   " Out 1 Offset"
:w12=   " Out 1 Gating On" / " Out 1 Gating Off"
```

That is the vendor stating what each register does. It is the strongest evidence
available short of a scope, and where it disagrees with the third-party notes,
it wins.

**Partly confirmed on hardware.** With a local (unpublished) auth provider, the
Gen X Pro on hand (firmware 200) was unlocked and driven. The amplitude
assignment was confirmed directly: with output running, stepping `:w28` moved
the device's own biofeedback current sensor (`:r11`) monotonically, while
stepping `:w17` did not — so `:w28` is amplitude and `:w17` is not, exactly as
the vendor labels say. The remaining assignments rest on the vendor labels; the
scale *factors* (counts per hertz, per volt) still need a scope. There is no
live-parameter readback on the device — the `:r*` space is offline-program
memory and biofeedback, not a mirror of what you wrote — so readback cannot
confirm the rest.

---

## Devices Spooky2 itself drives

| Device | Port settings | Notes |
| --- | --- | --- |
| Spooky2 XM | `57600,n,8,1` | CP210x (`10c4:ea60`); the app's own error string names that ID |
| GeneratorX / GX Pro | 115200 8N1 | |
| MicroGen | — | "Searching for MicroGen", "Silicon Labs CP210x" — **a third device, not implemented here** |

There is **no** FeelTech, JUNTEK or Koolertron support in Spooky2 itself: the
binary contains no `WMF`/`UMO`/`:w23=` -style literals. Those devices come from
third-party consoles, not from the vendor.

---

## Spooky2 XM

Framing `:w<reg><value>` — no `=`, no comma fields.

| Register | Out 1 | Out 2 | Parameter |
| --- | --- | --- | --- |
| Waveform | `21` | `22` | waveform number |
| Frequency | `23` | `24` | see scale below |
| Amplitude | `25` | `26` | centivolts (`:w250` = 0 V) |
| Offset | `27` | `28` | percent, `100` = centre (`:w27100`) |
| Duty cycle | `29` | `30` | percent × 10 |
| Phase angle | `31` | `32` | degrees; max seen "655.35 Degrees" |
| Output relay | `61` | `62` | `:w611` on, `:w610` off |
| Frequency scale | `63` | `64` | `:w630` coarse, `:w631` fine |
| Sync | `68` | — | `:w681` on, `:w680` off |

Identification handshake: `:a00`, `:a0012345`, answered `ok0000000000` or `err`.
Generator memory is read and written with `:a`, `:b`, `:n` plus `=?` / `=#`
("Reading generator memory … / 30" — 30 slots).

This confirms the existing `Spooky2XM` driver's register map in full, including
phase being per-channel at 31/32.

---

## GeneratorX / GX Pro — live control

Framing `:w<reg>=<out1>,<out2>,` — two comma-separated fields, one per output.
Addressing one output leaves the other field empty (`:w11=1,,` / `:w11=,1,`).

| Register | Parameter | Vendor label |
| --- | --- | --- |
| `11` | Output on/off | " Out 1 On" / " Out 1 Off" / " Out 2 On" / " Out 2 Off" |
| `12` | **Gating, both outputs** (two fields) | vendor label says "Out 1 Gating", but a capture shows `:w12=<a>,<b>,` driving *both* outputs; register 70 is never sent |
| `13` | **Out 2 modulation** | " Out 2 Modulation On/Off" |
| `14` | **Out 2 sync** | " Out 2 Sync On/Off" |
| `15` | **Low-frequency mode, both outputs** (two fields) | vendor label says " Out 1 Low Frequency mode On/Off"; a capture shows `:w15=<a>,<b>,` carrying *both* outputs — register 51 is never sent |
| `17` | **Waveform inversion** | " Out 1/2 Waveform Inversion On/Off" |
| `20` | Out 1 waveform # | " Out 1 Waveform # " |
| `21` | Out 2 waveform # | " Out 2 Waveform # " |
| `24` | **Out 1 frequency** | " Out 1 Frequency" |
| `25` | **Out 2 frequency** | " Out 2 Frequency" |
| `28` | **Out 1 amplitude** | " Out 1 Amplitude" |
| `29` | **Out 2 amplitude** | " Out 2 Amplitude" |
| `32` | Out 1 offset | " Out 1 Offset" |
| `33` | Out 2 offset | " Out 2 Offset" |
| `40` | **Out 2 phase angle** | " Out 2 Phase Angle" |
| `50` | Calibrate, no load | " Calibrate no load" |
| `71` | Calibrate, 50 Ω load | " Calibrate 50 Ohm Load" |
| `95` | Reset — `:w95=12021,` | " Reset" |
| `96` | `:w96=12321,` | (adjacent to Reset; purpose unlabelled) |

### Where this contradicts the third-party map

The notes this package's `GenXPro` driver was built from assign several of these
registers different meanings. Set side by side:

| Register | Third-party notes said | Vendor label says |
| --- | --- | --- |
| `17` | amplitude | **waveform inversion** |
| `24` | "arm" with an exponent encoding | **Out 1 frequency** |
| `28` / `29` | display-frequency ramp targets | **Out 1 / Out 2 amplitude** |
| `12` | reset (written as a `0,,` / `,0,` pair) | **Out 1 gating** |
| `13` | clear | **Out 2 modulation** |
| `14` | channel select | **Out 2 sync** |
| `40` | stop | **Out 2 phase angle** |

If the vendor labels are right, the elaborate prepare/arm/ramp sequence is not
how the device is meant to be driven at all — frequency, amplitude and offset
are plain register writes, and the Gen X *can* be driven parameter by parameter.

It also explains the reported incident where writing the offset registers
"killed the output": the accompanying `:w40=0,` was believed to be a latch, but
by this map it sets Out 2's phase angle, and the write that actually silenced
the channel was elsewhere in the sequence.

**Unresolved:** the claim that a single frequency jump produces no output and
must be ramped. That is a firmware behaviour, not a register meaning, so the
vendor's labels neither confirm nor refute it. The stop sequence the binary does
show is simply `:w28=0,` `:w29=0,` `:w11=0,0,` — zero both amplitudes, then drop
both outputs.

### GX waveform upload & offline programming — decoded from a live capture

A 2026-08-15 serial capture of Spooky2 (biofeedback scan + wobble + running
programs + "save to device") settled these. The **live-control register map is
complete** — Spooky2 uses no `:w`/`:r` register this driver doesn't already map.
The additional commands are the upload/offline group:

| Command | Purpose | Format |
| --- | --- | --- |
| `:a<slot>=<samples>,` | **Waveform upload** | 1024 samples, 10-bit (0–1023, mid 512), whole table in one command |
| `:n00=<text>` | Display text | e.g. `Port 3 - General Biofeedback` |
| `:n<slot>=<name>` | Offline program name | `:n06=(-)-beta-Elemene` |
| `:p<slot>=<wfSlot>,<amp>,<offset>,<phase>,…` | Offline program parameters | `:p06=46,2000,120,180,7,…` (offset 120 = centre) |
| `:g<slot>=<schedule>` | Offline gating schedule | `:g06=0,0,0,…` (all-zero = none) |

Waveform slots seen uploaded: 11–21, 24, 25, 45–47. `:w20=<slot>` / `:w21=<slot>`
then select a slot for live output (11 = sine, 12 = square, 13 = rising ramp).

The biofeedback scan is a host-side loop — `:w24=<freq>` then `:r11=` (current)
and `:r12=` (phase), swept across a range; Spooky2's displayed value is exactly
`r11/100` (and `r12/100`), and it flags a "hit" where that deviates from a running
average. A percentage step multiplies the frequency each step (0.025 % from 41 kHz
→ `41000 × 1.00025^k`), and `BFB_Start_Delay=200` shows up as 202 reads at the
start frequency (201 discarded, one kept) in every pass. A second capture
(2026-08-15, "save to device" + running a preset) shows a **plain frequency
sweep** with no biofeedback reads: sequential `:w24=<freq>,` writes, linear in Hz
within each segment (~0.18 Hz/step at 3.44 Hz, ~3.9 Hz/step at 72 Hz), ~82–84
steps per range, six programs × three segments (low sweep / single / high sweep).
The single frequencies decode as preset frequency ÷ WCM(11): `396→36`,
`417→37.909`, `528→48`, etc. Ranges are run-time sweeps, not offline slots.

The `:p` **frequency field uses the same exponent encoding as live `w24`** —
`round(Hz × 1000) + 6` for Hz values, e.g. `:p01=41,2000,120,600,1,7836,` =
7.83 Hz and `:p04=44,2000,120,2700,1,183586,` = 183.58 Hz. (An earlier claim
that it was integer nanohertz was a fluke: values ending in `0` decode
identically both ways.) Full `:p` layout:
`:p<slot>=<waveformSlot>,<amp×100>,<offset=120>,<dwell>,<count>,<f0>,…,`.
The **gate field is `2 × count` zeros** (`:g01=0,0,` for one frequency,
`:g07=0,0,0,0,0,0,0,0,0,0,0,0,` for six). Offline programs are stored with
**offset 120 (centre) regardless of the preset's `Out1_Offset`** — offsets are
applied at run time via registers 32/33, whose span is **±100** (`:w32=20,` ⇔
−100, `:w33=220,` ⇔ +100). `uploadProgram()`, `uploadWaveform()` (`:a`),
`setDisplayText()` (`:n00`), `loadPreset()` and `frequencySweep()` are all
implemented; `writeOfflineSlot()` remains for raw field access.

### Authentication

`:r90=` / `:w92=` / `:r92=`, with `:r80=`, `:w81=`, `:ok` and `:a0012345` nearby.
The response transform is **not** reproduced here — see `auth.ts` for why, and
for the `AuthProvider` hook that lets you supply one.

The binary also carries "Generator is fake." / "Generator is genuine." and
"failed handshake.", so the handshake doubles as an authenticity check.

---

## MicroGen

A third device, not implemented in this package:

| Command | Purpose |
| --- | --- |
| `:w07=0.` / `:w07=1.` | (transfer control — "Frequencies successfully transferred") |
| `:w08=0,` / `:w08=1,` | DC mode ("DC mode error") |
| `:w09=0,` / `:w09=1,` | on/off ("Error turning MicroGen off") |
| `:w10=` | frequency count ("Frequency Count Command error") |
| `:w11=0,` | output off |
| `:r00=` / `:r00=0.` | status |

---

## Waveforms

`Data/Waveforms.csv` is the actual sample data Spooky2 uploads: **1024 samples ×
15 columns**, normalised to −1…+1. Identified by shape:

| Column | Waveform | Signature |
| --- | --- | --- |
| 0 | Sine | 0 → +1 → 0 → −1 |
| 1 | Square | +1 first half, −1 second |
| 2 | Sawtooth | linear −1 → +1 |
| 3 | Inverted sawtooth | linear +1 → −1 |
| 4 | Triangle | −1 → +1 at 50 % → −1 |
| 5 | Sine damped | decaying envelope |
| 6 | Square damped | decaying envelope |
| 7 | Sine H-bomb | near-zero with ±1 spikes |
| 8 | Square H-bomb | near-zero with spikes |
| 9 | User defined 1 | positive-only, 0 → +1 |
| 10 | User defined 2 | identical to 9 |
| 11, 12 | unused | constant −1 |
| 13 | Sine | duplicate of column 0 |
| 14 | Inverse sine | mirror of column 13 |

Columns 0–10 line up exactly with the waveform flags in Spooky2 preset files
(`Out1_Sine`, `Out1_Square`, `Out1_Sawtooth`, `Out1_Inverted_Sawtooth`,
`Out1_Triangle`, `Out1_Sine_Damped`, `Out1_Square_Damped`, `Out1_Sine_Hbomb`,
`Out1_Square_Hbomb`, `Out1_User_Defined_1`, `Out1_User_Defined_2`). Columns 9
and 10 being identical matches `SettingsCFG.txt`, where both user-defined slots
are set to `Alpha-Stim`.

**Open question:** how these column indices map to the numbers written to the
waveform registers. The third-party arm sequence writes values like `14` and
`25` to registers 20/21, which exceeds this table's range, and the binary holds
an unattached literal `101` beside the waveform labels.

---

## Functions Spooky2 exposes that this package does not implement

Named in the binary's own function labels:

- **Gating** — `SetGate(Port, 1/2)`, GX registers 12 and 70. The offline gate
  schedule (`:g<slot>=`) is implemented as `2 × count` zeros; live gating
  (register 12) is not.
- **Out 2 modulation** (register 13) and **Out 2 sync** (register 14).
- **Waveform inversion** (register 17).
- **Calibration** (registers 50 and 71).
- **Frequency multiplier / offset for Out 2** — `Freq2Multiplier(Port)`,
  `Freq2Offset(Port)`, matching `Out2_Follow_Out1_Frequency` in settings.
- **Program chains and dwell** — `SetChain`, `SetStep`, `SetDwell`,
  `OnDuration`, `RunDuration`, `SequenceRepeatCount`, `ChainRunDuration`,
  `ChainRepeatCount`.
- **Wobble** — frequency and amplitude, per `Settings_Frequency_Wobble_*`.
- **Biofeedback scan** — `:r11` / `:r12` read current and angle; the plain
  frequency sweep (no reads) is implemented as `frequencySweep()`.
- **MicroGen** as a device.

Per-output parameters, from the app's own `Status.csv` header:

```
Out1 Frequency, Out1 Waveform, Out1 Duty Cycle, Out 1 Amplitude,
Out1 Offset, Out1 Phase Angle   … and the same six for Out2
```

# @freqgen/spooky2

## 0.2.0

The Gen X Pro driver was checked against the display board's firmware, recovered
in [open-spooky2](https://github.com/Polobase/open-spooky2), and against serial
captures of the vendor software driving a real unit. That turned up three bugs,
several missing capabilities and a handful of wrong assumptions.

### Breaking

- **`uploadProgram()` no longer erases the device's program memory.** It used to
  end with `:w96=12321,` as a "commit"; that command erases slots 1–30 and every
  name, so the first upload after a power cycle wiped the program it had just
  stored. The command is now `eraseAllPrograms()`, and `commitOfflineMemory()`
  is gone.
- **`uploadProgram()` sends `:g` before `:p`.** The device holds the gate table
  in RAM and writes it to flash when the *next* `:p` arrives, so the old order
  attached every slot's gating to the following program.
- **`calibrate()` is gone**, replaced by `setGateTimes(channel, on, off)`.
  Registers 50/51 are the per-output gate times (`:w50=aaaaa,bbbbb,`), not
  calibration; register 71 does not exist in the firmware at all.
- **`setOutput()` addresses one output at a time** (`:w11=1,,` / `:w11=,1,`),
  as the vendor software does. It used to write both fields from cached state,
  switching the other output off.
- **`convertBiofeedback()` and `toBfbCsv()` default to Spooky2's scale** —
  raw counts ÷ 100 — so their values match Spooky2's display and its BFB CSV
  exactly. Pass `{ currentUaPerCount: 3.4, angleDegPerCount: 0.0015 }` for the
  device-spec scale.
- `uploadProgram()` and `writeOfflineSlot()` reject slots the device answers
  `:err` to (1–30 for programs, 0–30 for names), and a program name longer than
  59 characters, which the device's line parser would drop.

### Added

- Read the device back: `readProgram()`, `readProgramName()`, `readGateTable()`,
  `readDisplayRevision()`, plus `eraseProgram()`, `setBacklight()` and
  `resetPcDisplayState()`.
- `biofeedbackScan()` reproduces Spooky2's scan exactly: `stepPercent` for its
  geometric grid (0.025 % from 41 kHz is `41000 × 1.00025^k`), `startDelay` for
  the settling reads it discards, and driving Out 2 alongside Out 1 — synced,
  inverted, same amplitude — as its presets do.
- `runConformance()` and the `spooky2 conformance` command: check a unit against
  the recovered firmware behaviour, record a baseline and diff a second firmware
  against it. Covers every command that is safe to send; never erases program
  memory, writes calibration or resets the MCU.
- `decodeDmsLog()` and `loadCaptureExpectations()`: read Device Monitoring
  Studio `.dmslog8` captures, and turn them into expectations the conformance
  suite checks a device against.
- `GenXPro.resync()` and `readUnsolicited()` for the lines the display sends on
  its own.

### Fixed

- The handshake left the link one reply out of step. The display answers `:w92`
  with a `:w91=0,` of its own about 20 ms later, which became the next command's
  reply; `authenticate()` now drains it.

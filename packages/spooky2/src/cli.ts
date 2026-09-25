#!/usr/bin/env node
/**
 * `spooky2` command-line tool (Node-only).
 *
 *   spooky2 devices                        # supported drivers + verification status
 *   spooky2 list                           # serial ports
 *   spooky2 set --device xm --freq 727.5 --amp 20 --on
 *   spooky2 set --device xm --off
 *
 * None of these drivers is hardware-verified — `devices` says so per driver,
 * and `set` prints a warning before it writes anything.
 */

import { parseArgs, type ParseArgsConfig } from "node:util";
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { AwgError, DeviceRegistry, type ChannelStep } from "@freqgen/core";
import { NodeSerialTransport, listPorts, describeBridge } from "@freqgen/core/node";

import { SPOOKY2_DEVICES } from "./devices.js";
import { resolvePresetChain, presetToProgram } from "./presets.js";
import { runPresetRun } from "./run-preset.js";
import { detectHits, toBfbCsv, toBfbFrequenciesCsv } from "./biofeedback.js";
import { runConformance, compareReports, CONFORMANCE_GROUPS, type ConformanceReport, type ConformanceCase } from "./conformance.js";
import { loadCaptureExpectations } from "./capture.js";

const registry = new DeviceRegistry().registerAll(SPOOKY2_DEVICES);

const GLOBAL_OPTIONS: NonNullable<ParseArgsConfig["options"]> = {
  device: { type: "string", short: "d" },
  port: { type: "string", short: "p" },
  json: { type: "boolean" },
  debug: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

const COMMAND_OPTIONS: Record<string, NonNullable<ParseArgsConfig["options"]>> = {
  devices: {},
  list: {},
  set: {
    channel: { type: "string", default: "1" },
    waveform: { type: "string" },
    freq: { type: "string" },
    amp: { type: "string" },
    offset: { type: "string" },
    duty: { type: "string" },
    phase: { type: "string" },
    on: { type: "boolean" },
    off: { type: "boolean" },
  },
  "run-preset": {
    preset: { type: "string" },
    channels: { type: "string" },
    "sweep-steps": { type: "string" },
  },
  scan: {
    start: { type: "string", default: "1" },
    end: { type: "string", default: "101" },
    step: { type: "string", default: "0.25" },
    loops: { type: "string", default: "2" },
    amp: { type: "string", default: "10" },
    "max-hits": { type: "string", default: "60" },
    channel: { type: "string", default: "1" },
    out: { type: "string" },
    "program-file": { type: "string" },
    "program-name": { type: "string" },
    dwell: { type: "string" },
  },
  conformance: {
    captures: { type: "string" },
    record: { type: "string" },
    compare: { type: "string" },
    slot: { type: "string", default: "30" },
    groups: { type: "string" },
  },
};

const USAGE = `Usage: spooky2 <command> [options]

Commands:
  devices                    List supported drivers and their verification status
  list                       List serial ports
  set                        Apply channel settings
                             --device xm|genx|genx-pro  --channel 1|2
                             --waveform sine|square|... --freq <Hz> --amp <Vpp>
                             --offset <V> --duty <pct> --phase <deg>  --on | --off
  run-preset                 Run a Spooky2 preset file on a generator
                             --device xm|genx|genx-pro  --preset <file.txt>
                             --channels 1|2|1,2  --sweep-steps <n>
  scan                       Biofeedback scan + hit detection (Gen X Pro)
                             --device genx-pro --port <path> --start <Hz> --end <Hz>
                             --step <Hz> --loops <n> --amp <Vpp> --max-hits <n> --channel 1|2
                             --out <scan.csv>  --program-file <BFB_Frequencies.csv> --program-name <name>
  conformance                Check a Gen X Pro against the display firmware's documented
                             behaviour, to compare two firmwares (Gen X Pro only)
                             --port <path> --record <baseline.json> --compare <baseline.json>
                             --slot <1-30>  --captures <dir of .dmslog8 captures>
                             --groups link,registers,programs,parser,handshake,
                                      calibration,biofeedback,display
                             Never erases program memory, writes calibration or resets;
                             it borrows one slot and restores it.

Global options:
  -d, --device <id>          Driver to use (see \`spooky2 devices\`)
  -p, --port <path>          Serial port path
      --json                 Machine-readable output
      --debug                Log serial traffic
  -h, --help                 Show this help

No driver in this package has been verified against hardware. Confirm output
with a scope before relying on it.`;

export interface ParsedCli {
  command: string;
  values: Record<string, string | boolean | (string | boolean)[] | undefined>;
}

export function parseCliArgs(argv: string[]): ParsedCli {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    return { command: "help", values: {} };
  }
  const options = COMMAND_OPTIONS[command];
  if (!options) {
    throw new AwgError(`Unknown command "${command}" — run \`spooky2 --help\``);
  }
  const { values } = parseArgs({
    args: rest,
    options: { ...GLOBAL_OPTIONS, ...options },
    allowPositionals: false,
  });
  if (values["on"] && values["off"]) {
    throw new AwgError("--on and --off are mutually exclusive");
  }
  return { command, values };
}

function parseNumber(name: string, value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new AwgError(`--${name} must be a number, got ${value}`);
  return n;
}

function parseChannel(value: unknown): number {
  const n = Number(value ?? 1);
  if (n !== 1 && n !== 2) throw new AwgError(`--channel must be 1 or 2, got ${value}`);
  return n - 1;
}

function cmdDevices(json: boolean | undefined): void {
  const rows = registry.list();
  if (json) {
    console.log(JSON.stringify(rows.map(({ create: _, ...r }) => r), null, 2));
    return;
  }
  for (const d of rows) {
    const mark = d.verified === true ? "✅" : d.verified === "partial" ? "◐" : "⚠️";
    console.log(`${mark}  ${d.id.padEnd(10)} ${d.label}`);
    if (d.note) console.log(`    ${d.note}`);
  }
  console.log("\n⚠️  = implemented from protocol documentation, never verified on hardware.");
}

async function cmdList(json: boolean | undefined): Promise<void> {
  const ports = await listPorts();
  if (json) {
    console.log(JSON.stringify(ports, null, 2));
    return;
  }
  if (ports.length === 0) {
    console.log("No serial ports found.");
    return;
  }
  for (const p of ports) {
    const bridge = describeBridge(p);
    const tag = bridge ? `[${bridge.label}${bridge.dualPort ? ", dual-port" : ""}]` : "";
    console.log(`${bridge ? "*" : " "} ${p.path}  ${tag}`.trimEnd());
  }
  console.log("(* = a USB-serial bridge these generators are known to use)");
}

async function cmdSet(values: ParsedCli["values"]): Promise<void> {
  const deviceId = values["device"] ? String(values["device"]) : undefined;
  if (!deviceId) {
    throw new AwgError("--device is required — run `spooky2 devices` to see the options");
  }
  const path = values["port"] ? String(values["port"]) : undefined;
  if (!path) {
    throw new AwgError("--port is required — run `spooky2 list` to find it");
  }

  const step: ChannelStep = {};
  if (values["waveform"] !== undefined) {
    const raw = String(values["waveform"]);
    step.waveform = /^\d+$/.test(raw) ? Number(raw) : (raw as ChannelStep["waveform"]);
  }
  if (values["freq"] !== undefined) step.frequencyHz = parseNumber("freq", values["freq"]);
  if (values["amp"] !== undefined) step.amplitudeVpp = parseNumber("amp", values["amp"]);
  if (values["offset"] !== undefined) step.offsetV = parseNumber("offset", values["offset"]);
  if (values["duty"] !== undefined) step.dutyCyclePct = parseNumber("duty", values["duty"]);
  if (values["phase"] !== undefined) step.phaseDeg = parseNumber("phase", values["phase"]);
  if (values["on"]) step.output = true;
  if (values["off"]) step.output = false;
  if (Object.keys(step).length === 0) {
    throw new AwgError("set: nothing to do — pass at least one parameter");
  }

  const descriptor = registry.get(deviceId);
  if (descriptor && descriptor.verified !== true) {
    console.error(
      `⚠️  ${descriptor.label} is not hardware-verified — confirm output with a scope.`,
    );
  }

  const channel = parseChannel(values["channel"]);
  const device = registry.create(deviceId, new NodeSerialTransport(path), {
    debug: values["debug"] === true,
  });
  await device.open();
  try {
    await device.applyStep(channel, step);
    console.log(`Applied to ${descriptor?.label ?? deviceId} channel ${channel + 1}.`);
  } finally {
    await device.close();
  }
}

async function cmdRunPreset(values: ParsedCli["values"]): Promise<void> {
  const deviceId = values["device"] ? String(values["device"]) : undefined;
  if (!deviceId) {
    throw new AwgError("--device is required — run `spooky2 devices` to see the options");
  }
  const path = values["port"] ? String(values["port"]) : undefined;
  if (!path) {
    throw new AwgError("--port is required — run `spooky2 list` to find it");
  }
  const presetPath = values["preset"] ? String(values["preset"]) : undefined;
  if (!presetPath) throw new AwgError("--preset is required (path to a Spooky2 .txt preset)");

  // Resolve the Base_Preset chain: real presets are thin and inherit amplitude,
  // offset, the active waveform and the Out 2 factor from a shell they point at.
  // With no Base_Preset this is just a parse of the one file.
  const preset = resolvePresetChain(presetPath, (p) => readFileSync(p, "utf8"), {
    onWarn: (message) => console.error(`⚠️  ${message}`),
  });
  const channels = parseChannels(values["channels"]);
  const sweepSteps = values["sweep-steps"] !== undefined
    ? parseNumber("sweep-steps", values["sweep-steps"])
    : undefined;
  const run = presetToProgram(preset, {
    channels,
    ...(sweepSteps !== undefined ? { sweepSteps } : {}),
  });

  for (const warning of run.warnings) console.error(`⚠️  ${warning}`);

  const descriptor = registry.get(deviceId);
  if (descriptor && descriptor.verified !== true) {
    console.error(
      `⚠️  ${descriptor.label} is not hardware-verified — confirm output with a scope.`,
    );
  }

  const device = registry.create(deviceId, new NodeSerialTransport(path), {
    debug: values["debug"] === true,
  });
  await device.open();
  try {
    console.log(
      `Running "${run.name}" (${run.segments.length} segments) on ` +
        `${descriptor?.label ?? deviceId}…`,
    );
    await runPresetRun(device, run, {
      onSegment: (i, seg) =>
        console.log(
          `  ${i + 1}/${run.segments.length}: ${
            seg.type === "step"
              ? `${seg.frequencyHz.toFixed(3)} Hz for ${seg.dwellSeconds}s`
              : `sweep ${seg.startHz.toFixed(3)}→${seg.endHz.toFixed(3)} Hz`
          }`,
        ),
    });
    console.log("Done.");
  } finally {
    await device.close();
  }
}

function parseChannels(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  const raw = String(value).split(",").map((s) => s.trim());
  return raw.map((s) => {
    const n = Number(s);
    if (n !== 1 && n !== 2) throw new AwgError(`--channels must be 1, 2, or 1,2 — got ${value}`);
    return n - 1;
  });
}

async function cmdConformance(values: ParsedCli["values"]): Promise<void> {
  const path = values["port"] ? String(values["port"]) : undefined;
  if (!path) {
    throw new AwgError("--port is required — run `spooky2 list` to find it");
  }
  const deviceId = values["device"] ? String(values["device"]) : "genx-pro";
  if (deviceId !== "genx-pro") {
    throw new AwgError(`conformance is a Gen X Pro suite — --device ${deviceId} is not supported`);
  }
  const slot = parseNumber("slot", values["slot"]);
  const known = CONFORMANCE_GROUPS as readonly ConformanceCase["group"][];
  const groups = values["groups"]
    ? String(values["groups"])
        .split(",")
        .map((g) => g.trim() as ConformanceCase["group"])
    : undefined;
  for (const g of groups ?? []) {
    if (!known.includes(g)) throw new AwgError(`--groups: unknown group "${g}" — pick from ${known.join(", ")}`);
  }

  // Captures of the vendor software driving a real unit: the strongest
  // statement of what an answer should look like.
  let expectations: Awaited<ReturnType<typeof loadCaptureExpectations>>["expectations"] | undefined;
  if (values["captures"]) {
    const loaded = await loadCaptureExpectations(String(values["captures"]));
    expectations = loaded.expectations;
    if (!values["json"]) {
      console.log(
        `Expectations from ${loaded.files.length} capture(s) in ${values["captures"]}: ` +
          `${expectations.size} commands the real device answered.`,
      );
    }
  }

  const device = registry.create(deviceId, new NodeSerialTransport(path), {
    debug: values["debug"] === true,
  }) as import("./genx-pro.js").GenXPro;
  await device.open();

  let report: ConformanceReport;
  try {
    let group = "";
    report = await runConformance(device, {
      slot,
      ...(groups ? { groups } : {}),
      ...(expectations ? { expectations } : {}),
      onCase: (c) => {
        if (values["json"]) return;
        if (c.group !== group) {
          group = c.group;
          console.log(`\n${group}`);
        }
        const vendor = c.capture ? (c.capture.ok ? " ⟦capture ✔⟧" : " ⟦capture ✖⟧") : "";
        console.log(`  ${c.ok ? "✔" : "✖"} ${c.id.padEnd(26)} ${c.ok ? c.description : c.detail}${vendor}`);
      },
    });
  } finally {
    await device.close();
  }

  const failed = report.cases.filter((c) => !c.ok);
  let differences: ReturnType<typeof compareReports> = [];
  if (values["compare"]) {
    const baseline = JSON.parse(readFileSync(String(values["compare"]), "utf8")) as ConformanceReport;
    differences = compareReports(baseline, report);
  }

  if (values["json"]) {
    console.log(JSON.stringify({ report, differences }, null, 2));
  } else {
    const checked = report.cases.filter((c) => c.capture).length;
    console.log(
      `\n${report.cases.length - failed.length}/${report.cases.length} cases pass` +
        ` (firmware ${report.device.firmware ?? "?"}, display ${report.device.revision ?? "?"})` +
        (checked > 0 ? `, ${checked} also checked against the captures` : ""),
    );
    if (values["compare"]) {
      console.log(
        differences.length === 0
          ? `No differences from ${values["compare"]}.`
          : `\n${differences.length} difference(s) from ${values["compare"]}:`,
      );
      for (const d of differences) {
        console.log(`  ✖ ${d.id} — ${d.description}`);
        console.log(`      baseline: ${d.baseline ?? "(case absent)"}`);
        console.log(`      current:  ${d.current ?? "(case absent)"}`);
      }
    }
  }

  if (values["record"]) {
    writeFileSync(String(values["record"]), `${JSON.stringify(report, null, 2)}\n`);
    if (!values["json"]) console.log(`\nBaseline written to ${values["record"]}`);
  }

  if (failed.length > 0 || differences.length > 0) process.exitCode = 1;
}

async function cmdScan(values: ParsedCli["values"]): Promise<void> {
  const deviceId = values["device"] ? String(values["device"]) : undefined;
  if (!deviceId) {
    throw new AwgError("--device is required — run `spooky2 devices` to see the options");
  }
  const path = values["port"] ? String(values["port"]) : undefined;
  if (!path) {
    throw new AwgError("--port is required — run `spooky2 list` to find it");
  }

  const start = parseNumber("start", values["start"]);
  const end = parseNumber("end", values["end"]);
  const step = parseNumber("step", values["step"]);
  const loops = parseNumber("loops", values["loops"]);
  const amp = parseNumber("amp", values["amp"]);
  const maxHits = parseNumber("max-hits", values["max-hits"]);
  const channel = parseChannel(values["channel"]);

  const descriptor = registry.get(deviceId);
  if (descriptor && descriptor.verified !== true) {
    console.error(
      `⚠️  ${descriptor.label} is not hardware-verified — confirm output with a scope.`,
    );
  }

  const device = registry.create(deviceId, new NodeSerialTransport(path), {
    debug: values["debug"] === true,
  });
  await device.open();
  try {
    console.log(
      `Scanning ${start}→${end} Hz, step ${step}, ${loops} loops, baseline, ${amp} Vpp, Ch${channel + 1}…`,
    );
    const samples = await (device as import("./genx-pro.js").GenXPro).biofeedbackScan({
      startHz: start,
      endHz: end,
      stepHz: step,
      loops,
      baseline: true,
      amplitudeVpp: amp,
      channel,
    });

    const hits = detectHits(
      samples.map((s) => ({ hz: s.hz, value: s.current ?? 0 })),
      { window: 20, maxHits },
    );

    console.log(`Hit frequencies (${hits.length}):`);
    console.log(hits.map((h) => h.hz.toFixed(2)).join(", "));

    if (values["out"]) {
      writeFileSync(String(values["out"]), toBfbCsv(samples, { dateTime: bfbStamp(new Date()) }));
      console.log(`Scan CSV written to ${values["out"]}`);
    }

    if (values["program-file"]) {
      const row = toBfbFrequenciesCsv(hits.map((h) => h.hz), {
        name: values["program-name"] ? String(values["program-name"]) : undefined,
        dwellSeconds: values["dwell"] !== undefined ? parseNumber("dwell", values["dwell"]) : undefined,
      });
      appendFileSync(String(values["program-file"]), row);
      console.log(`Hit program appended to ${values["program-file"]}`);
    }
  } finally {
    await device.close();
  }
}

function bfbStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}_${p(d.getSeconds())}`;
}

export async function run(argv: string[]): Promise<void> {
  const { command, values } = parseCliArgs(argv);
  if (command === "help" || values["help"]) {
    console.log(USAGE);
    return;
  }
  const json = values["json"] as boolean | undefined;
  switch (command) {
    case "devices":
      return cmdDevices(json);
    case "list":
      return cmdList(json);
    case "set":
      return cmdSet(values);
    case "run-preset":
      return cmdRunPreset(values);
    case "scan":
      return cmdScan(values);
    case "conformance":
      return cmdConformance(values);
    default:
      throw new AwgError(`Unknown command "${command}"`);
  }
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  run(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof AwgError ? err.message : err);
    process.exitCode = 1;
  });
}

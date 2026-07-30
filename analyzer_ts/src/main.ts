/**
 * tsaot TypeScript analyzer driver (self-hosting port of analyzer/src/main.rs).
 * Usage:
 *   node dist/main.js <program.json> [emit]    -> print generated C to stdout
 *   node dist/main.js <program.json> devirt    -> print the devirted IR JSON
 *                                                  (differential target vs the
 *                                                  Rust `tsaot <ir> devirt`)
 *
 * Pipeline (mirrors analyzer/src/main.rs): devirt -> emit. The escape/sroa
 * passes are later phases. The Rust analyzer remains the differential oracle
 * (scripts/analyzer_difftest.sh).
 */
import * as fs from "fs";
import { Program } from "./ir";
import { emitProgram, UnportedError } from "./emit";
import { runDevirt } from "./devirt";
import { analyzeProgram } from "./interproc";
import { runSroa } from "./sroa";
import { emitProgramC } from "./emitc";

function loadProgram(pathArg: string): Program {
  return JSON.parse(fs.readFileSync(pathArg, "utf8")) as Program;
}

function runMode(prog: Program, mode: string): string {
  switch (mode) {
    case "emit":
      runDevirt(prog, true);
      return emitProgram(prog);
    case "devirt":
      runDevirt(prog, true);
      return JSON.stringify(prog);
    case "escape":
      runDevirt(prog, true);
      return JSON.stringify(analyzeProgram(prog)) + "\n";
    case "emitc": {
      runDevirt(prog, true);
      const res = analyzeProgram(prog);
      runSroa(prog, res);
      return emitProgramC(prog, res);
    }
    case "sroa": {
      runDevirt(prog, true);
      const res = analyzeProgram(prog);
      runSroa(prog, res);
      return JSON.stringify(prog);
    }
    default:
      throw new Error(`unknown/unsupported mode: ${mode}`);
  }
}

/**
 * Analyze many independent IR files in one warmed Node process.
 *
 * list.tsv lines are `<name>\t<program.json>`.  Each output is written as
 * `<outDir>/<name>.c` (or `.json` for non-emission modes), while stdout carries
 * a machine-readable status line.  Programs are parsed separately because all
 * analysis passes mutate their input IR.
 */
function batchMain(listPath: string, outDir: string, mode: string): void {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const lines = fs.readFileSync(listPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const suffix = mode === "emit" || mode === "emitc" ? ".c" : ".json";
  for (const line of lines) {
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const name = line.slice(0, tab);
    const pathArg = line.slice(tab + 1);
    try {
      const output = runMode(loadProgram(pathArg), mode);
      fs.writeFileSync(`${outDir}/${name}${suffix}`, output);
      process.stdout.write(`${name}\tOK\n`);
    } catch (e) {
      if (e instanceof UnportedError) {
        const message = e.message.replace(/[\r\n\t]+/g, " ");
        process.stdout.write(`${name}\tUNPORTED\t${message}\n`);
        continue;
      }
      const message = (e instanceof Error ? e.message : String(e))
        .replace(/[\r\n\t]+/g, " ");
      process.stdout.write(`${name}\tERROR\t${message}\n`);
    }
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === "--batch") {
    const listPath = argv[1];
    const outDir = argv[2];
    const mode = argv[3] ?? "emit";
    if (!listPath || !outDir) {
      console.error("usage: node main.js --batch <list.tsv> <outdir> [emit|devirt|escape|emitc|sroa]");
      process.exit(2);
    }
    batchMain(listPath, outDir, mode);
    return;
  }
  const pathArg = argv[0];
  if (!pathArg) {
    console.error("usage: node main.js <program.json> [emit|devirt|escape|emitc|sroa]");
    process.exit(2);
  }
  const mode = argv[1] ?? "emit";
  try {
    process.stdout.write(runMode(loadProgram(pathArg), mode));
  } catch (e) {
    if (e instanceof UnportedError) {
      // Distinguishable exit + machine-readable reason for the harness tally.
      if (mode === "emitc" && process.env.TSAOT_EMITC_PARTIAL) {
        process.stdout.write((e as any).partial ?? "");
      }
      process.stderr.write(`UNPORTED: ${e.message}\n`);
      process.exit(7);
    }
    if (e instanceof Error && e.message.startsWith("unknown/unsupported mode:")) {
      console.error(`${e.message} (supported: emit, devirt, escape, emitc, sroa)`);
      process.exit(2);
    }
    throw e;
  }
}

main();

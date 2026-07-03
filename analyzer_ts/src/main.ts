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

function main(): void {
  const argv = process.argv.slice(2);
  const pathArg = argv[0];
  if (!pathArg) {
    console.error("usage: node main.js <program.json> [emit|devirt|escape]");
    process.exit(2);
  }
  const mode = argv[1] ?? "emit";
  const src = fs.readFileSync(pathArg, "utf8");
  const prog = JSON.parse(src) as Program;
  switch (mode) {
    case "emit":
      try {
        runDevirt(prog, true);
        process.stdout.write(emitProgram(prog));
      } catch (e) {
        if (e instanceof UnportedError) {
          // Distinguishable exit + machine-readable reason for the harness tally.
          process.stderr.write(`UNPORTED: ${e.message}\n`);
          process.exit(7);
        }
        throw e;
      }
      break;
    case "devirt":
      runDevirt(prog, true);
      process.stdout.write(JSON.stringify(prog));
      break;
    case "escape":
      // Mirrors the Rust pipeline: devirt first, then the escape analysis.
      // Byte-comparable to `tsaot <ir> escape` (println adds the newline).
      runDevirt(prog, true);
      process.stdout.write(JSON.stringify(analyzeProgram(prog)) + "\n");
      break;
    case "emitc": {
      // Typed-emit port (Rust byte-parity target): full pipeline then emitc.
      // TSAOT_EMITC_PARTIAL=1 prints the built prefix on UNPORTED (for the
      // prefix-parity metric while the port is incomplete).
      runDevirt(prog, true);
      const res = analyzeProgram(prog);
      runSroa(prog, res);
      try {
        process.stdout.write(emitProgramC(prog, res));
      } catch (e) {
        if (e instanceof UnportedError) {
          if (process.env.TSAOT_EMITC_PARTIAL) process.stdout.write((e as any).partial ?? "");
          process.stderr.write(`UNPORTED: ${e.message}\n`);
          process.exit(7);
        }
        throw e;
      }
      break;
    }
    case "sroa": {
      // Mirrors the Rust pipeline (devirt -> escape -> sroa); the dump is
      // compared against `tsaot <ir> sroa` via scripts/_ir_norm_diff.cjs
      // (normalized: serde emits Option fields as null, we pass objects through).
      runDevirt(prog, true);
      const res = analyzeProgram(prog);
      runSroa(prog, res);
      process.stdout.write(JSON.stringify(prog));
      break;
    }
    default:
      console.error(`unknown/unsupported mode: ${mode} (supported: emit, devirt)`);
      process.exit(2);
  }
}

main();

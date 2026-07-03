/// <reference path="./host.d.ts" />
/**
 * Self-hosted TYPED analyzer driver: read the IR program JSON from STDIN, run
 * the full typed pipeline (devirt -> escape -> sroa -> emitc), print the
 * generated C to STDOUT. This is the typed counterpart of selfhost.ts (boxed):
 * garnet compiles this entry to a native binary; its output must stay
 * byte-identical to the Rust oracle (`tsaot <ir> emit`).
 *
 *   usage: tsan_typed < program.ir.json > out.c
 *
 * On an unported instruction the driver prints a single "UNPORTED: ..." line
 * (stdout) instead of C; the caller distinguishes by the prefix.
 */
import { Program } from "./ir";
import { UnportedError } from "./emit";
import { emitProgramC } from "./emitc";
import { runDevirt } from "./devirt";
import { analyzeProgram } from "./interproc";
import { runSroa } from "./sroa";

function main(): void {
  const src = __read_stdin();
  const prog = JSON.parse(src) as Program;
  try {
    runDevirt(prog, true);
    const res = analyzeProgram(prog);
    runSroa(prog, res);
    console.log(emitProgramC(prog, res));
  } catch (e) {
    if (e instanceof UnportedError) {
      console.log(`UNPORTED: ${(e as Error).message}`);
      return;
    }
    throw e;
  }
}

main();

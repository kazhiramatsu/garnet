/// <reference path="./host.d.ts" />
/**
 * Self-hosted analyzer driver: read the IR program JSON from STDIN, print the
 * generated C to STDOUT. This entry point is what garnet compiles to a native
 * binary (no Node APIs — stdin comes from the ts_read_stdin host primitive).
 * The node driver (main.ts) keeps fs/argv for the existing harnesses.
 *
 *   usage: tsan_native < program.ir.json > out.c
 *
 * On an unported instruction the driver prints a single "UNPORTED: ..." line
 * (stdout) instead of C; the caller distinguishes by the prefix.
 */
import { Program } from "./ir";
import { emitProgram, UnportedError } from "./emit";
import { runDevirt } from "./devirt";
import { analyzeProgram } from "./interproc";

function main(): void {
  const src = __read_stdin();
  const prog = JSON.parse(src) as Program;
  try {
    runDevirt(prog, true);
    // Mirrors the Rust pipeline (devirt -> escape -> emit). The boxed emitter
    // does not consume the escape result yet (stack allocation is a later
    // phase); running it keeps pipeline parity and exercises the analysis in
    // the self-hosted binary.
    analyzeProgram(prog);
    console.log(emitProgram(prog));
  } catch (e) {
    if (e instanceof UnportedError) {
      console.log(`UNPORTED: ${(e as Error).message}`);
      return;
    }
    throw e;
  }
}

main();

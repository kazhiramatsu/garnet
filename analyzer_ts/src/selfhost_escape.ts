/// <reference path="./host.d.ts" />
/**
 * Self-hosted ESCAPE-DUMP driver: read the IR program JSON from STDIN, run
 * devirt + the interprocedural escape analysis, print the EscapeResult JSON.
 * Compiled by garnet to a native binary; its output is byte-compared against
 * the Rust `tsaot <ir> escape` across the conformance corpus — verifying the
 * ANALYSIS ITSELF runs correctly under self-hosted compilation (the emit
 * driver runs it too, but never observes its result).
 */
import { Program } from "./ir";
import { runDevirt } from "./devirt";
import { analyzeProgram } from "./interproc";

function main(): void {
  const prog = JSON.parse(__read_stdin()) as Program;
  runDevirt(prog, true);
  console.log(JSON.stringify(analyzeProgram(prog)));
}

main();

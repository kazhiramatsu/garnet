// Default exports that are values and namespace re-exports: an anonymous `export default function`, an
// `export default <expression>` (an object, a call's result), `export * as ns from "m"` consumed as a named
// import and through a further namespace, and the same bindings reached from a closure after the module ran.
import makeGreeting from "./lib";
import config from "./lib_expr";
import { ns, label } from "./lib_ns";
import * as all from "./lib_ns";
function main(): void {
  const out: string[] = [];
  out.push(makeGreeting("zod"), String(makeGreeting.length));
  out.push(config.name + ":" + config.items.join("|") + ":" + config.compute(3));
  out.push(ns.helper(2) + " " + ns.VALUE + " " + Object.keys(ns).sort().join(","));
  out.push(label + " " + all.ns.helper(5) + " " + all.label);
  const later = (): string => makeGreeting("late") + config.compute(1) + ns.helper(0);
  out.push(later());
  console.log(out.join("\n"));
}
main();

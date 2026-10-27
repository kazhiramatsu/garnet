// The named exports of node:process (`import { env, emitWarning } from "node:process"`): the same objects and
// behavior as the properties of the default export (the warning is not emitted: its line carries the pid).
import process, { env, argv, platform, cwd, nextTick, emitWarning, hrtime, version, pid } from "node:process";
function main(): void {
  const out: string[] = [];
  out.push(String(env === process.env), String(argv === process.argv), String(platform === process.platform), String(cwd() === process.cwd()));
  out.push(String(typeof pid === "number" && pid === process.pid), String(version === process.version), String(hrtime().length));
  env.GARNET_PROBE = "set";
  out.push(String(process.env.GARNET_PROBE));
  let ticked = 0;
  nextTick(() => { ticked++; console.log("ticked " + ticked); });
  out.push(typeof emitWarning);   // the warning itself is not emitted: its line would carry this process's pid
  console.log(out.join("\n"));
}
main();

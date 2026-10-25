// node:child_process: spawnSync and execSync (status, stdout, stderr, input,
// env, cwd, a missing command, a non-zero exit), spawn and exec over the loop
// (stdout/stderr streams, stdin, the exit and close events, kill, ENOENT),
// the promise form of exec.
import { spawnSync, execSync, execFileSync, spawn, exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { Buffer } from "node:buffer";
type Coded = Error & { code?: string | number | null; status?: number | null; signal?: string | null; killed?: boolean; errno?: number; syscall?: string; path?: string; spawnargs?: string[]; stderr?: string | Buffer };
const sh = "/bin/sh";
async function main(): Promise<void> {
  const log: string[] = [];
  const r1 = spawnSync(sh, ["-c", "echo out; echo err 1>&2; exit 3"]);
  log.push("spawnSync " + r1.status + " " + r1.signal + " " + JSON.stringify(r1.stdout.toString()) + " " + JSON.stringify(r1.stderr.toString()) + " " + (typeof r1.pid) + " " + r1.output.length + " " + (r1.output[0] === null));
  const r2 = spawnSync("cat", [], { input: "fed to cat", encoding: "utf8" });
  log.push("input " + JSON.stringify(r2.stdout) + " " + r2.status);
  const r3 = spawnSync(sh, ["-c", "echo $GARNET_VAR; pwd"], { env: { PATH: process.env.PATH as string, GARNET_VAR: "value" }, cwd: "/", encoding: "utf8" });
  log.push("env " + JSON.stringify(r3.stdout));
  const r4 = spawnSync("definitely-not-a-command-xyz", ["a"]);
  log.push("missing " + (r4.error as Coded).code + " " + (r4.error as Coded).syscall + " " + (r4.error as Coded).path + " " + JSON.stringify((r4.error as Coded).spawnargs) + " " + r4.status + " " + (r4.error as Error).message);
  const r5 = spawnSync(sh, ["-c", "kill -TERM $$"]);
  log.push("signal " + r5.status + " " + r5.signal);
  const r6 = spawnSync("sleep", ["5"], { timeout: 100 });
  log.push("timeout " + (r6.error as Coded).code + " " + r6.signal + " " + r6.status);
  log.push("execSync " + JSON.stringify(execSync("echo hello", { encoding: "utf8" })) + " " + (execSync("printf x") instanceof Buffer));
  try { execSync("echo visible 1>&2; exit 2", { stdio: "pipe" }); } catch (e) { const err = e as Coded; log.push("execSync-fail " + err.status + " " + JSON.stringify(err.message) + " " + JSON.stringify(err.stderr!.toString())); }
  log.push("execFileSync " + JSON.stringify(execFileSync("echo", ["a", "b"], { encoding: "utf8" })));
  const child = spawn(sh, ["-c", "read x; echo got:$x; echo warn 1>&2; exit 4"]);
  const events: string[] = [];
  let out = "", err = "";
  child.on("spawn", () => events.push("spawn"));
  child.stdout!.on("data", (c: Buffer) => { out += c.toString(); });
  child.stderr!.on("data", (c: Buffer) => { err += c.toString(); });
  child.on("exit", (code, signal) => events.push("exit:" + code + ":" + signal));
  const closed = new Promise<void>((resolve) => child.on("close", (code, signal) => { events.push("close:" + code + ":" + signal); resolve(); }));
  child.stdin!.write("line\n");
  child.stdin!.end();
  await closed;
  log.push("spawn " + events.join(",") + " " + JSON.stringify(out) + " " + JSON.stringify(err) + " " + child.exitCode + " " + child.signalCode + " " + (typeof child.pid) + " " + child.killed);
  const sleeper = spawn("sleep", ["10"]);
  const sleeperClosed = new Promise<[number | null, string | null]>((resolve) => sleeper.on("close", (code, signal) => resolve([code, signal])));
  await new Promise<void>((resolve) => sleeper.on("spawn", resolve));
  log.push("kill " + sleeper.kill() + " " + sleeper.killed);
  const [kcode, ksignal] = await sleeperClosed;
  log.push("killed " + kcode + " " + ksignal + " " + sleeper.kill());
  const ghost = spawn("definitely-not-a-command-xyz", ["b"]);
  const ghostEvents: string[] = [];
  ghost.on("error", (e: Coded) => ghostEvents.push("error:" + e.code + ":" + e.syscall));
  await new Promise<void>((resolve) => ghost.on("close", (code) => { ghostEvents.push("close:" + code); resolve(); }));
  log.push("ghost " + ghostEvents.join(",") + " " + ghost.pid);
  const execResult = await new Promise<string>((resolve) => exec("echo via exec; echo e 1>&2", (error, stdout, stderr) => resolve([error, JSON.stringify(stdout), JSON.stringify(stderr)].join(" "))));
  log.push("exec " + execResult);
  const execFail = await new Promise<string>((resolve) => exec("echo bad 1>&2; exit 5", (error) => resolve(error === null ? "none" : [error.code, error.killed, error.signal, JSON.stringify(error.message), error.cmd].join(" "))));
  log.push("exec-fail " + execFail);
  const fileResult = await new Promise<string>((resolve) => execFile("echo", ["x", "y"], { encoding: "buffer" }, (error, stdout) => resolve((error === null) + " " + (stdout instanceof Buffer) + " " + JSON.stringify(stdout.toString()))));
  log.push("execFile " + fileResult);
  const execP = promisify<{ stdout: string; stderr: string }>(exec);
  const { stdout, stderr } = await execP("echo promised");
  log.push("promisified " + JSON.stringify(stdout) + " " + JSON.stringify(stderr));
  try { await execP("exit 7"); } catch (e) { log.push("promisified-fail " + (e as Coded).code); }
  const cwdChild = spawn("pwd", [], { cwd: "/" });
  let cwdOut = "";
  cwdChild.stdout!.setEncoding("utf8");
  cwdChild.stdout!.on("data", (c: string) => { cwdOut += c; });
  await new Promise<void>((resolve) => cwdChild.on("close", () => resolve()));
  log.push("cwd " + JSON.stringify(cwdOut));
  const inherit = spawnSync(sh, ["-c", "echo inherited"], { stdio: "inherit" });
  log.push("inherit " + inherit.status + " " + inherit.stdout + " " + inherit.output[1]);
  console.log(log.join("\n"));
}
main();

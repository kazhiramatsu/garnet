// process (the global and node:process) and node:os: the shapes and relations both runtimes share.
import os from "node:os";
import proc from "node:process";
import { join, resolve } from "node:path";
function main(): void {
  const out: string[] = [];
  out.push([proc === process, process.argv.length >= 2, process.argv[0] === process.execPath, typeof process.pid, process.ppid > 0, process.execArgv.length, typeof process.argv0].join("|"));
  out.push([process.cwd() === resolve("."), process.env.HOME === os.homedir(), typeof process.env.PATH, process.env.__GARNET_UNSET === undefined, process.platform === os.platform(), process.arch === os.arch(), process.version.startsWith("v"), typeof process.versions.node, process.release.name].join("|"));
  const t0 = process.hrtime();
  const d = process.hrtime(t0);
  out.push([t0.length, d[0] >= 0, d[1] >= 0 && d[1] < 1e9, process.uptime() >= 0, process.memoryUsage().rss > 0, process.cpuUsage().user >= 0, typeof process.umask()].join("|"));
  const before = process.cwd();
  process.chdir(os.tmpdir());
  const moved = process.cwd();
  process.chdir(before);
  out.push([moved === resolve(os.tmpdir()) || moved === join("/private", os.tmpdir()), process.cwd() === before].join("|"));
  let chdirError = "";
  try { process.chdir("/definitely/not/a/dir"); } catch (e) { chdirError = (e as { code: string }).code + ":" + (e as { syscall: string }).syscall; }
  out.push(chdirError);
  out.push([os.EOL === "\n", os.endianness(), os.cpus().length === os.availableParallelism(), os.cpus().length > 0, typeof os.tmpdir(), os.type() === "Darwin" || os.type() === "Linux", os.release().length > 0, os.hostname().length > 0].join("|"));
  out.push([os.totalmem() > os.freemem(), os.freemem() > 0, os.loadavg().length, os.uptime() > 0, os.userInfo().uid === process.getuid(), os.userInfo().username.length > 0, os.constants.signals.SIGTERM, os.constants.signals.SIGINT, os.constants.signals.SIGKILL, os.devNull].join("|"));
  out.push([typeof process.stdout.write, process.stdout.writable, typeof process.stderr.fd, process.stdout.fd].join("|"));
  process.stdout.write("direct write\n");
  process.on("exit", (code: number) => { console.log("exit:" + code + ":" + process.exitCode); });
  process.once("exit", () => { console.log("exit-once"); });
  process.exitCode = 3;
  console.log(out.join("\n"));
}
main();

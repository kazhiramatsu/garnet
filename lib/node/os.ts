// node:os over the host (runtime/node_host.c).
import { host } from "./host";

export const EOL = "\n";
export const devNull = "/dev/null";
export function platform(): string { return host.platform; }
export function arch(): string { return host.arch; }
export function type(): string { const u = host.uname(); return u === undefined ? "Unknown" : u[0]; }
export function release(): string { const u = host.uname(); return u === undefined ? "" : u[1]; }
export function version(): string { const u = host.uname(); return u === undefined ? "" : u[2]; }
export function machine(): string { const u = host.uname(); return u === undefined ? "" : u[3]; }
export function hostname(): string { return host.hostname(); }
export function homedir(): string { return host.homedir(); }
export function tmpdir(): string { return host.tmpdir(); }
export interface CpuInfo { model: string; speed: number; times: { user: number; nice: number; sys: number; idle: number; irq: number } }
export function cpus(): CpuInfo[] {
  const n = host.cpus();
  const out: CpuInfo[] = [];
  for (let i = 0; i < n; i++) out.push({ model: "", speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } });
  return out;
}
export function availableParallelism(): number { return host.cpus(); }
export function totalmem(): number { return host.totalmem(); }
export function freemem(): number { return host.freemem(); }
export function loadavg(): number[] { return host.loadavg(); }
export function uptime(): number { return host.uptime(); }
export interface UserInfo { username: string; uid: number; gid: number; shell: string | null; homedir: string }
export function userInfo(): UserInfo {
  const u = host.userInfo();
  return { username: u[0], uid: u[1], gid: u[2], shell: u[3] === "" ? null : u[3], homedir: u[4] };
}
export function endianness(): "LE" | "BE" { return "LE"; }
export function networkInterfaces(): { [name: string]: never[] } { return {}; }
export function getPriority(_pid?: number): number { return 0; }
export function setPriority(_pid?: number, _priority?: number): void {}

const darwin = host.platform === "darwin";
export const constants = {
  signals: {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6, SIGBUS: darwin ? 10 : 7,
    SIGFPE: 8, SIGKILL: 9, SIGUSR1: darwin ? 30 : 10, SIGSEGV: 11, SIGUSR2: darwin ? 31 : 12, SIGPIPE: 13,
    SIGALRM: 14, SIGTERM: 15, SIGCHLD: darwin ? 20 : 17, SIGCONT: darwin ? 19 : 18, SIGSTOP: darwin ? 17 : 19,
    SIGTSTP: darwin ? 18 : 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: darwin ? 16 : 23, SIGXCPU: 24, SIGXFSZ: 25,
    SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: darwin ? 23 : 29, SIGSYS: darwin ? 12 : 31,
  },
  errno: {
    EPERM: 1, ENOENT: 2, ESRCH: 3, EINTR: 4, EIO: 5, ENXIO: 6, E2BIG: 7, ENOEXEC: 8, EBADF: 9, ECHILD: 10,
    EAGAIN: darwin ? 35 : 11, ENOMEM: 12, EACCES: 13, EFAULT: 14, EBUSY: 16, EEXIST: 17, EXDEV: 18, ENODEV: 19,
    ENOTDIR: 20, EISDIR: 21, EINVAL: 22, ENFILE: 23, EMFILE: 24, ENOTTY: 25, EFBIG: 27, ENOSPC: 28, ESPIPE: 29,
    EROFS: 30, EMLINK: 31, EPIPE: 32, ENAMETOOLONG: darwin ? 63 : 36, ENOTEMPTY: darwin ? 66 : 39, ELOOP: darwin ? 62 : 40,
  },
  priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 },
};
const os = { EOL, devNull, platform, arch, type, release, version, machine, hostname, homedir, tmpdir, cpus, availableParallelism,
  totalmem, freemem, loadavg, uptime, userInfo, endianness, networkInterfaces, getPriority, setPriority, constants };
export default os;

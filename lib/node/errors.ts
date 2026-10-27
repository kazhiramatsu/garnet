// Node's error objects (docs/node_compat_design.md): a system error carries
// `code`, `errno`, `syscall` and the paths, with libuv's message; an argument
// error carries its `code` and Node's wording.
import { host } from "./host";
import { inspectValue } from "./internal/inspect";

const MESSAGES: { [code: string]: string } = {
  ENOENT: "no such file or directory", EACCES: "permission denied", EEXIST: "file already exists",
  EISDIR: "illegal operation on a directory", ENOTDIR: "not a directory", ENOTEMPTY: "directory not empty",
  EPERM: "operation not permitted", EAGAIN: "resource temporarily unavailable", ELOOP: "too many symbolic links encountered",
  EBADF: "bad file descriptor", EINVAL: "invalid argument", EMFILE: "too many open files", ENFILE: "file table overflow",
  ENOSPC: "no space left on device", EROFS: "read-only file system", EXDEV: "cross-device link not permitted",
  EBUSY: "resource busy or locked", ENAMETOOLONG: "name too long", EFBIG: "file too large", EPIPE: "broken pipe",
  ESRCH: "no such process", ECHILD: "no child processes", EINTR: "interrupted system call",
  ENOTSUP: "operation not supported on socket", ESPIPE: "invalid seek", ENXIO: "no such device or address",
  EIO: "i/o error", ENOMEM: "not enough memory", ETXTBSY: "text file is busy", EMLINK: "too many links",
  ENOTTY: "inappropriate ioctl for device", EDQUOT: "disk quota exceeded",
};

export interface ErrnoException extends Error { code: string; errno: number; syscall: string; path?: string; dest?: string }
/** The error a failed system call throws (`fs.readFileSync("missing")`): a plain Error
 *  carrying Node's properties, as Node's own. */
export function systemError(code: string, errno: number, syscall: string, path?: string, dest?: string): ErrnoException {
  let message = code + ": " + (MESSAGES[code] ?? "unknown error") + ", " + syscall;
  if (path !== undefined) message += " '" + path + "'";
  if (dest !== undefined) message += " -> '" + dest + "'";
  const e = new Error(message) as ErrnoException;
  e.errno = errno;
  e.code = code;
  e.syscall = syscall;
  if (path !== undefined) e.path = path;
  if (dest !== undefined) e.dest = dest;
  return e;
}
/** The error of the host's last failed call. */
export function lastError(syscall: string, path?: string, dest?: string): ErrnoException {
  return systemError(host.lastError(), host.lastErrno(), syscall, path, dest);
}
export function uvMessage(code: string): string { return MESSAGES[code] ?? "unknown error"; }

export type CodedError<E extends Error> = E & { code: string };
/** Node's coded errors are plain Error, TypeError and RangeError instances with a `code`. */
export function codedError(code: string, message: string): CodedError<Error> {
  const e = new Error(message) as CodedError<Error>; e.code = code; return e;
}
export function codedTypeError(code: string, message: string): CodedError<TypeError> {
  const e = new TypeError(message) as CodedError<TypeError>; e.code = code; return e;
}
export function codedRangeError(code: string, message: string): CodedError<RangeError> {
  const e = new RangeError(message) as CodedError<RangeError>; e.code = code; return e;
}
/** How Node describes a received value in an argument error. */
export function describeReceived(value: unknown): string {
  if (value == null) return "Received " + String(value);
  if (typeof value === "function") return "Received function " + (value as { name?: string }).name;
  if (typeof value === "object") {
    const ctor = (value as { constructor?: { name?: string } }).constructor;
    if (ctor && ctor.name) return "Received an instance of " + ctor.name;
    return "Received " + inspectValue(value);
  }
  let shown = typeof value === "string" ? "'" + value + "'" : String(value);
  if (shown.length > 28) shown = shown.slice(0, 25) + "...";
  return "Received type " + typeof value + " (" + shown + ")";
}
export function invalidArgType(name: string, expected: string, actual: unknown): CodedError<TypeError> {
  const what = name.includes(".") ? "property" : "argument";
  return codedTypeError("ERR_INVALID_ARG_TYPE", "The \"" + name + "\" " + what + " must be " + expected + ". " + describeReceived(actual));
}
export function invalidArgValue(name: string, actual: unknown, reason: string = "is invalid"): CodedError<TypeError> {
  return codedTypeError("ERR_INVALID_ARG_VALUE", "The argument '" + name + "' " + reason + ". Received " + inspectValue(actual));
}
export function outOfRange(name: string, range: string, actual: unknown): CodedError<RangeError> {
  return codedRangeError("ERR_OUT_OF_RANGE", "The value of \"" + name + "\" is out of range. It must be " + range + ". Received " + String(actual));
}
export function validateString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") throw invalidArgType(name, "of type string", value);
}
export function validateFunction(value: unknown, name: string): asserts value is (...args: unknown[]) => unknown {
  if (typeof value !== "function") throw invalidArgType(name, "of type function", value);
}
export function validateNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
}

/** Node's SystemError (`rmSync` of a directory without `recursive`, ERR_FS_EISDIR). */
export class SystemError extends Error {
  code: string;
  errno: number;
  syscall: string;
  path?: string;
  info: { code: string; message: string; path?: string; syscall: string; errno: number };
  constructor(code: string, errorCode: string, errno: number, syscall: string, detail: string, path?: string) {
    super(detail + ": " + syscall + " returned " + errorCode + " (" + uvMessage(errorCode) + ")" + (path !== undefined ? " " + path : ""));
    this.name = "SystemError";
    this.code = code;
    this.errno = errno;
    this.syscall = syscall;
    if (path !== undefined) this.path = path;
    // the optional field is present only when there is a path (a project's exactOptionalPropertyTypes)
    const info: { code: string; message: string; path?: string; syscall: string; errno: number } = { code: errorCode, message: uvMessage(errorCode), syscall, errno };
    if (path !== undefined) info.path = path;
    this.info = info;
  }
}

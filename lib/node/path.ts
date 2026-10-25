// node:path, the POSIX implementation: a port of Node's lib/path.js.
import { host } from "./host";
import { validateString } from "./errors";

const CHAR_DOT = 46;
const CHAR_FORWARD_SLASH = 47;

function cwd(): string { return host.cwd() ?? "/"; }

/** Resolves . and .. segments of a path without a root (the heart of normalize/resolve). */
function normalizeString(path: string, allowAboveRoot: boolean): string {
  let res = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (code === CHAR_FORWARD_SLASH) break;
    else code = CHAR_FORWARD_SLASH;
    if (code === CHAR_FORWARD_SLASH) {
      if (lastSlash === i - 1 || dots === 1) {
        // NOOP
      } else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 ||
            res.charCodeAt(res.length - 1) !== CHAR_DOT || res.charCodeAt(res.length - 2) !== CHAR_DOT) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf("/");
            if (lastSlashIndex === -1) { res = ""; lastSegmentLength = 0; }
            else { res = res.slice(0, lastSlashIndex); lastSegmentLength = res.length - 1 - res.lastIndexOf("/"); }
            lastSlash = i;
            dots = 0;
            continue;
          } else if (res.length !== 0) {
            res = "";
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) { res += res.length > 0 ? "/.." : ".."; lastSegmentLength = 2; }
      } else {
        if (res.length > 0) res += "/" + path.slice(lastSlash + 1, i);
        else res = path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === CHAR_DOT && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

export function resolve(...args: string[]): string {
  let resolvedPath = "";
  let resolvedAbsolute = false;
  for (let i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    const path = i >= 0 ? args[i] : cwd();
    validateString(path, "paths[" + i + "]");
    if (path.length === 0) continue;
    resolvedPath = path + "/" + resolvedPath;
    resolvedAbsolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  }
  resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute);
  if (resolvedAbsolute) return "/" + resolvedPath;
  return resolvedPath.length > 0 ? resolvedPath : ".";
}

export function normalize(path: string): string {
  validateString(path, "path");
  if (path.length === 0) return ".";
  const isAbs = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  const trailingSeparator = path.charCodeAt(path.length - 1) === CHAR_FORWARD_SLASH;
  path = normalizeString(path, !isAbs);
  if (path.length === 0) {
    if (isAbs) return "/";
    return trailingSeparator ? "./" : ".";
  }
  if (trailingSeparator) path += "/";
  return isAbs ? "/" + path : path;
}

export function isAbsolute(path: string): boolean {
  validateString(path, "path");
  return path.length > 0 && path.charCodeAt(0) === CHAR_FORWARD_SLASH;
}

export function join(...args: string[]): string {
  if (args.length === 0) return ".";
  let joined: string | undefined = undefined;
  for (let i = 0; i < args.length; ++i) {
    const arg = args[i];
    validateString(arg, "path");
    if (arg.length > 0) {
      if (joined === undefined) joined = arg;
      else joined += "/" + arg;
    }
  }
  if (joined === undefined) return ".";
  return normalize(joined);
}

export function relative(from: string, to: string): string {
  validateString(from, "from");
  validateString(to, "to");
  if (from === to) return "";
  from = resolve(from);
  to = resolve(to);
  if (from === to) return "";
  const fromStart = 1;
  const fromEnd = from.length;
  const fromLen = fromEnd - fromStart;
  const toStart = 1;
  const toLen = to.length - toStart;
  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1;
  let i = 0;
  for (; i < length; i++) {
    const fromCode = from.charCodeAt(fromStart + i);
    if (fromCode !== to.charCodeAt(toStart + i)) break;
    else if (fromCode === CHAR_FORWARD_SLASH) lastCommonSep = i;
  }
  if (i === length) {
    if (toLen > length) {
      if (to.charCodeAt(toStart + i) === CHAR_FORWARD_SLASH) return to.slice(toStart + i + 1);
      if (i === 0) return to.slice(toStart + i);
    } else if (fromLen > length) {
      if (from.charCodeAt(fromStart + i) === CHAR_FORWARD_SLASH) lastCommonSep = i;
      else if (i === 0) lastCommonSep = 0;
    }
  }
  let out = "";
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
    if (i === fromEnd || from.charCodeAt(i) === CHAR_FORWARD_SLASH) out += out.length === 0 ? ".." : "/..";
  }
  return out + to.slice(toStart + lastCommonSep);
}

export function toNamespacedPath(path: string): string { return path; }

export function dirname(path: string): string {
  validateString(path, "path");
  if (path.length === 0) return ".";
  const hasRoot = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) { end = i; break; }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? "/" : ".";
  if (hasRoot && end === 1) return "//";
  return path.slice(0, end);
}

export function basename(path: string, suffix?: string): string {
  if (suffix !== undefined) validateString(suffix, "suffix");
  validateString(path, "path");
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return "";
    let extIdx = suffix.length - 1;
    let firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i);
      if (code === CHAR_FORWARD_SLASH) {
        if (!matchedSlash) { start = i + 1; break; }
      } else {
        if (firstNonSlashEnd === -1) { matchedSlash = false; firstNonSlashEnd = i + 1; }
        if (extIdx >= 0) {
          if (code === suffix.charCodeAt(extIdx)) {
            if (--extIdx === -1) end = i;
          } else {
            extIdx = -1;
            end = firstNonSlashEnd;
          }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = path.length;
    return path.slice(start, end);
  }
  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) { start = i + 1; break; }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  if (end === -1) return "";
  return path.slice(start, end);
}

export function extname(path: string): string {
  validateString(path, "path");
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let preDotState = 0;
  for (let i = path.length - 1; i >= 0; --i) {
    const code = path.charCodeAt(i);
    if (code === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) { startPart = i + 1; break; }
      continue;
    }
    if (end === -1) { matchedSlash = false; end = i + 1; }
    if (code === CHAR_DOT) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (startDot === -1 || end === -1 || preDotState === 0 ||
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) return "";
  return path.slice(startDot, end);
}

export interface ParsedPath { root: string; dir: string; base: string; ext: string; name: string }
export interface FormatInputPathObject { root?: string; dir?: string; base?: string; ext?: string; name?: string }

function formatExt(ext: string | undefined): string {
  return ext ? (ext.charCodeAt(0) === CHAR_DOT ? "" : ".") + ext : "";
}
export function format(pathObject: FormatInputPathObject): string {
  if (pathObject === null || typeof pathObject !== "object") throw new TypeError("The \"pathObject\" argument must be of type object");
  const dir = pathObject.dir || pathObject.root;
  const base = pathObject.base || (pathObject.name || "") + formatExt(pathObject.ext);
  if (!dir) return base;
  return dir === pathObject.root ? dir + base : dir + "/" + base;
}

export function parse(path: string): ParsedPath {
  validateString(path, "path");
  const ret: ParsedPath = { root: "", dir: "", base: "", ext: "", name: "" };
  if (path.length === 0) return ret;
  const isAbs = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  let start: number;
  if (isAbs) { ret.root = "/"; start = 1; } else start = 0;
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let i = path.length - 1;
  let preDotState = 0;
  for (; i >= start; --i) {
    const code = path.charCodeAt(i);
    if (code === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) { startPart = i + 1; break; }
      continue;
    }
    if (end === -1) { matchedSlash = false; end = i + 1; }
    if (code === CHAR_DOT) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (end !== -1) {
    const s = startPart === 0 && isAbs ? 1 : startPart;
    if (startDot === -1 || preDotState === 0 ||
        (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
      ret.base = ret.name = path.slice(s, end);
    } else {
      ret.name = path.slice(s, startDot);
      ret.base = path.slice(s, end);
      ret.ext = path.slice(startDot, end);
    }
  }
  if (startPart > 0) ret.dir = path.slice(0, startPart - 1);
  else if (isAbs) ret.dir = "/";
  return ret;
}

export function matchesGlob(_path: string, _pattern: string): boolean {
  throw new Error("path.matchesGlob is not available in garnet");
}

export const sep = "/";
export const delimiter = ":";
const posixPath = { resolve, normalize, isAbsolute, join, relative, toNamespacedPath, dirname, basename, extname, format, parse, matchesGlob, sep, delimiter };
export const posix: typeof posixPath & { posix: typeof posixPath } = Object.assign(posixPath, { posix: posixPath });
export default posix;

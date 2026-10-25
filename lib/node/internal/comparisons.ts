// Deep equality as assert and util.isDeepStrictEqual define it (strict: Object.is on
// primitives, the same prototype; loose: == on primitives), over arrays, plain objects,
// Dates, RegExps, Errors, Maps, Sets and typed arrays, with cycles remembered.
function hasOwn(obj: object, key: string): boolean {
  for (const k of Object.keys(obj)) if (k === key) return true;
  return false;
}
function isView(v: unknown): v is ArrayLike<number> { return ArrayBuffer.isView(v); }   // garnet has no DataView
/** A regular expression, by its shape (the RegExp constructor is not a value in garnet). */
export function isRegExpValue(v: unknown): v is RegExp {
  if (typeof v !== "object" || v === null) return false;
  const r = v as { exec?: unknown; source?: unknown; flags?: unknown };
  return typeof r.exec === "function" && typeof r.source === "string" && typeof r.flags === "string";
}

export function isDeepEqual(a: unknown, b: unknown, strict: boolean, memo?: Map<object, object[]>): boolean {
  if (a === b) return a !== 0 || !strict || Object.is(a, b);
  const aObj = typeof a === "object" && a !== null;
  const bObj = typeof b === "object" && b !== null;
  if (!aObj || !bObj) {
    if (aObj !== bObj) return false;
    if (typeof a === "number" && typeof b === "number" && a !== a && b !== b) return true;
    return strict ? false : a == b; // eslint-disable-line eqeqeq
  }
  const x = a as object, y = b as object;
  if (strict && Object.getPrototypeOf(x) !== Object.getPrototypeOf(y)) return false;
  if (Array.isArray(x) !== Array.isArray(y)) return false;
  if (x instanceof Date || y instanceof Date) return x instanceof Date && y instanceof Date && x.getTime() === y.getTime();
  if (isRegExpValue(x) || isRegExpValue(y)) return isRegExpValue(x) && isRegExpValue(y) && x.source === y.source && x.flags === y.flags;
  if (x instanceof Error || y instanceof Error) {
    if (!(x instanceof Error && y instanceof Error) || x.name !== y.name || x.message !== y.message) return false;
  }
  if (isView(x) || isView(y)) {
    if (!(isView(x) && isView(y)) || x.length !== y.length) return false;
    if (strict && (x as object).constructor !== (y as object).constructor) return false;
    for (let i = 0; i < x.length; i++) {
      const p = x[i], q = y[i];
      if (strict ? !Object.is(p, q) : p != q) return false; // eslint-disable-line eqeqeq
    }
    return true;
  }
  if (memo === undefined) memo = new Map();
  const seen = memo.get(x);
  if (seen !== undefined) { for (const s of seen) if (s === y) return true; seen.push(y); } else memo.set(x, [y]);
  if (x instanceof Map || y instanceof Map) {
    if (!(x instanceof Map && y instanceof Map) || x.size !== y.size) return false;
    for (const [k, v] of x) {
      if (typeof k !== "object" || k === null) {
        if (!y.has(k) || !isDeepEqual(v, y.get(k), strict, memo)) return false;
      } else {
        let found = false;
        for (const [k2, v2] of y) if (isDeepEqual(k, k2, strict, memo) && isDeepEqual(v, v2, strict, memo)) { found = true; break; }
        if (!found) return false;
      }
    }
    return true;
  }
  if (x instanceof Set || y instanceof Set) {
    if (!(x instanceof Set && y instanceof Set) || x.size !== y.size) return false;
    for (const v of x) {
      if (typeof v !== "object" || v === null) { if (!y.has(v)) return false; }
      else {
        let found = false;
        for (const w of y) if (isDeepEqual(v, w, strict, memo)) { found = true; break; }
        if (!found) return false;
      }
    }
    return true;
  }
  const keysA = Object.keys(x), keysB = Object.keys(y);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) if (!hasOwn(y, k)) return false;
  if (Array.isArray(x) && (x as unknown[]).length !== (y as unknown[]).length) return false;
  const ax = x as { [key: string]: unknown }, by = y as { [key: string]: unknown };
  for (const k of keysA) if (!isDeepEqual(ax[k], by[k], strict, memo)) return false;
  return true;
}

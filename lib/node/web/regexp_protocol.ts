// RegExp's protocol as the specification writes it (docs/well_known_symbols_design.md): the methods at the
// well-known symbols, over `exec`, `flags` and `lastIndex` read from the object. A program compiles this
// module only when it can tell: it names one of those symbols, defines an `exec` or extends RegExp. Any other
// program takes the engine's direct paths in ts_regexp_adapter.c, which agree with this for an unmodified
// RegExp and do not run `exec` per match.

const regexpProto = RegExp.prototype as any;
const builtinExec = regexpProto.exec;
const iteratorProto = (globalThis as any).Iterator.prototype;

const isObject = (v: any): boolean => (typeof v === "object" && v !== null) || typeof v === "function";
const toStr = (v: any): string => `${v}`;
function thisObject(v: any, name: string): any {
  if (!isObject(v)) throw new TypeError(`Method RegExp.prototype.${name} called on incompatible receiver ${String(v)}`);
  return v;
}
function toIntegerOrInfinity(v: any): number {
  const n = +v;
  return n !== n ? 0 : Math.trunc(n);
}
function toLength(v: any): number {
  const n = toIntegerOrInfinity(v);
  return n <= 0 ? 0 : Math.min(n, 9007199254740991);
}
function advanceStringIndex(S: string, index: number, unicode: boolean): number {
  if (!unicode || index + 1 >= S.length) return index + 1;
  const first = S.charCodeAt(index);
  if (first < 0xd800 || first > 0xdbff) return index + 1;
  const second = S.charCodeAt(index + 1);
  return second < 0xdc00 || second > 0xdfff ? index + 1 : index + 2;
}
function regExpExec(R: any, S: string): any {
  const exec = R.exec;
  if (typeof exec === "function") {
    const result = exec.call(R, S);
    if (result !== null && !isObject(result)) throw new TypeError("RegExp exec method returned something other than an Object or null");
    return result;
  }
  return builtinExec.call(R, S);
}
function speciesConstructor(O: any, defaultConstructor: any): any {
  const C = O.constructor;
  if (C === undefined) return defaultConstructor;
  if (!isObject(C)) throw new TypeError("The constructor property is not an object");
  const S = C[Symbol.species];
  if (S === undefined || S === null) return defaultConstructor;
  if (typeof S !== "function") throw new TypeError("object.constructor[Symbol.species] is not a constructor");
  return S;
}
// The template's $ forms over one match
function getSubstitution(matched: string, str: string, position: number, captures: any[], namedCaptures: any, template: string): string {
  const m = captures.length;
  const tail = position + matched.length;
  let result = "";
  let i = 0;
  while (i < template.length) {
    const c = template[i];
    if (c !== "$" || i + 1 >= template.length) { result += c; i++; continue; }
    const next = template[i + 1];
    if (next === "$") { result += "$"; i += 2; continue; }
    if (next === "&") { result += matched; i += 2; continue; }
    if (next === "`") { result += str.substring(0, position); i += 2; continue; }
    if (next === "'") { if (tail < str.length) result += str.substring(tail); i += 2; continue; }
    if (next >= "0" && next <= "9") {
      let digits = 1;
      if (i + 2 < template.length && template[i + 2] >= "0" && template[i + 2] <= "9") {
        const two = (next.charCodeAt(0) - 48) * 10 + (template.charCodeAt(i + 2) - 48);
        if (two >= 1 && two <= m) digits = 2;
      }
      const index = digits === 2 ? (next.charCodeAt(0) - 48) * 10 + (template.charCodeAt(i + 2) - 48) : next.charCodeAt(0) - 48;
      if (index >= 1 && index <= m) {
        const capture = captures[index - 1];
        if (capture !== undefined) result += capture;
        i += 1 + digits;
        continue;
      }
      result += "$"; i++;
      continue;
    }
    if (next === "<" && namedCaptures !== undefined) {
      const close = template.indexOf(">", i + 2);
      if (close < 0) { result += "$"; i++; continue; }
      const capture = namedCaptures[template.substring(i + 2, close)];
      if (capture !== undefined) result += toStr(capture);
      i = close + 1;
      continue;
    }
    result += "$"; i++;
  }
  return result;
}

const iterState = new WeakMap<object, { R: any; S: string; global: boolean; fullUnicode: boolean; done: boolean }>();
const regExpStringIteratorProto = Object.create(iteratorProto);
const iteratorMethods = {
  next(this: any): any {
    const st = isObject(this) ? iterState.get(this) : undefined;
    if (st === undefined) throw new TypeError("next method called on incompatible receiver");
    if (st.done) return { value: undefined, done: true };
    const match = regExpExec(st.R, st.S);
    if (match === null) { st.done = true; return { value: undefined, done: true }; }
    if (!st.global) { st.done = true; return { value: match, done: false }; }
    if (toStr(match[0]) === "") st.R.lastIndex = advanceStringIndex(st.S, toLength(st.R.lastIndex), st.fullUnicode);
    return { value: match, done: false };
  },
};
Object.defineProperty(regExpStringIteratorProto, "next", { value: iteratorMethods.next, writable: true, enumerable: false, configurable: true });
Object.defineProperty(regExpStringIteratorProto, Symbol.toStringTag, { value: "RegExp String Iterator", writable: false, enumerable: false, configurable: true });

const methods = {
  test(this: any, S: any): boolean {
    const R = thisObject(this, "test");
    return regExpExec(R, toStr(S)) !== null;
  },
  [Symbol.match](this: any, string: any): any {
    const rx = thisObject(this, "@@match");
    const S = toStr(string);
    const flags = toStr(rx.flags);
    if (!flags.includes("g")) return regExpExec(rx, S);
    const fullUnicode = flags.includes("u") || flags.includes("v");
    rx.lastIndex = 0;
    const A: string[] = [];
    for (;;) {
      const result = regExpExec(rx, S);
      if (result === null) return A.length === 0 ? null : A;
      const matchStr = toStr(result[0]);
      A.push(matchStr);
      if (matchStr === "") rx.lastIndex = advanceStringIndex(S, toLength(rx.lastIndex), fullUnicode);
    }
  },
  [Symbol.matchAll](this: any, string: any): any {
    const R = thisObject(this, "@@matchAll");
    const S = toStr(string);
    const C = speciesConstructor(R, RegExp);
    const flags = toStr(R.flags);
    const matcher = new C(R, flags);
    matcher.lastIndex = toLength(R.lastIndex);
    const iterator = Object.create(regExpStringIteratorProto);
    iterState.set(iterator, { R: matcher, S, global: flags.includes("g"), fullUnicode: flags.includes("u") || flags.includes("v"), done: false });
    return iterator;
  },
  [Symbol.replace](this: any, string: any, replaceValue: any): string {
    const rx = thisObject(this, "@@replace");
    const S = toStr(string);
    const lengthS = S.length;
    const functionalReplace = typeof replaceValue === "function";
    if (!functionalReplace) replaceValue = toStr(replaceValue);
    const flags = toStr(rx.flags);
    const global = flags.includes("g");
    const fullUnicode = flags.includes("u") || flags.includes("v");
    if (global) rx.lastIndex = 0;
    const results: any[] = [];
    for (;;) {
      const result = regExpExec(rx, S);
      if (result === null) break;
      results.push(result);
      if (!global) break;
      if (toStr(result[0]) === "") rx.lastIndex = advanceStringIndex(S, toLength(rx.lastIndex), fullUnicode);
    }
    let accumulated = "";
    let nextSourcePosition = 0;
    for (const result of results) {
      const nCaptures = Math.max(toLength(result.length) - 1, 0);
      const matched = toStr(result[0]);
      const position = Math.max(Math.min(toIntegerOrInfinity(result.index), lengthS), 0);
      const captures: any[] = [];
      for (let n = 1; n <= nCaptures; n++) {
        const capN = result[n];
        captures.push(capN === undefined ? undefined : toStr(capN));
      }
      let namedCaptures = result.groups;
      let replacement: string;
      if (functionalReplace) {
        const args: any[] = [matched, ...captures, position, S];
        if (namedCaptures !== undefined) args.push(namedCaptures);
        replacement = toStr(replaceValue(...args));
      } else {
        if (namedCaptures !== undefined) namedCaptures = Object(namedCaptures);
        replacement = getSubstitution(matched, S, position, captures, namedCaptures, replaceValue);
      }
      if (position >= nextSourcePosition) {
        accumulated += S.substring(nextSourcePosition, position) + replacement;
        nextSourcePosition = position + matched.length;
      }
    }
    return nextSourcePosition >= lengthS ? accumulated : accumulated + S.substring(nextSourcePosition);
  },
  [Symbol.search](this: any, string: any): number {
    const rx = thisObject(this, "@@search");
    const S = toStr(string);
    const previousLastIndex = rx.lastIndex;
    if (!Object.is(previousLastIndex, 0)) rx.lastIndex = 0;
    const result = regExpExec(rx, S);
    const currentLastIndex = rx.lastIndex;
    if (!Object.is(currentLastIndex, previousLastIndex)) rx.lastIndex = previousLastIndex;
    return result === null ? -1 : result.index;
  },
  [Symbol.split](this: any, string: any, limit: any): string[] {
    const rx = thisObject(this, "@@split");
    const S = toStr(string);
    const C = speciesConstructor(rx, RegExp);
    const flags = toStr(rx.flags);
    const unicodeMatching = flags.includes("u") || flags.includes("v");
    const splitter = new C(rx, flags.includes("y") ? flags : flags + "y");
    const A: any[] = [];
    const lim = limit === undefined ? 4294967295 : limit >>> 0;
    if (lim === 0) return A;
    if (S.length === 0) {
      if (regExpExec(splitter, S) === null) A.push(S);
      return A;
    }
    const size = S.length;
    let p = 0;
    let q = 0;
    while (q < size) {
      splitter.lastIndex = q;
      const z = regExpExec(splitter, S);
      if (z === null) { q = advanceStringIndex(S, q, unicodeMatching); continue; }
      const e = Math.min(toLength(splitter.lastIndex), size);
      if (e === p) { q = advanceStringIndex(S, q, unicodeMatching); continue; }
      A.push(S.substring(p, q));
      if (A.length === lim) return A;
      p = e;
      const numberOfCaptures = Math.max(toLength(z.length) - 1, 0);
      for (let i = 1; i <= numberOfCaptures; i++) {
        A.push(z[i]);
        if (A.length === lim) return A;
      }
      q = p;
    }
    A.push(S.substring(p, size));
    return A;
  },
};
for (const key of Reflect.ownKeys(methods)) {
  Object.defineProperty(regexpProto, key, { value: (methods as any)[key], writable: true, enumerable: false, configurable: true });
}

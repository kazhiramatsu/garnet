// The clone of an instance is a plain object with its data, whatever the d.ts says (`T`): no direct call, no typed getter, no static instanceof.
class K { x = 1; m() { return this.x + 10; } get g() { return 2; } }
class Holder<T> { constructor(public v: T) {} }
function t(name: string, f: () => unknown) { try { console.log(name, f()); } catch (e: any) { console.log(name, "throws", e.name); } }
const cloneOf = <T,>(v: T): T => structuredClone(v);
function deep<T>(v: T): T { return cloneOf(v); }
class U { static copy<T>(v: T): T { return structuredClone(v); } copyAll<T>(v: T[]): T[] { return v.map((x) => U.copy(x)); } }
function all<T>(xs: T[]): T[] { return xs.map((x) => structuredClone(x)); }
t("arrow", () => cloneOf(new K()).m());
t("chain", () => deep(new K()).m());
t("static", () => U.copy(new K()).m());
t("map value", () => new U().copyAll([new K()])[0].m());
t("map arrow", () => all([new K()])[0].m());
function app<T>(f: (x: T) => T, v: T) { return f(v); }
t("as value", () => app(structuredClone, new K()).m());
t("tuple", () => { const c = structuredClone([new K(), 1] as [K, number]); return c[0].m(); });
t("record", () => { const r: Record<string, K> = { a: new K() }; return structuredClone(r).a.m(); });
t("holder", () => structuredClone(new Holder(new K())).v.m());
t("destructure", () => { const { a } = structuredClone({ a: new K() }); return a.m(); });
t("for of", () => { let s = 0; for (const k of structuredClone([new K()])) s += k.m(); return s; });
t("real instance", () => { const k = new K(); structuredClone(k); return [k.m(), k.g, k instanceof K, k.x]; });
function g<T>(): T[] { return []; }
type R = R[];
t("recursive", () => structuredClone([] as R).length);
function shadow() { function structuredClone(v: K) { return v; } return structuredClone(new K()).m(); }
t("shadow", shadow);

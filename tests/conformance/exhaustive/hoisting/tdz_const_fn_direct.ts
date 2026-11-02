// A module's dead-zone binding captured by a `const f = () => ...`: a direct call threads the module's record alone, and the
// binding lives in a cell of its own (hono's url.ts: a reject, "direct call cannot thread captured cell").
function run(s: string, f: (x: string) => string): string { return f(s); }
const tryD = (s: string): string => (s.indexOf("%") !== -1 ? run(s, dec) : s);
const viaArrow = (v: string): string => tryD(v.replace("+", " "));
export const exported = viaArrow;   // a mention before `dec`: reachable, so a dead-zone binding
class R {
  #p(k: string): string { return tryD(k); }
  all(keys: string[]): string { let r = ""; for (const k of keys) r += tryD(k); return r; }
  get(k: string): string { return this.#p(k); }
}
const held = tryD;
try { console.log(held("%41")); } catch (e) { console.log((e as Error).name, (e as Error).message); }
const dec = decodeURIComponent;
console.log(exported("a%20b"), new R().get("c%21"), new R().all(["%41", "b"]), tryD("plain"), held("%42"));
function outer(): string { const inner = (): string => tryD("%43"); return inner(); }
console.log(outer());

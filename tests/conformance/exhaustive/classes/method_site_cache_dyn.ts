// A dynamic method call whose receiver the program types as an interface or `any` (hono's
// `router.match` through `Router<T>`): the site caches the method of a class instance, a
// prototype method or the instance's own field holding a function. Instances of several classes
// at one site; a field reassigned per instance and replaced after the site cached it; a plain
// object literal and a Proxy at the same site; the prototype method replaced, then deleted; an
// own sidecar property shadowing the prototype method; a relinked instance; a field holding a
// non-function; a bound function in the field; a getter in the method position; a null receiver.
interface Matcher { match(p: string): string; }
class Trie implements Matcher { match(p: string): string { return "trie:" + p; } }
class Rx implements Matcher {
  n = 0;
  match: (p: string) => string = (p) => this.first(p);
  first(p: string): string { this.match = (q) => "rx2:" + q + ":" + this.n; this.n++; return "rx1:" + p; }
}
class Pat implements Matcher { match = (p: string): string => "pat:" + p; }
class Other { match(p: string): string { return "other:" + p; } }
class Num { match: any = 5; }
class G { get match(): (p: string) => string { return (p) => "getter:" + p; } }
// a subclass whose prototype redefines the base's method as a getter (TypeScript refuses the class
// syntax for it, so the accessor is installed at run time), at a base-typed site and a dynamic one
class Over extends Trie {}
Object.defineProperty(Over.prototype, "match", { get() { return (p: string) => "over:" + p; }, configurable: true });
// a method of the subclass against a property assigned to the base prototype: the closer wins
class Near extends Other { match(p: string): string { return "near:" + p; } }
function run(m: Matcher, p: string): string { return m.match(p); }
function runAny(m: any, p: string): string { return m.match(p); }
function runTrie(t: Trie, p: string): string { return t.match(p); }
function main() {
  const out: unknown[] = [];
  const t = new Trie(), r = new Rx(), q = new Pat();
  const items: Matcher[] = [t, r, q];
  for (let i = 0; i < 4; i++) for (const it of items) out.push(run(it, "a" + i), runAny(it, "b" + i));
  // a second instance: its own field holds a fresh closure (the cache is keyed by the class, the slot is read)
  const r2 = new Rx(); out.push(run(r2, "c"), run(r2, "d"), run(r, "e"));
  // the field replaced after the site cached it
  r.match = (p) => "rx3:" + p; out.push(run(r, "f"), runAny(r, "g"));
  // a plain object literal at the same site
  const lit: Matcher = { match: (p) => "lit:" + p }; out.push(run(lit, "h"), run(lit, "i"));
  // a Proxy at the site
  const px = new Proxy(new Trie(), { get(tg, k, rc) { return k === "match" ? (p: string) => "proxy:" + p : Reflect.get(tg, k, rc); } });
  out.push(run(px, "j"), run(px, "k"));
  // the subclass getter over the base method (the base-typed site caches Trie's method first)
  out.push(runTrie(new Trie(), "w0"), runTrie(new Over(), "w"), run(new Over(), "x"), runAny(new Over(), "y"));
  // a property assigned to the base prototype against the subclass's own method
  (Other.prototype as any).match = (p: string) => "otherP:" + p; out.push(run(new Near(), "z"), run(new Other(), "z2"), runAny(new Near(), "z3"));
  // a prototype method redefined as an accessor after the site cached it
  const pt = new Pat(); out.push(run(pt, "aa"));
  const tr = new Trie(); Object.setPrototypeOf(tr, Object.create(Trie.prototype)); out.push(run(tr, "ab"));
  Object.defineProperty(Near.prototype, "match", { get() { return (p: string) => "nearG:" + p; }, configurable: true });
  out.push(run(new Near(), "ac"), runAny(new Near(), "ad"));
  // the prototype method replaced after caching, then deleted
  (Trie.prototype as any).match = function (this: Trie, p: string) { return "trie2:" + p; };
  out.push(run(t, "l"), runAny(t, "l2"));
  delete (Trie.prototype as any).match;
  let threw = ""; try { run(t, "m"); } catch (e) { threw = (e as Error).constructor.name; } out.push(threw);
  // an own sidecar property shadows the prototype method of another class's instance
  const o = new Other(); out.push(run(o, "n0"));
  (o as any).match = (p: string) => "own:" + p; out.push(run(o, "n"), runAny(o, "o"));
  // a relinked instance: the new chain's method
  const t2 = new Trie(); Object.setPrototypeOf(t2, Other.prototype); out.push(run(t2, "p"), run(new Other(), "p2"));
  // a field holding a non-function at the site: a TypeError
  const nm = new Num(); let threw2 = ""; try { runAny(nm, "q"); } catch (e) { threw2 = (e as Error).constructor.name; } out.push(threw2);
  // a bound function in the field
  const b = new Pat(); b.match = function (this: { tag: string }, p: string) { return this.tag + p; }.bind({ tag: "bound:" }); out.push(run(b, "r"), run(b, "s"));
  // a getter in the method position
  out.push(run(new G(), "t"), run(new G(), "u"));
  // a null receiver
  let threw3 = ""; try { run(null as any, "v"); } catch (e) { threw3 = (e as Error).constructor.name; } out.push(threw3);
  console.log(JSON.stringify(out));
}
main();

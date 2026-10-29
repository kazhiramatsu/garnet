// A dynamic method call site's known callees: the functions the program stores under the method's
// field key (a closure, a function declaration's value through a field initializer) and the
// classes' methods of that name, guessed at the site and verified by the function cell's code
// pointer. One site over: a class whose field holds the module function and then reassigns itself
// a closure (hono's RegExpRouter), classes with prototype methods of that name, an object literal
// with a closure, a bound function, a replaced prototype method, a Proxy, a method value moved
// onto a plain object and called with it as `this`, a non-function in the slot, a getter, and
// a receiver with no such method (TypeError); bound functions of a candidate with and without
// partial arguments, and the module function bound to a plain object (the direct entry's this).
interface Matcher { match(p: string): string }
function match(this: any, p: string): string {
  const table: Record<string, number> = { a: 1, b: 2 };
  const m = (q: string): string => "closure:" + q + ":" + table[q];
  this.match = m;
  return "first:" + m(p);
}
class Rx implements Matcher { match: typeof match = match; }
class Trie implements Matcher { v = 10; match(p: string): string { return "trie:" + p + ":" + this.v; } }
class Pat implements Matcher { match(p: string): string { return "pat:" + p; } }
class Smart implements Matcher { inner: Matcher = new Rx(); match(p: string): string { const r = this.inner.match(p); this.match = this.inner.match.bind(this.inner); return "smart:" + r; } }
class G { get match(): (p: string) => string { return (p) => "getter:" + p; } }
function run(x: Matcher, p: string): string { return x.match(p); }
function runAny(x: any, p: string): string { return x.match(p); }
function main() {
  const out: unknown[] = [];
  const r = new Rx(), t = new Trie(), pa = new Pat(), sm = new Smart();
  for (let i = 0; i < 3; i++) out.push(run(r, "a"), run(t, "b"), run(pa, "c"), run(sm, "d"), runAny(r, "b"), runAny(t, "a"));
  // a second instance of the class takes the module function first, then its own closure
  const r2 = new Rx(); out.push(run(r2, "b"), run(r2, "a"), run(r, "a"));
  // an object literal's closure, a bound function and a plain function in the slot
  const lit: Matcher = { match: (p) => "lit:" + p }; out.push(run(lit, "e"), runAny(lit, "e2"));
  const b: Matcher = { match: (function (this: { tag: string }, p: string) { return this.tag + p; }).bind({ tag: "bound:" }) };
  out.push(run(b, "f"), run(b, "f2"));
  // a bound candidate with a partial argument (no unwrapping), and the module function bound to a plain object
  const bp: Matcher = { match: lit.match.bind(null, "pre") }; out.push(run(bp, "ignored"), runAny(bp, "ignored2"));
  const tgt: any = { tag: "t" }; const bm: Matcher = { match: match.bind(tgt) };
  out.push(run(bm, "a"), run(bm, "b"), typeof tgt.match, tgt.match("b"));
  // a method value moved onto a plain object and called with it as this (Trie's reads this.v)
  const plain: any = { v: 77, match: Pat.prototype.match }; out.push(runAny(plain, "h"));
  const plain0: any = { v: 79, match: Trie.prototype.match }; out.push(runAny(plain0, "h0"));
  const plain2: any = { v: 78, match: (Trie.prototype as any).match }; out.push(runAny(plain2, "h2"));   // Pat's by now
  // the prototype method replaced by another class's method: that one's guard answers with a Trie as this
  (Trie.prototype as any).match = Pat.prototype.match;
  out.push(run(t, "g"), run(new Trie(), "g2"));
  // a Proxy
  const px = new Proxy(new Pat(), { get(tg, k, rc) { return k === "match" ? (p: string) => "proxy:" + p : Reflect.get(tg, k, rc); } });
  out.push(run(px, "i"));
  // a non-function and a missing method
  let threw = ""; try { runAny({ match: 5 }, "j"); } catch (e) { threw = (e as Error).constructor.name; } out.push(threw);
  let threw2 = ""; try { runAny({}, "k"); } catch (e) { threw2 = (e as Error).constructor.name; } out.push(threw2);
  // a getter in the method position, and the smart router after its rebinding
  out.push(run(new G(), "l"), run(sm, "m"), run(sm, "n"));
  console.log(JSON.stringify(out));
}
main();

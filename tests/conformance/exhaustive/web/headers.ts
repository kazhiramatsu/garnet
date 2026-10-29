// The Headers class (docs/web_fetch_api_design.md): construction from a record, pairs, another
// Headers, nothing; name normalization and validation; value stripping and validation; append
// joining, set, delete, has, get; set-cookie kept apart (getSetCookie); the sorted, combined
// iteration (entries, keys, values, forEach, for..of, spread); the iterator of a prototype
// method borrowed; the errors as TypeErrors; the object's tag.
function names(e: unknown): string { return (e as Error).constructor.name; }
function main() {
  const out: unknown[] = [];
  const h = new Headers({ "Content-Type": "text/plain", "X-A": " a ", "x-b": "b" });
  out.push(h.get("content-type"), h.get("X-A"), h.has("X-B"), h.has("x-c"), h.get("x-c"));
  h.append("x-a", "a2"); h.append("Accept", "text/html"); h.append("accept", "*/*");
  out.push(h.get("x-a"), h.get("ACCEPT"));
  h.set("x-a", "only"); h.delete("X-B");
  out.push(h.get("x-a"), h.has("x-b"), [...h.keys()], [...h.values()], Array.from(h), [...h.entries()].length);
  const seen: string[] = []; h.forEach(function (this: { tag: string }, v, k, parent) { seen.push(this.tag + k + "=" + v + (parent === h)); }, { tag: "t:" }); out.push(seen);
  // set-cookie: separate entries in iteration and getSetCookie, joined by get
  const c = new Headers([["Set-Cookie", "a=1"], ["set-cookie", "b=2; Path=/"], ["x", "y"]]);
  out.push(c.getSetCookie(), c.get("set-cookie"), [...c], [...c.keys()]);
  const copy = new Headers(c); copy.append("Set-Cookie", "c=3"); out.push(copy.getSetCookie(), c.getSetCookie().length);
  // empty and nothing
  out.push([...new Headers()].length, [...new Headers(undefined)].length);
  try { new Headers(null as any); out.push("ok"); } catch (e) { out.push(names(e)); }
  // iterable inits: a Map, a generator
  const m = new Map([["k1", "v1"], ["K2", "v2"]]); out.push([...new Headers(m as any)]);
  function* gen(): Generator<[string, string]> { yield ["g", "1"]; yield ["g", "2"]; }
  out.push([...new Headers(gen() as any)]);
  // invalid names and values
  for (const bad of ["x y", "", "a\nb", "ü"]) { try { new Headers({ [bad]: "v" }); out.push("ok:" + bad); } catch (e) { out.push(names(e)); } }
  for (const bad of ["a\nb", "a\rb", "a\0b"]) { try { h.set("x-v", bad); out.push("ok"); } catch (e) { out.push(names(e)); } }
  h.set("x-ws", "\t v \t"); out.push(JSON.stringify(h.get("x-ws")));
  try { new Headers([["a"]] as any); out.push("ok"); } catch (e) { out.push(names(e)); }
  try { new Headers([["a", "b", "c"]] as any); out.push("ok"); } catch (e) { out.push(names(e)); }
  try { new Headers(5 as any); out.push("ok"); } catch (e) { out.push(names(e)); }
  // numbers and booleans as values are stringified; a non-string name too
  const n = new Headers(); n.append("x-n", 5 as any); n.set(7 as any, true as any); out.push(n.get("x-n"), n.get("7"));
  // the response of Response.error() has immutable headers
  const er = Response.error(); try { er.headers.set("a", "b"); out.push("ok"); } catch (e) { out.push(names(e)); }
  out.push(Object.prototype.toString.call(h), h instanceof Headers, typeof h.entries, typeof h[Symbol.iterator]);
  // the prototype's method borrowed
  const get = Headers.prototype.get; out.push(get.call(h, "x-a"));
  console.log(JSON.stringify(out));
}
main();

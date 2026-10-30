// The String wrapper object, `new String(v)` (docs/web_fetch_api_design.md): typeof, instanceof,
// toString / valueOf, template literals and concatenation, String(), loose equality with the
// primitive, properties added to it (hono's HtmlEscapedString marks `isEscaped`), length and the
// delegating methods, JSON.stringify, a wrapper in a Response body; a wrapper and a primitive typed
// by the String interface (length, for..of).
async function main() {
  const out: unknown[] = [];
  const s: any = new String("hello");
  out.push(typeof s, s instanceof String, s instanceof Object, s.toString(), s.valueOf(), `${s}!`, s + " world", "x" + s, String(s), s == "hello", s === "hello", s.length);
  s.isEscaped = true; s.callbacks = [1]; out.push(s.isEscaped, s.callbacks.length, s.toUpperCase(), s.charAt(1), s.indexOf("l"), s.slice(1, 3), s.includes("ell"), [...s].length);
  const e: any = new String(); const n: any = new String(42); out.push(e.toString() === "", e.length, n.valueOf(), n + 1, JSON.stringify(s), JSON.stringify({ s }), JSON.stringify([n, e]));
  // typed by the wrapper interface: a wrapper or a primitive behind `String` (its length was read as
  // a primitive string's, 1152 for "abc"; for..of took the primitive string's walk)
  const w = new String("abc"); const pv: String = "xy";
  function len(v: String): number { return v.length; }
  const cs: string[] = []; for (const c of w) cs.push(c); for (const c of pv) cs.push(c);
  const ow: String | undefined = out.length > 0 ? new String("opt") : undefined;
  out.push(w.length, pv.length, len(w), len(pv), len(new String("hello")), w.length + 1, cs.join("|"), ow?.length, w.toUpperCase().length);
  const r = new Response(s); out.push(await r.text(), r.headers.get("content-type"));
  function raw(v: unknown): any { const w: any = new String(v); w.isEscaped = true; return w; }
  const parts: unknown[] = ["<a>", raw("<b>"), 3]; out.push(parts.map((p) => typeof p === "object" && (p as any).isEscaped ? String(p) : String(p)).join("|"));
  console.log(JSON.stringify(out));
}
main();

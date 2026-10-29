// FormData with text fields (docs/web_fetch_api_design.md): append, set (replacing the first
// entry and dropping the rest), get, getAll, has, delete, the iteration in insertion order,
// forEach, a FormData as a Response body (multipart with a boundary) and read back.
async function main() {
  const out: unknown[] = [];
  const f = new FormData();
  f.append("a", "1"); f.append("b", "2"); f.append("a", "3"); f.append("n", 4 as any);
  out.push(f.get("a"), f.getAll("a"), f.get("n"), f.has("b"), f.has("z"), f.get("z"), [...f.keys()], [...f.values()], [...f].length);
  f.set("a", "x"); out.push(f.getAll("a"), [...f.keys()]);
  f.set("c", "new"); f.delete("b"); out.push([...f.entries()]);
  const seen: string[] = []; f.forEach((v, k) => seen.push(k + "=" + v)); out.push(seen);
  const r = new Response(f); const ct = r.headers.get("content-type") ?? "";
  out.push(ct.startsWith("multipart/form-data; boundary="));
  const text = await r.text(); const boundary = ct.slice("multipart/form-data; boundary=".length);
  out.push(text.split("--" + boundary).length, text.includes('name="a"'), text.includes("\r\n\r\nx\r\n"), text.endsWith("--" + boundary + "--\r\n"));
  const back = await new Response(f).formData(); out.push([...back]);
  out.push(Object.prototype.toString.call(f), f instanceof FormData);
  console.log(JSON.stringify(out));
}
main();

// Blob and File (lib/node/web/blob.ts, docs/web_streams_design.md): parts of every kind, size and
// type, text / arrayBuffer / bytes / slice / stream, a File's name and lastModified, a Blob as a body
// (its type the content-type), `blob()` of a body, FormData with files (append with a filename, a
// multipart body with a file part parsed back to a File), and the errors. Node's own are the oracle.
const enc = new TextEncoder();
const name = (e: unknown): string => `${(e as Error).name}: ${(e as Error).message}`;
async function main(): Promise<void> {
  const b = new Blob(["ab", new Uint8Array([99]), new Uint8Array([100, 101]).buffer, new Blob(["f"])], { type: "Text/Plain" });
  console.log(b.size, b.type, await b.text(), (await b.arrayBuffer()).byteLength, Array.from(await b.bytes()), String(b), b instanceof Blob);
  console.log(await b.slice(1, 4).text(), b.slice(-2).size, b.slice(2).type, b.slice(0, 2, "X/Y").type, new Blob().size, new Blob([], { type: "aé" }).type, new Blob(["x"]).type);
  const chunks: number[] = [];
  const reader = b.stream().getReader();
  for (;;) { const r = await reader.read(); if (r.done) break; chunks.push((r.value as Uint8Array).length); }
  console.log(chunks);
  try { new Blob("abc" as unknown as string[]); } catch (e) { console.log("string parts:", (e as Error).name); }
  const f = new File(["hello"], "h.txt", { type: "text/plain", lastModified: 1700000000000 });
  console.log(f.name, f.size, f.type, f.lastModified, f instanceof Blob, f instanceof File, String(f), typeof new File([], "x").lastModified, await f.text());
  const res = new Response(b);
  console.log(res.headers.get("content-type"), await res.text());
  const res2 = new Response("payload", { headers: { "content-type": "Application/JSON" } });
  const got = await res2.blob();
  console.log(got.size, got.type, await got.text(), res2.bodyUsed, (await new Response(null).blob()).size);
  const form = new FormData();
  form.append("text", "value");
  form.append("blob", new Blob(["bb"], { type: "text/plain" }));
  form.append("named", new Blob(["nn"]), "n.bin");
  form.append("file", f);
  form.append("renamed", f, "other.txt");
  const kinds: string[] = [];
  for (const [k, v] of form) kinds.push(`${k}=${typeof v === "string" ? v : `File(${v.name},${v.type},${v.size})`}`);
  console.log(kinds.join(" "), form.get("text"), (form.get("file") as File).name, form.getAll("file").length);
  const req = new Request("http://localhost/up", { method: "POST", body: form });
  console.log(req.headers.get("content-type")!.startsWith("multipart/form-data; boundary="));
  const back = await req.formData();
  const backKinds: string[] = [];
  for (const [k, v] of back) backKinds.push(`${k}=${typeof v === "string" ? v : `File(${v.name},${v.type},${v.size},${await v.text()})`}`);
  console.log(backKinds.join(" "));
  const boundary = "----survey";
  const mp = `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nhello\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nfile body\r\n--${boundary}\r\nContent-Disposition: form-data; name="bin"; filename="b.bin"\r\n\r\nÿþ\r\n--${boundary}--\r\n`;
  const parsed = await new Response(mp, { headers: { "content-type": "multipart/form-data; boundary=" + boundary } }).formData();
  const file = parsed.get("file") as File;
  const bin = parsed.get("bin") as File;
  console.log(parsed.get("text"), file instanceof File, file.name, file.type, file.size, await file.text(), bin.name, bin.type, bin.size, Array.from(await bin.bytes()));
  const blobReq = new Request("http://localhost/", { method: "POST", body: new Blob(["raw"], { type: "x/y" }) });
  console.log(blobReq.headers.get("content-type"), await blobReq.text());
}
main();

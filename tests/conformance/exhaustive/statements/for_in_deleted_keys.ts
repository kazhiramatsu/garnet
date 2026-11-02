// for..in does not visit a key that has gone before the walk reached it, nor one that stopped being enumerable; keys added
// during the walk are not visited. Every kind of receiver gave the snapshot's keys, silently.
const t = (name: string, f: () => unknown) => {
  try { console.log(name, f()); } catch (e) { console.log(name, "threw", (e as Error).name); }
};
function walk(o: any, body: (k: string) => void): string[] {
  const seen: string[] = [];
  for (const k in o) { seen.push(k); body(k); }
  return seen;
}
t("array", () => { const b = [1, 2, 3]; return walk(b, () => { delete b[1]; }); });
t("array length", () => { const b = [1, 2, 3]; return walk(b, () => { b.length = 1; }); });
t("array pop", () => { const b = [1, 2, 3]; return walk(b, () => { b.pop(); }); });
t("array shift", () => { const b = [1, 2, 3]; return walk(b, () => { b.shift(); }); });
t("array named", () => { const b: any = [1]; b.x = 1; b.y = 2; return walk(b, () => { delete b.y; }); });
t("sparse", () => { const b: any = []; b[900000] = 1; b[5000] = 2; b[700000] = 3; return walk(b, () => { delete b[700000]; }); });
t("object", () => { const o: any = { a: 1, b: 2, c: 3 }; return walk(o, () => { delete o.b; }); });
t("object added", () => { const o: any = { a: 1, b: 2 }; return walk(o, () => { o.z = 1; }); });
t("object cleared", () => { const o: any = { a: 1, b: 2, c: 3 }; return walk(o, (k) => { delete o[k]; }); });
t("object all at once", () => { const o: any = { a: 1, b: 2, c: 3 }; return walk(o, () => { delete o.a; delete o.b; delete o.c; }); });
t("readded", () => { const o: any = { a: 1, b: 2, c: 3 }; return walk(o, (k) => { if (k === "a") { delete o.b; o.b = 5; } }); });
t("hidden", () => { const o: any = { a: 1, b: 2, c: 3 }; return walk(o, (k) => { if (k === "a") Object.defineProperty(o, "c", { enumerable: false }); }); });
t("dictionary", () => { const o: any = {}; for (let i = 0; i < 200; i++) o["k" + i] = i; return walk(o, (k) => { if (k === "k0") { for (let i = 1; i < 199; i++) delete o["k" + i]; } }); });
t("class", () => { class C { x = 1; y = 2; z = 3; } const o: any = new C(); return walk(o, () => { delete o.y; }); });
t("prototype", () => { const p: any = { q: 1, r: 2 }; const o: any = Object.create(p); o.a = 1; return walk(o, () => { delete p.r; }); });
t("shadowed", () => { const p: any = { a: 1, b: 2 }; const o: any = Object.create(p); o.a = 1; return walk(o, () => { }); });
t("delete uncovers", () => { const p: any = { a: 1, b: 2 }; const o: any = Object.create(p); o.b = 1; return walk(o, () => { delete o.b; }); });
t("relinked", () => { const o: any = Object.create({ q: 1, r: 2 }); o.a = 1; return walk(o, () => { Object.setPrototypeOf(o, null); }); });
t("elsewhere", () => { const o: any = { a: 1, b: 2 }; const other: any = { z: 1 }; return walk(o, () => { delete other.z; }); });
t("receiver reassigned", () => { let o: any = { a: 1, b: 2, c: 3 }; const r: string[] = []; for (const k in o) { r.push(k); o = { z: 1 }; } return r; });
t("receiver deleted from after", () => { let o: any = { a: 1, b: 2, c: 3 }; const first = o; const r: string[] = []; for (const k in o) { r.push(k); o = null; delete first.c; } return r; });
t("number receiver", () => { let o: any = 5; const r: string[] = []; for (const k in o) r.push(k); return r; });
t("null receiver", () => { let o: any = null; const r: string[] = []; for (const k in o) r.push(k); return r; });
t("typed array", () => { const a = new Int32Array(3); return walk(a, () => { }); });
t("string", () => walk("ab", () => { }));
t("nested", () => { const o: any = { a: 1, b: 2, c: 3 }; const r: string[] = []; for (const k in o) { r.push(k); for (const j in o) { if (j === "b") delete o.c; } } return r; });
t("break and continue", () => {
  const o: any = { a: 1, b: 2, c: 3, d: 4 }; const r: string[] = [];
  for (const k in o) { delete o.b; if (k === "a") continue; r.push(k); if (k === "c") break; }
  return r;
});
t("var and member targets", () => {
  const o: any = { a: 1, b: 2, c: 3 }; const box: any = {}; const r: string[] = [];
  for (box.k in o) { r.push(box.k); delete o.b; }
  var v: string; for (v in { p: 1 }) r.push(v);
  return r;
});
async function coroutine(): Promise<string[]> {
  const o: any = { a: 1, b: 2, c: 3 }; const r: string[] = [];
  for (const k in o) { r.push(k); await null; delete o.b; }
  return r;
}
coroutine().then((r) => console.log("async", r));
function* generator(): Generator<string> { const o: any = { a: 1, b: 2, c: 3 }; for (const k in o) { yield k; delete o.b; } }
console.log("generator", [...generator()]);

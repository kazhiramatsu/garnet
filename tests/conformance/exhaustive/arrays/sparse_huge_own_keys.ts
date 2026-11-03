// A sparse array is enumerated from its table: it stays sparse and can be longer than memory. Own keys, values, entries,
// for..in, spread and console.log of `b[4294967294] = x` were a RangeError from the densify they went through.
const t = (name: string, f: () => unknown) => {
  try { console.log(name, f()); } catch (e) { console.log(name, "threw", (e as Error).name, (e as Error).message); }
};
const mk = (): any => { const b: any = [10, 20, 30]; b.x = 1; b[4294967294] = "last"; return b; };
t("keys", () => Object.keys(mk()));
t("values", () => Object.values(mk()));
t("entries", () => Object.entries(mk()));
t("forin", () => { const r: string[] = []; for (const k in mk()) r.push(k); return r; });
t("names", () => Object.getOwnPropertyNames(mk()));
t("ownKeys", () => Reflect.ownKeys(mk()));
t("delete", () => { const b = mk(); delete b[4294967294]; delete b[1]; return [b.length, Object.keys(b)]; });
t("pop", () => { const b = mk(); const r = b.pop(); return [r, b.length, Object.keys(b)]; });
t("length", () => { const b = mk(); b.length = 2; return [b.length, Object.keys(b)]; });
t("shorter", () => { const b = mk(); b.length = 4294967290; return [b.length, Object.keys(b)]; });
t("spread", () => ({ ...mk() }));
t("assign", () => Object.assign({}, mk()));
t("rest", () => { const { x, ...r } = mk(); return [x, r]; });
t("inspect", () => mk());
t("frozen", () => Object.isFrozen(Object.freeze(mk())));
t("order", () => { const b: any = []; b[900000] = 1; b[5000] = 2; b[700000] = 3; b[3] = 4; return Object.keys(b); });
t("values order", () => { const b: any = []; b[900000] = 1; b[5000] = 2; b[700000] = 3; b[3] = 4; return Object.values(b); });
t("change", () => {
  const b: any = []; b[900000] = 1; b[5000] = 2; b[700000] = 3;
  const seen: string[] = [];
  for (const k in b) { seen.push(k); delete b[700000]; }
  return seen;
});
t("getter", () => {
  const b: any = []; b[900000] = 1; b[5000] = 2;
  const o = { ...b, get g() { return Object.keys(b).length; } };
  return o;
});

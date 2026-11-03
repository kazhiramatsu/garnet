// @ts-nocheck
// A getter that changes the object it is read from, during a copy or a listing: the walk is over the keys it began with
// (CopyDataProperties, EnumerableOwnProperties): a key that has gone is skipped, one that was added is not visited. The walk
// was over the live map, so an added key was copied and another was lost (silent).
const log = [];
const mk = () => {
  const o: any = { a: 1, get b() { log.push("b"); delete o.c; o.z = 1; return 2; }, c: 3, get d() { log.push("d"); delete o.a; return 4; }, e: 5, 1: "one",
    get 0() { log.push("0"); delete o.e; o[5] = 5; return "zero"; } };
  return o;
};
const show = (n, f) => { log.length = 0; let r; try { r = f(); } catch (e) { r = e.name; } console.log(n, r, log.join(",")); };
show("spread", () => ({ ...mk() }));
show("assign", () => Object.assign({}, mk()));
show("entries", () => Object.entries(mk()));
show("values", () => Object.values(mk()));
show("keys", () => Object.keys(mk()));
show("json", () => JSON.stringify(mk()));
show("json indent", () => JSON.stringify(mk(), null, 1));
show("json replacer", () => JSON.stringify(mk(), (k, v) => (typeof v === "number" ? v * 10 : v)));
show("rest", () => { const { a, ...r } = mk(); return r; });
show("fromEntries", () => Object.fromEntries(Object.entries(mk())));
show("for in", () => { const k = []; const o = mk(); for (const q in o) { k.push(q); o[q]; } return k; });
show("instance", () => {
  class C { x = 1; y = 2; }
  const c: any = new C();
  Object.defineProperty(c, "g", { get() { log.push("g"); delete c.h; c.w = 0; return 9; }, enumerable: true, configurable: true });
  c.h = 7;
  return [{ ...c }, JSON.stringify(c), Object.entries(c)];
});
show("deletes itself", () => { const o: any = { get a() { delete o.a; return 1; }, b: 2 }; return [{ ...o }, Object.keys(o)]; });
show("adds before", () => { const o: any = { get a() { o.y = 0; return 1; }, b: 2 }; return { ...o }; });
show("no accessor", () => { const o: any = { a: 1, b: 2, 3: 3 }; return [{ ...o }, JSON.stringify(o), Object.entries(o)]; });

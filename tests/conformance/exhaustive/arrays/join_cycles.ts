// An array met again during its own join answers the empty string, V8's join stack: this was a stack overflow.
const t = (name: string, f: () => unknown) => {
  try { console.log(name, f()); } catch (e) { console.log(name, "threw", (e as Error).name, (e as Error).message); }
};
t("self join", () => { const a: any[] = [1]; a.push(a); return a.join(); });
t("self string", () => { const a: any[] = [1]; a.push(a); return String(a); });
t("template", () => { const a: any[] = [1]; a.push(a, 2); return `${a}`; });
t("add", () => { const a: any[] = [1]; a.push(a, 2); return "" + a; });
t("two arrays", () => { const a: any[] = [1]; const b: any[] = [2, a]; a.push(b); return a.join("-"); });
t("twice", () => { const a: any[] = [1]; const b: any[] = [a, a]; a.push(b, b); return a.toString(); });
t("again after", () => { const a: any[] = [1]; a.push(a); a.join(); return [a, a].join("|"); });
t("a throw pops", () => {
  const a: any[] = [1];
  a.push({ toString() { throw new Error("x"); } }, a);
  try { a.join(); } catch { }
  a[1] = 2;
  return a.join();
});
t("a throw reaches the caller", () => { const a: any[] = [[{ toString() { throw new TypeError("deep"); } }]]; a.push(a); return a.join(); });
t("reentry from toString", () => { const a: any[] = []; a.push({ toString() { return "<" + a.join() + ">"; } }, 7); return a.join(); });
t("not a cycle", () => { const x = [1]; return [x, x, [x]].join(); });
t("fresh", () => [[1, [2, [3]]], 4].join());

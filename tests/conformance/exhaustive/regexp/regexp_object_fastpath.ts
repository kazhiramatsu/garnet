function main(): void {
  const r = /abc/;
  console.log(r.test("zzabc"));
  console.log(r.source, r.flags, r.lastIndex);
  console.log(String(r), `${r}`, r.toString());
  console.log(Object.prototype.toString.call(r));
  console.log(r);
  r.lastIndex = 2;
  console.log(r.test("zzabc"), r.lastIndex);
  console.log(Object.keys(r).join(","));

  const g = /abc/g;
  console.log(g.lastIndex);
  console.log(g.test("zzabcabc"), g.lastIndex);
  console.log(g.test("zzabcabc"), g.lastIndex);
  console.log(g.test("zzabcabc"), g.lastIndex);

  const y = /abc/y;
  y.lastIndex = 2;
  console.log(y.test("zzabc"), y.lastIndex);
  y.lastIndex = 1;
  console.log(y.test("zzabc"), y.lastIndex);

  const a = /^abc/g;
  a.lastIndex = 1;
  console.log(a.test("abc"), a.lastIndex);

  const s = /abc/g;
  s.lastIndex = 4;
  console.log("zzabc".search(s), s.lastIndex);

  const e = /abc/;
  const em: any = e.exec("zzabc");
  console.log(em[0], em.index, em.input, em.groups, Object.keys(em).join(","), e.lastIndex);

  const eg = /abc/g;
  const eg1: any = eg.exec("zzabcabc");
  console.log(eg1[0], eg1.index, eg.lastIndex);
  const eg2: any = eg.exec("zzabcabc");
  console.log(eg2[0], eg2.index, eg.lastIndex);
  const eg3: any = eg.exec("zzabcabc");
  console.log(eg3, eg.lastIndex);

  const ey = /abc/y;
  ey.lastIndex = 2;
  const ey1: any = ey.exec("zzabc");
  console.log(ey1[0], ey1.index, ey.lastIndex);
  ey.lastIndex = 1;
  const ey2: any = ey.exec("zzabc");
  console.log(ey2, ey.lastIndex);

  const emoji = /😀/g;
  console.log(String(emoji));
  console.log(emoji);
}
main();

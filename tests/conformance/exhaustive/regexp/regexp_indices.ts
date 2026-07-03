function main(): void {
  const d1: any = /(a)(b)?/d.exec("xa");
  console.log(d1[0], d1.index, d1.indices[0][0], d1.indices[0][1], d1.indices[1][0], d1.indices[1][1], d1.indices[2], d1.indices.groups);

  const r = /ab/d;
  const d2: any = r.exec("xxab");
  console.log(d2[0], d2.index, d2.indices[0][0], d2.indices[0][1], r.lastIndex);

  const m: any = "xxab".match(/ab/d);
  console.log(m[0], m.index, m.indices[0][0], m.indices[0][1]);

  const g: any = "ab ab".match(/ab/dg);
  console.log(g.join("|"), g.indices);
}
main();

function main(): void {
  const r = /ab+/g;
  const test = r.test;
  console.log(typeof test, test.call(r, "zzabbb"), r.lastIndex);
  console.log(test.apply(r, ["xx"]), r.lastIndex);

  r.lastIndex = 0;
  const exec = r.exec;
  const m1: any = exec.call(r, "zzabbb");
  console.log(m1[0], m1.index, r.lastIndex);

  r.lastIndex = 0;
  const bound = exec.bind(r);
  const m2: any = bound("ab");
  console.log(m2[0], m2.index, r.lastIndex);

  const q = /(?<x>a)(b)?/d;
  const qe = q.exec;
  const qm: any = qe.call(q, "xa");
  console.log(qm.groups.x, qm.indices.groups.x[0], qm.indices.groups.x[1], qm[2]);
}
main();

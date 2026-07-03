function main(): void {
  const m1: any = "xxabbb".match(/ab+/);
  console.log(m1[0], m1.index, m1.input, m1.groups);

  const g1: any = "ab abb x".match(/ab+/g);
  console.log(g1.join("|"));

  const cap: any = "xabbb".match(/a(b+)?/);
  console.log(cap[0], cap[1], cap.index);

  console.log("xxx".match(/ab+/));

  const ri = /abc/i;
  const mi: any = "ABC".match(ri);
  console.log(mi[0], mi.index, ri.lastIndex);

  const rg = /ab+/g;
  rg.lastIndex = 99;
  const gm: any = "ab abb x".match(rg);
  console.log(gm.join(","), rg.lastIndex);

  const empty: any = "abc".match(/(?:)/g);
  console.log(empty.length, empty.join("-"));

  const emptyU: any = "😀x".match(/(?:)/gu);
  console.log(emptyU.length, emptyU.join("|"));

  const emoji: any = "x😀😀y".match(/😀+/g);
  console.log(emoji.join(","));

  const sticky = /ab/y;
  sticky.lastIndex = 2;
  const sm: any = "xxab".match(sticky);
  console.log(sm[0], sm.index, sticky.lastIndex);
  sticky.lastIndex = 1;
  console.log("xxab".match(sticky), sticky.lastIndex);

  const stickyGlobal = /ab/gy;
  stickyGlobal.lastIndex = 3;
  const sgm: any = "abxxab".match(stickyGlobal);
  console.log(sgm.join(","), stickyGlobal.lastIndex);
}
main();

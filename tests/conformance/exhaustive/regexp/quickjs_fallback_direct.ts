function main(): void {
  console.log(/ab+/.test("xxabbb"));
  console.log(/ab+/.test("ac"));
  console.log(/abc/i.test("ABC"));
  console.log(/^(ab|cd)+$/.test("abcdab"));
  console.log(/(a)(b+)/.test("zzabbb"));
  console.log(/z+/.test("x😀😀y"));
  console.log(/😀+/.test("x😀😀y"));
  console.log(/😀+/u.test("x😀😀y"));
  console.log(/^.$/.test("😀"));
  console.log(/^.$/u.test("😀"));
  console.log(/b/y.test("abc"));
  console.log("xxabbb".search(/ab+/));
  console.log("ABC".search(/abc/i));
  console.log("x😀😀y".search(/y$/));
  console.log("x😀y".search(/😀/));
  console.log("x😀y".search(/😀/u));
  console.log(/\u{1f600}/u.test("😀"));
  const m: any = /a(b+)/.exec("xxabbb");
  console.log(m[0], m[1], m.index, m.input, m.groups, Object.keys(m).join(","));
  console.log(/z+/.exec("abc") === null);
  const opt: any = /(x)?y/.exec("y");
  console.log(opt[0], opt[1], opt.length, Object.keys(opt).join(","));
  const wide: any = /^.$/u.exec("😀");
  console.log(wide[0], wide[0].length, wide.index);
  console.log(/^.$/.exec("😀") === null);
}
main();

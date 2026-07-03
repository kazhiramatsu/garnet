function main(): void {
  const o = { a: { b: { c: 42 } }, list: [1, 2, 3] };
  console.log(o.a.b.c, o.list[1]);
  o.a.b.c = 99;
  console.log(o.a.b.c, JSON.stringify(o));
}

main();

function main(): void {
  // object-literal method nested inside another, capturing+mutating an outer var.
  let i = 0;
  const o = { make() { return { step() { return i++; } }; } };
  const s = o.make();
  console.log(s.step(), s.step(), s.step());   // 0 1 2
  // arrow -> object-literal method
  let j = 100;
  const mk = () => ({ step() { return j++; } });
  const s2 = mk();
  console.log(s2.step(), s2.step());           // 100 101
}
main();

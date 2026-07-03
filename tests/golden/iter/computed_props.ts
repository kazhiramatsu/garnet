function main(): void {
  const k = "dyn";
  const o: any = { [k]: 1, [k + "2"]: 2, ["lit"]: 3, normal: 4 };
  console.log(o.dyn, o.dyn2, o.lit, o.normal);
  const d: any = {};
  Object.defineProperty(d, "p", { value: 10 });
  Object.defineProperty(d, k, { value: 20 });
  console.log(d.p, d.dyn);
}

main();

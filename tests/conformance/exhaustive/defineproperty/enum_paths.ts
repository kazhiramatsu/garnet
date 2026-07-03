function main(): void {
  const o: any = { a: 1 };
  Object.defineProperty(o, "hidden", { value: 2 });
  console.log(JSON.stringify(o));        // {"a":1}
  const copy = { ...o };
  console.log(JSON.stringify(copy));     // {"a":1}
  const vals = Object.values(o);
  console.log(vals.join(","));           // 1
}
main();

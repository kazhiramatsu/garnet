function main(): void {
  const n = 42; const s = "x"; const b = true;
  let score = 0;
  if (typeof n === "number") { score = score + 1; }
  if (typeof s === "string") { score = score + 10; }
  if (typeof b === "boolean") { score = score + 100; }
  const v = void 0;
  if (typeof v === "undefined") { score = score + 1000; }
  console.log(score);   // 1111
}

main();

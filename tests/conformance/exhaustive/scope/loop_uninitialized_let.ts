for (let i = 0; i < 3; i++) {
  let value: number | undefined;
  if (i === 0) value = 10;
  console.log(value);
}
let round = 0;
const readers: (() => number | undefined)[] = [];
while (round++ < 3) {
  let value: number | undefined;
  if (round === 1) value = 20;
  readers.push(() => value);
}
console.log(readers.map(read => String(read())).join(","));
function repeatedFor(): void {
  for (let outer = 0; outer < 2; outer++) {
    for (let value: number | undefined; value === undefined;) {
      console.log("fresh", outer);
      value = 1;
    }
  }
}
repeatedFor();

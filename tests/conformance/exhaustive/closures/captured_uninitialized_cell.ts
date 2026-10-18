// A captured `let`/`var` declared without an initializer must read as
// `undefined` before its first assignment, including through `??=`. With
// typed cells the variable lives in a struct slot that comes from zeroed
// memory (the number 0 under NaN-boxing), so the slot has to be set to
// undefined when the cell is created. The checker's lazily created scanner
// (`scanner ??= createScanner(...)`) was the real-world failure.

function createChecker() {
  var scanner: { m(): number } | undefined;
  let count = 0;
  let name: string | undefined;
  let bag;
  function check() {
    scanner ??= { m() { return 42; } };
    count++;
    name ??= "n" + count;
    bag ||= [count];
    return scanner.m();
  }
  return { check, get: () => count, name: () => name, raw: () => scanner, bag: () => bag };
}

function loopCells(): string[] {
  const fns: (() => unknown)[] = [];
  for (let i = 0; i < 3; i++) {
    let late: number | undefined;
    fns.push(() => late);
    if (i === 1) late = i * 10;
  }
  return fns.map(f => String(f()));
}

function main(): void {
  const c = createChecker();
  console.log(c.raw(), c.name(), c.bag());
  console.log(c.check(), c.check(), c.get(), c.name(), JSON.stringify(c.bag()));
  console.log(loopCells().join(","));
}
main();

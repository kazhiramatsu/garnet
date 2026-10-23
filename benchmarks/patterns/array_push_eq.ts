// A printer's output buffer and a checker's flag tests: pushes into plain
// arrays that grow and reset, and `x === n` where x is a boxed value (an
// optional number read back from the array) against an unboxed number.
function main() {
  const parts: (number | undefined)[] = [];
  let acc = 0;
  let matched = 0;
  for (let rep = 0; rep < 60; rep++) {
    parts.length = 0;
    for (let i = 0; i < 100000; i++) parts.push((i & 7) === 3 ? undefined : i & 1023);
    const want = 512;
    for (let i = 0; i < parts.length; i++) {
      const v = parts[i];
      if (v === want) matched++;
      if (v !== undefined) acc = (acc + v) | 0;
    }
  }
  console.log(acc, matched, parts.length);
}
main();

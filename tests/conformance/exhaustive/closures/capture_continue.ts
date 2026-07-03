// Captured `let i` interacting with `continue`: closures should see iter-specific
// value even when the iteration `continue`s. Per spec, the body-time value is
// what's captured; the update runs on the NEXT iteration's binding.
function main(): void {
  const fns: Array<() => number> = [];
  for (let i = 0; i < 5; i++) {
    if (i % 2 === 0) continue;
    fns.push(() => i);
  }
  console.log(fns.length, fns[0](), fns[1]());
}

main();

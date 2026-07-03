// Capture the captured-let `i` directly: closures should see the iteration's
// body-time value (V8: 0 1 2 — iter 0,1,2 each captures its own `i`).
// This is the same as the simple capture test but with an explicit body action
// that doesn't change `i` itself, just to exercise the path without crashing.
function main(): void {
  const fns: Array<() => number> = [];
  const arr: number[] = [];
  for (let i = 0; i < 3; i++) {
    arr.push(i * 10);
    fns.push(() => i + arr[i]);
  }
  console.log(fns[0](), fns[1](), fns[2]());
}

main();

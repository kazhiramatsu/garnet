// Non-captured `let i`: should use the single-cell fast path (no per-iteration
// allocation). This is a correctness test; perf is enforced by kernel budgets.
function main(): void {
  let sum = 0;
  for (let i = 0; i < 100; i++) { sum = sum + i; }
  console.log(sum);
}

main();

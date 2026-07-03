function churn(n) {
  let i = 0;
  let sum = 0;
  while (i < n) {
    const a = [i, i + 1, i + 2];
    sum = sum + a[1];
    i = i + 1;
  }
  return sum;
}

function kernel(oldN, rounds, churnN) {
  const g = globalThis;
  const root = [];
  let i = 0;
  while (i < oldN) {
    root.push({ x: i });
    i = i + 1;
  }
  g.__gc_old_heap = root;
  churn(70000);
  let r = 0;
  let sum = 0;
  while (r < rounds) {
    sum = sum + churn(churnN);
    r = r + 1;
  }
  return sum + root[oldN - 1].x;
}

console.log(kernel(50000, 20, 100000));

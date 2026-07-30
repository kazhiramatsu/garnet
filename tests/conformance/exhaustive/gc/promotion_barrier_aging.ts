// Regression for the aging promotion barrier. The parent survives one minor
// before the child is allocated. On the next minor the parent promotes while
// the child remains young, creating an old->young edge that no ordinary store
// barrier observed (the store originally happened young->young).
function churn(count: number): number {
  let checksum = 0;
  for (let i = 0; i < count; i++) {
    const temporary: any = { value: i };
    checksum += temporary.value;
  }
  return checksum;
}

const agingParent: any = { tag: "parent" };
(globalThis as any).__aging_promotion_parent = agingParent;

// With TSAOT_GC_YOUNG_THRESHOLD=16: the final allocation triggers minor #1
// and leaves one fresh allocation in the next nursery cycle.
churn(16);

const child: any = { value: 41 };
agingParent.child = child;

// Fill the cycle, then trigger minor #2: parent promotes, child stays young.
churn(14);
churn(1);

// Trigger minor #3. The promotion barrier must keep parent in the remembered
// set so its still-young child is marked rather than reclaimed.
churn(15);
churn(1);

console.log(
  (globalThis as any).__aging_promotion_parent.tag,
  agingParent.child.value,
  agingParent.child === child,
);

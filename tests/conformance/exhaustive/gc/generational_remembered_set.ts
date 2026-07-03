function churn(n: number): number {
  let i = 0;
  let sum = 0;
  while (i < n) {
    const a: any = [i, i + 1, i + 2];
    sum = sum + a[1];
    i = i + 1;
  }
  return sum;
}

class Box {
  value: any;
  constructor(v: any) {
    this.value = v;
  }
}

const g: any = globalThis;

g.__gc_holder = { tag: "old-object" };
churn(70000);
g.__gc_holder.child = { x: 41 };
churn(70000);
console.log(g.__gc_holder.child.x);

g.__gc_arr = [];
churn(70000);
g.__gc_arr.push({ v: 7 });
churn(70000);
console.log(g.__gc_arr[0].v);

g.__gc_map = new Map();
churn(70000);
const mk: any = { k: 1 };
g.__gc_map.set(mk, { v: 2 });
churn(70000);
console.log(g.__gc_map.get(mk).v);

g.__gc_set = new Set();
churn(70000);
const sv: any = { v: 3 };
g.__gc_set.add(sv);
churn(70000);
console.log(g.__gc_set.has(sv), Array.from(g.__gc_set)[0].v);

const box = new Box(null);
g.__gc_box = box;
churn(70000);
box.value = { z: 9 };
churn(70000);
console.log(box.value.z);

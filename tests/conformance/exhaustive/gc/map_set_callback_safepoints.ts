// Map/Set iteration allocates arrays and calls user callbacks, so the collection
// object and callback must stay rooted and raw pointers must be re-fetched.
function churn(n: number): number {
  let i = 0;
  let sum = 0;
  while (i < n) {
    const o: any = { value: i };
    sum += o.value;
    i++;
  }
  return sum;
}

const m = new Map<any, number>();
m.set("a", 1);
m.set("b", 2);
m.set("c", 3);
churn(70000);
console.log(Array.from(m.keys()).join(",")); // a,b,c
churn(70000);
console.log(Array.from(m.values()).join(",")); // 1,2,3
churn(70000);
console.log(Array.from(m.entries()).map((p) => p[0] + p[1]).join(",")); // a1,b2,c3

const m2 = new Map<any, any>();
let mi = 0;
while (mi < 8) {
  m2.set({ id: mi }, { tag: "v" + mi });
  mi++;
}
churn(70000);
const m2pairs: any = Array.from(m2.entries());
console.log(m2pairs[0][0].id, m2pairs[7][1].tag);

let mt = 0;
m.forEach((v, k) => {
  churn(70000);
  mt += v + k.length;
});
console.log(mt); // 9

const s = new Set<any>();
s.add("x");
s.add("y");
s.add("z");
churn(70000);
console.log(Array.from(s.values()).join(",")); // x,y,z

let st = "";
s.forEach((v) => {
  churn(70000);
  st += v;
});
console.log(st); // xyz

// JSON parse/stringify/reviver paths allocate recursively and may call user code
// through getters/revivers. Keep parser outputs, reviver keys/results, and getter
// results live across those safepoints.
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

let text = "{\"root\":{\"items\":[";
let i = 0;
while (i < 20) {
  if (i > 0) text += ",";
  text += "{\"n\":" + i + "}";
  i++;
}
text += "]},\"last\":1}";

churn(70000);
const parsed: any = JSON.parse(text);
console.log(parsed.root.items[0].n, parsed.root.items[19].n, parsed.last);

const revived: any = JSON.parse("{\"a\":[1,2],\"b\":{\"c\":3}}", function(k: any, v: any): any {
  churn(70000);
  if (typeof v === "number") return { box: v };
  return v;
});
console.log(revived.a[0].box, revived.a[1].box, revived.b.c.box);

const holder: any = {};
Object.defineProperty(holder, "payload", {
  enumerable: true,
  get: function(): any {
    const v: any = { a: 1, b: [2, { c: 3 }], d: "x" };
    churn(70000);
    return v;
  },
});

console.log(JSON.stringify(holder));
console.log(JSON.stringify(holder, null, 2).indexOf("\n  \"payload\"") >= 0);

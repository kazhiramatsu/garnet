// Moving minor GC relocates young survivors and updates the stable handle table.
// This stresses moved cells that own external buffers (props/env/array/map/set),
// inline array storage, variable-sized strings, accessors, symbols, and class
// instances allocated larger than the common object header.
function churn(n: number): number {
  let i = 0;
  let sum = 0;
  while (i < n) {
    const a: any = { v: i, pair: [i, i + 1] };
    sum += a.pair[1];
    i++;
  }
  return sum;
}

const g: any = globalThis;

const obj: any = { a: 1, b: { c: 2 } };
let i = 0;
while (i < 24) {
  obj["k" + i] = i;
  i++;
}
g.__moving_obj = obj;
const objAlias = obj;
churn(70000);
console.log(obj === objAlias, obj === g.__moving_obj, obj.b.c, obj.k0, obj.k23); // true true 2 0 23
obj.after = { ok: 31 };
churn(70000);
console.log(obj.after.ok); // 31

const small: any = [1, 2, 3];
g.__moving_small = small;
churn(70000);
small.push(4);
console.log(small.join(","), small === g.__moving_small); // 1,2,3,4 true

const large: any[] = [];
i = 0;
while (i < 12) {
  large.push({ n: i });
  i++;
}
g.__moving_large = large;
churn(70000);
large.push({ n: 12 });
console.log(large[0].n, large[11].n, large[12].n, large.length); // 0 11 12 13

const text = "move-" + "minor-" + "string";
g.__moving_text = text;
churn(70000);
console.log(text.slice(5, 10), text === g.__moving_text); // minor true

function makeFn(prefix: string): (x: number) => string {
  const cap: any = { prefix };
  return function(x: number): string {
    churn(70000);
    return cap.prefix + x;
  };
}
const fn: any = makeFn("v=");
g.__moving_fn = fn;
churn(70000);
console.log(fn(7), fn === g.__moving_fn); // v=7 true

const accPayload: any = { value: 41 };
const accObj: any = {};
Object.defineProperty(accObj, "value", {
  enumerable: true,
  get: function(): number {
    churn(70000);
    return accPayload.value + 1;
  },
});
g.__moving_acc = accObj;
churn(70000);
console.log(accObj.value, Object.keys(accObj).join(",")); // 42 value

const sym = Symbol("moved");
const symObj: any = {};
symObj[sym] = { v: 5 };
g.__moving_sym = sym;
g.__moving_sym_obj = symObj;
churn(70000);
console.log(sym.toString(), symObj[sym].v); // Symbol(moved) 5

class BigBox {
  a: number;
  b: number;
  payload: any;
  constructor(a: number, b: number, payload: any) {
    this.a = a;
    this.b = b;
    this.payload = payload;
  }
  total(): number {
    return this.a + this.b + this.payload.n;
  }
}
const box: any = new BigBox(10, 20, { n: 3 });
g.__moving_box = box;
churn(70000);
console.log(box.total(), box === g.__moving_box); // 33 true
box.payload = { n: 7 };
churn(70000);
console.log(box.total()); // 37

const key: any = { id: "k" };
const val: any = { id: "v" };
const map: any = new Map();
map.set(key, val);
g.__moving_map = map;
churn(70000);
map.set({ id: "k2" }, { id: "v2" });
console.log(map.get(key).id, Array.from(map).length); // v 2

const setVal: any = { id: "s" };
const set: any = new Set([setVal]);
g.__moving_set = set;
churn(70000);
set.add({ id: "s2" });
console.log(set.has(setVal), Array.from(set).map((x: any) => x.id).join(",")); // true s,s2

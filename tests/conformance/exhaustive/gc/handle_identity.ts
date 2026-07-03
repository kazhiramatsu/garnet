function churn(n: number): number {
  let i = 0;
  let sum = 0;
  while (i < n) {
    const a: any = { v: i };
    sum = sum + a.v;
    i = i + 1;
  }
  return sum;
}

class C {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
  same(): C {
    return this;
  }
}

const g: any = globalThis;

g.__hid_obj = { x: 1 };
const sameObj: any = g.__hid_obj;
const otherObj: any = { x: 1 };
console.log(g.__hid_obj === sameObj, g.__hid_obj === otherObj);
churn(70000);
console.log(g.__hid_obj === sameObj, g.__hid_obj === otherObj, sameObj.x);

const arr: any = [];
g.__hid_arr = arr;
arr.push(g.__hid_obj);
churn(70000);
console.log(arr[0] === sameObj);

const map: any = new Map();
g.__hid_map = map;
map.set(sameObj, "ok");
churn(70000);
console.log(map.get(g.__hid_obj), map.has(otherObj));

const c = new C(10);
g.__hid_c = c;
const c2 = c.same();
churn(70000);
console.log(c === c2, c === g.__hid_c, c === new C(10));

function fn(): number {
  return 1;
}
g.__hid_fn = fn;
const fn2 = fn;
churn(70000);
console.log(fn === fn2, fn === g.__hid_fn, fn === function(): number { return 1; });

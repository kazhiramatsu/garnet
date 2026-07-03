// Reflection and dynamic-key operations can allocate while resolving getters or
// coercing property keys. Keep receivers, callback results, descriptors, and
// dynamic values live across those safepoints.
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

const keyObj: any = {
  toString: function(): string {
    churn(70000);
    return "value";
  },
};

const source: any = {};
Object.defineProperty(source, "value", {
  enumerable: true,
  configurable: true,
  get: function(): any {
    const payload: any = { tag: "payload", nested: { n: 1 } };
    churn(70000);
    return payload;
  },
});

const vals: any = Object.values(source);
console.log(vals[0].tag, vals[0].nested.n);

const entries: any = Object.entries(source);
console.log(entries[0][0], entries[0][1].tag);

const assigned: any = Object.assign({}, source);
console.log(assigned.value.tag);

const d: any = Object.getOwnPropertyDescriptor(source, keyObj);
console.log(typeof d.get, d.enumerable, d.configurable);

const many: any = {};
let i = 0;
while (i < 32) {
  many["k" + i] = i;
  i++;
}
const descs: any = Object.getOwnPropertyDescriptors(many);
console.log(descs.k0.value, descs.k31.value, Object.keys(descs).length);

const dyn: any = { value: 10 };
console.log(dyn[keyObj]);
dyn[keyObj] = 20;
console.log(dyn.value, keyObj in dyn, dyn.hasOwnProperty(keyObj));

const defined: any = {};
const writes: any = {};
const accessorDesc: any = {};
Object.defineProperty(accessorDesc, "get", {
  enumerable: true,
  configurable: true,
  get: function(): any {
    const fn: any = function(): any {
      return { tag: "accessor", nested: { n: 2 } };
    };
    churn(70000);
    return fn;
  },
});
Object.defineProperty(accessorDesc, "set", {
  enumerable: true,
  configurable: true,
  get: function(): any {
    const fn: any = function(v: any): void {
      writes.value = v.tag;
    };
    churn(70000);
    return fn;
  },
});
Object.defineProperty(accessorDesc, "enumerable", {
  enumerable: true,
  configurable: true,
  get: function(): any {
    churn(70000);
    return true;
  },
});
Object.defineProperty(accessorDesc, "configurable", {
  enumerable: true,
  configurable: true,
  get: function(): any {
    churn(70000);
    return true;
  },
});
Object.defineProperty(defined, keyObj, accessorDesc);
const got: any = defined.value;
console.log(got.tag, got.nested.n);
defined.value = { tag: "written" };
console.log(writes.value, Object.keys(defined).join(","));

class StressTagged {
  get [Symbol.toStringTag](): string {
    churn(70000);
    return "Stress" + "Tag";
  }
}
console.log(Object.prototype.toString.call(new StressTagged()));

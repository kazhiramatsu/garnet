// Lower-level runtime helpers used by coercion, Symbol.for, Function.apply,
// spread/materialization, Array.from(mapFn), and Map/Set constructors must not
// keep raw heap pointers across allocation or user callback safepoints.
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

const prim: any = {
  [Symbol.toPrimitive](hint: string): string {
    churn(70000);
    return hint + "-ok";
  },
};
console.log(String(prim)); // string-ok

const strObj: any = {
  toString: function(): string {
    churn(70000);
    return "custom";
  },
};
console.log(String(strObj)); // custom
console.log([strObj, "x", 3].join("|")); // custom|x|3

const regKey: any = {
  toString: function(): string {
    churn(70000);
    return "registered-key";
  },
};
const reg1 = Symbol.for(regKey);
churn(70000);
const reg2 = Symbol.for("registered-key");
console.log(reg1 === reg2, Symbol.keyFor(reg1)); // true registered-key

const applyArgs: any[] = [{ tag: "A" }, { tag: "B" }, { tag: "C" }];
function tags(a: any, b: any, c: any): string {
  churn(70000);
  return a.tag + b.tag + c.tag;
}
console.log(tags.apply(null, applyArgs)); // ABC

class Joiner {
  constructor(public prefix: string) {}
  join(a: any, b: any): string {
    churn(70000);
    return this.prefix + a.tag + b.tag;
  }
}
const joiner: any = new Joiner("J");
const joinMethod: any = joiner.join;
console.log(joinMethod.apply(joiner, applyArgs.slice(0, 2))); // JAB

const arrSeed: any[] = [{ v: "a" }, { v: "b" }];
churn(70000);
const arrCopy: any = [...arrSeed];
console.log(arrCopy[0].v + arrCopy[1].v); // ab

const setSeed: any = new Set([{ v: "s1" }, { v: "s2" }]);
churn(70000);
console.log([...setSeed].map((x: any) => x.v).join(",")); // s1,s2

const mapSeed: any = new Map([[{ k: "k1" }, { v: "v1" }], [{ k: "k2" }, { v: "v2" }]]);
churn(70000);
const mapPairs: any = [...mapSeed];
console.log(mapPairs[0][0].k + ":" + mapPairs[0][1].v + "|" + mapPairs[1][0].k + ":" + mapPairs[1][1].v); // k1:v1|k2:v2

const iterable: any = {
  [Symbol.iterator]() {
    churn(70000);
    let i = 0;
    return {
      next: function(): any {
        churn(70000);
        if (i < 3) return { value: { v: i++ }, done: false };
        return { value: undefined, done: true };
      },
    };
  },
};

const spreadIter: any = [...iterable];
console.log(spreadIter.map((x: any) => x.v).join(",")); // 0,1,2
console.log(Array.from(iterable, (x: any, i: number) => { churn(70000); return x.v + i; }).join(",")); // 0,2,4

const seededSet: any = new Set(iterable);
console.log(Array.from(seededSet).map((x: any) => x.v).join(",")); // 0,1,2

const pairIterable: any = {
  [Symbol.iterator]() {
    let i = 0;
    return {
      next: function(): any {
        churn(70000);
        if (i === 0) { i++; return { value: ["a", { n: 1 }], done: false }; }
        if (i === 1) { i++; return { value: ["b", { n: 2 }], done: false }; }
        return { value: undefined, done: true };
      },
    };
  },
};
const seededMap: any = new Map(pairIterable);
console.log(seededMap.get("a").n, seededMap.get("b").n); // 1 2

let fromPairs: any = [];
const fromKey: any = {
  toString: function(): string {
    fromPairs[0] = undefined;
    churn(70000);
    return "kept";
  },
};
fromPairs = [[fromKey, { tag: "fromEntries", nested: { n: 3 } }]];
const fromObj: any = Object.fromEntries(fromPairs);
console.log(fromObj.kept.tag, fromObj.kept.nested.n); // fromEntries 3

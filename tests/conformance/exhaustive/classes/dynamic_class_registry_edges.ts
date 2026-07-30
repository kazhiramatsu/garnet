// The class registry is indexed by the runtime prototype handle. Repeatedly
// evaluating a captured local class creates many distinct prototypes for one
// class layout and forces registry-index growth.
function makeClass(seed: number): any {
  return class Captured {
    value = seed;
    payload: any = { seed };
  };
}

function readValue(value: any): any {
  return value.value;
}

function writeValue(value: any, next: any): void {
  value.value = next;
}

function readPayload(value: any): any {
  return value.payload;
}

const constructors: any[] = [];
const instances: any[] = [];
for (let i = 0; i < 24; i++) {
  const C: any = makeClass(i);
  constructors.push(C);
  instances.push(new C());
}

console.log(instances.map(readValue).join(","));
for (let i = 0; i < instances.length; i++) {
  writeValue(instances[i], i + 100);
}
console.log(instances.map(readValue).join(","));
console.log(instances.map((value) => readPayload(value).seed).join(","));

// A plain object can deliberately use a registered class prototype. The
// registry's minimum-size guard must keep it on named-property storage instead
// of reading beyond the smaller allocation as though it were a class instance.
const impostor: any = Object.create(constructors[23].prototype);
console.log(readValue(impostor));
impostor.value = "plain-own";
console.log(readValue(impostor), impostor instanceof constructors[23]);

// Allocate enough garbage to move young values, then revisit every registered
// prototype and every reference-typed class field.
for (let i = 0; i < 2_000; i++) {
  const temporary: any = { i, nested: { i } };
  if (temporary.i < 0) {
    console.log("unreachable");
  }
}
console.log(
  instances.map(readValue).join(","),
  instances.map((value) => readPayload(value).seed).join(","),
);

function makeArgs(count: number): any[] {
  const values: any[] = [];
  for (let i = 0; i < count; i++) {
    values.push(i + 1);
  }
  return values;
}

// ts_construct's stack buffer contains `this` plus the arguments. Fifteen
// arguments exactly fit; sixteen and above use the heap fallback.
function Plain(this: any, ...args: any[]): void {
  this.count = args.length;
  this.first = args[0];
  this.last = args[args.length - 1];
}

class Variadic {
  count: number;
  first: any;
  last: any;

  constructor(...args: any[]) {
    this.count = args.length;
    this.first = args[0];
    this.last = args[args.length - 1];
  }
}

for (const count of [0, 1, 15, 16, 17, 40]) {
  const args = makeArgs(count);
  const plain: any = Reflect.construct(Plain, args);
  const typed: any = Reflect.construct(Variadic, args);
  console.log(
    count,
    plain.count,
    plain.first,
    plain.last,
    typed.count,
    typed.first,
    typed.last,
  );
}

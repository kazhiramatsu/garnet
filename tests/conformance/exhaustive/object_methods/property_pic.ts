function readX(value: any): any {
  return value.x;
}

function writeX(value: any, next: any): void {
  value.x = next;
}

function readDynamic(value: any, key: any): any {
  return value[key];
}

const values: any[] = [
  { x: 1 },
  { a: 0, x: 2 },
  { b: 0, c: 0, x: 3 },
  { x: 4, d: 0 },
  { e: 0, x: 5, f: 0 },
];
console.log(values.map(readX).join(","));
console.log(values.map(readX).join(","));

const changed: any = { x: 10 };
console.log(readX(changed), readX(changed));
changed.x = 11;
console.log(readX(changed));
changed.extra = 1;
console.log(readX(changed));
delete changed.x;
console.log(readX(changed));
changed.x = 12;
console.log(readX(changed));

let backing = 20;
const accessor: any = {};
Object.defineProperty(accessor, "x", {
  get() {
    return backing;
  },
  set(value: number) {
    backing = value;
  },
  configurable: true,
});
console.log(readX(accessor), readX(accessor));
writeX(accessor, 21);
console.log(readX(accessor), backing);

function readRedefined(value: any): any {
  return value.x;
}

const redefined: any = { x: 22 };
console.log(readRedefined(redefined), readRedefined(redefined));
Object.defineProperty(redefined, "x", {
  get() {
    return 23;
  },
  configurable: true,
});
console.log(readRedefined(redefined), readRedefined(redefined));
Object.defineProperty(redefined, "x", {
  value: 24,
  writable: true,
  configurable: true,
});
console.log(readRedefined(redefined), readRedefined(redefined));

const writable: any = { x: 0 };
writeX(writable, 1);
writeX(writable, 2);
console.log(readX(writable));

const dynamic: any = { x: 30, y: 31 };
console.log(
  readDynamic(dynamic, "x"),
  readDynamic(dynamic, "y"),
  readDynamic(dynamic, "x"),
);

const frozen: any = { x: 40 };
const dynamicWriter: any = writeX;
dynamicWriter(frozen, 41);
Object.freeze(frozen);
try {
  dynamicWriter(frozen, 42);
} catch (error: any) {
  console.log(error instanceof TypeError);
}
console.log(readX(frozen));

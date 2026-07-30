// Adaptive named-property index edge cases. These cases cross the eight-entry
// threshold, grow the table, compact dense slots after deletion, shrink back to
// linear mode, and combine indexed storage with descriptors and prototypes.
function fill(target: any, count: number, prefix: string): void {
  for (let i = 0; i < count; i++) {
    target[prefix + i] = i * 10;
  }
}

function checksum(target: any, count: number, prefix: string): number {
  let total = 0;
  for (let i = 0; i < count; i++) {
    const value = target[prefix + i];
    if (value !== undefined) {
      total += value;
    }
  }
  return total;
}

const seven: any = {};
fill(seven, 7, "k");
console.log(Object.keys(seven).length, seven.k0, seven.k6, seven.missing);

const eight: any = {};
fill(eight, 8, "k");
console.log(Object.keys(eight).length, eight.k0, eight.k7, eight.missing);

// Twenty-four entries force multiple index-capacity decisions and naturally
// exercise open-addressing collisions.
const large: any = {};
fill(large, 24, "k");
console.log(Object.keys(large).length, checksum(large, 24, "k"));
console.log(large.k0, large.k11, large.k23, large.notPresent);

// Delete the first, a middle, and the last dense slot. Every deletion rebuilds
// the sparse index because later dense positions move.
delete large.k0;
delete large.k11;
delete large.k23;
console.log(
  Object.keys(large).length,
  large.k0,
  large.k1,
  large.k10,
  large.k11,
  large.k12,
  large.k22,
  large.k23,
);
console.log(checksum(large, 24, "k"));

// Re-adding a deleted name appends it at the end of string-key enumeration.
large.k11 = 1100;
const reordered = Object.keys(large);
console.log(large.k11, reordered[reordered.length - 1], reordered.length);

// Repeated writes and defineProperty calls must update one slot rather than
// creating duplicate index entries.
for (let i = 0; i < 20; i++) {
  large.same = i;
}
Object.defineProperty(large, "same", {
  value: 99,
  writable: true,
  enumerable: true,
  configurable: true,
});
console.log(large.same, Object.keys(large).filter((key) => key === "same").length);

// Data/accessor transitions inside an indexed object preserve the index entry.
let backing = 500;
Object.defineProperty(large, "k5", {
  get() {
    return backing;
  },
  set(value: number) {
    backing = value;
  },
  enumerable: true,
  configurable: true,
});
console.log(large.k5);
large.k5 = 501;
console.log(large.k5, backing);
Object.defineProperty(large, "k5", {
  value: 502,
  writable: true,
  enumerable: true,
  configurable: true,
});
console.log(large.k5);

// Shrinking below eight entries removes the sparse index internally. Re-growth
// from dictionary shape must remain correct.
const shrinking: any = {};
fill(shrinking, 12, "s");
for (let i = 0; i < 6; i++) {
  Reflect.deleteProperty(shrinking, "s" + i);
}
console.log(
  Object.keys(shrinking).join(","),
  shrinking.s5,
  shrinking.s6,
  shrinking.s11,
);
shrinking.s0 = 1000;
shrinking.s12 = 1200;
console.log(Object.keys(shrinking).length, shrinking.s0, shrinking.s6, shrinking.s12);

// A large prototype and a large receiver exercise indexed own misses followed
// by indexed inherited hits. Adding/deleting an own shadow must be visible.
const proto: any = {};
fill(proto, 16, "p");
const child: any = Object.create(proto);
fill(child, 16, "c");
console.log(child.p0, child.p15, child.c0, child.c15, child.absent);
child.p8 = "own";
console.log(child.p8);
delete child.p8;
console.log(child.p8);

// Symbols share the named-property vector/index but remain excluded from
// Object.keys and JSON stringification.
const symbolA = Symbol("a");
const symbolB = Symbol("b");
large[symbolA] = "A";
large[symbolB] = "B";
console.log(large[symbolA], large[symbolB], Object.keys(large).includes("Symbol(a)"));
console.log(JSON.stringify({ a: large[symbolA], b: large[symbolB] }));

// Integrity operations must preserve indexed reads and enforce strict writes.
const sealed: any = {};
fill(sealed, 10, "q");
Object.seal(sealed);
sealed.q5 = 55;
try {
  sealed.extra = 1;
} catch (error: any) {
  console.log(error instanceof TypeError);
}
try {
  delete sealed.q4;
} catch (error: any) {
  console.log(error instanceof TypeError);
}
console.log(sealed.q4, sealed.q5, sealed.extra);

const frozen: any = {};
fill(frozen, 10, "f");
Object.freeze(frozen);
try {
  frozen.f9 = 999;
} catch (error: any) {
  console.log(error instanceof TypeError);
}
console.log(frozen.f0, frozen.f9);

// JSON construction uses the same indexed find/create path. A duplicate key
// updates the original slot, while later unique keys cross the threshold.
const parsed: any = JSON.parse(
  '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9,"dup":1,"dup":2}',
);
console.log(
  Object.keys(parsed).join(","),
  parsed.a,
  parsed.i,
  parsed.dup,
  Object.keys(parsed).length,
);

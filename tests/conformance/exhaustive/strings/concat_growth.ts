function buildAscii(count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) out += "ab" + (i & 7);
  return out;
}

const linear = buildAscii(80);
console.log(
  linear.length,
  linear.slice(0, 6),
  linear.slice(-6),
  linear.indexOf("ab7"),
  linear.charCodeAt(37)
);

// Extending the tail may append to the hidden storage, but every older string
// value remains an immutable prefix.
let trunk = buildAscii(24);
const prefix = trunk;
const prefixSlice = trunk.slice(5, 29);
const left = trunk + "-left";
const right = trunk + "-right";
console.log(prefix.length, prefix.slice(-6), prefixSlice, left.slice(-5), right.slice(-6));

// A Latin-1 builder must copy to UTF-16 rather than changing the width under
// old views. Once UTF-16, later Latin-1 suffixes can extend the same buffer.
let mixed = buildAscii(16);
const asciiBeforeWide = mixed;
mixed += "😀";
const widePrefix = mixed;
mixed += "-tail";
console.log(
  asciiBeforeWide.slice(-6),
  widePrefix.slice(-4),
  mixed.slice(-9),
  mixed.length - asciiBeforeWide.length
);

// concatMany can reuse an owning first part while preserving template
// evaluation and coercion order.
let templated = buildAscii(20);
const templatePrefix = templated;
templated = `${templated}:value=${7}:end`;
console.log(templatePrefix.slice(-3), templated.slice(-12));

// Hashing a prefix for Map must remain stable after its buffer grows.
let keyed = buildAscii(18);
const keyPrefix = keyed;
const map = new Map<string, number>();
map.set(keyPrefix, 42);
keyed += "-after-hash";
console.log(map.get(keyPrefix), map.get(buildAscii(18)), keyPrefix === buildAscii(18));

console.log(linear.toUpperCase().slice(0, 8));

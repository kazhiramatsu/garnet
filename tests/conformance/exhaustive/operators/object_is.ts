function main(): void {
  // Object.is (SameValue): NaN equals NaN; objects by identity.
  console.log(Object.is(NaN, NaN));         // true
  console.log(Object.is(1, 1));             // true
  console.log(Object.is(1, 2));             // false
  console.log(Object.is("a", "a"));         // true
  console.log(Object.is("a", "b"));         // false
  const o = {};
  console.log(Object.is(o, o));             // true
  console.log(Object.is({}, {}));           // false
}
main();

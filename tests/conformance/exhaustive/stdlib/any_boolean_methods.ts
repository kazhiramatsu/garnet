function main(): void {
  // Boolean primitives now follow the same prototype dispatch model as string
  // and number primitives, including any-typed dynamic calls.
  console.log((true).toString(), (false).toString()); // true false
  console.log((true).valueOf(), (false).valueOf());   // true false

  const t: any = true;
  const f: any = false;
  console.log(t.toString(), f.toString());            // true false
  console.log(t.valueOf(), f.valueOf());              // true false
  console.log(t?.toString());                         // true

  const toStringKey: any = "toString";
  const valueOfKey: any = "valueOf";
  console.log(t[toStringKey](), f[toStringKey]());    // true false
  console.log(t[valueOfKey](), f[valueOfKey]());      // true false

  const boolToString = Boolean.prototype.toString;
  const boolValueOf = Boolean.prototype.valueOf;
  console.log(typeof boolToString, typeof boolValueOf); // function function
  console.log(boolToString.call(true), boolToString.call(false)); // true false
  console.log(boolValueOf.call(true), boolValueOf.call(false));   // true false
}
main();

function reflected(a: number, b: number): number {
  return a + b;
}

function main(): void {
  const arr = [10, 20];
  const da0 = Object.getOwnPropertyDescriptor(arr, "0");
  const dal = Object.getOwnPropertyDescriptor(arr, "length");
  console.log(da0.value, da0.enumerable, da0.writable, da0.configurable); // 10 true true true
  console.log(dal.value, dal.enumerable, dal.writable, dal.configurable); // 2 false true false

  const ds0 = Object.getOwnPropertyDescriptor("ab", "0");
  const dsl = Object.getOwnPropertyDescriptor("ab", "length");
  console.log(ds0.value, ds0.enumerable, ds0.writable, ds0.configurable); // a true false false
  console.log(dsl.value, dsl.enumerable, dsl.writable, dsl.configurable); // 2 false false false

  const df = Object.getOwnPropertyDescriptor(reflected, "length");
  const dn = Object.getOwnPropertyDescriptor(reflected, "name");
  console.log(df.value, df.enumerable, df.writable, df.configurable); // 2 false false true
  console.log(dn.value, dn.enumerable, dn.writable, dn.configurable); // reflected false false true

  const all: any = Object.getOwnPropertyDescriptors(reflected);
  console.log(all["length"].value, all["name"].value); // 2 reflected

  console.log(Object.keys("ab").join(",")); // 0,1
  console.log(Object.values("ab").join(",")); // a,b
  console.log(Object.entries("ab").map((e) => e.join(":")).join(",")); // 0:a,1:b
  const assigned: any = Object.assign({}, "ab");
  console.log(assigned[0], assigned[1], Object.keys(assigned).join(",")); // a b 0,1
  const spread: any = { ..."ab" };
  console.log(spread[0], spread[1], Object.keys(spread).join(",")); // a b 0,1
}

main();

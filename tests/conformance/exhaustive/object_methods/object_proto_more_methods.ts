// Additional Object.prototype methods: toLocaleString / isPrototypeOf /
// propertyIsEnumerable. They are inherited through the same prototype path as
// toString/valueOf/hasOwnProperty and usable as first-class values.

const tls = Object.prototype.toLocaleString;
const ipo = Object.prototype.isPrototypeOf;
const pie = Object.prototype.propertyIsEnumerable;

function reflected(a: number): number {
  return a;
}

function main(): void {
  const o: any = { a: 1 };
  Object.defineProperty(o, "hidden", { value: 2 });
  Object.defineProperty(o, "shown", { value: 3, enumerable: true });

  console.log(typeof tls, typeof ipo, typeof pie); // function function function

  console.log(o.toLocaleString()); // [object Object]
  const custom: any = { toString() { return "custom"; } };
  console.log(custom.toLocaleString(), tls.call(custom)); // custom custom
  console.log(Object.prototype.toLocaleString.call([1, 2, 3])); // 1,2,3
  console.log(Object.prototype.toLocaleString.call(255)); // 255

  const child: any = Object.create(o);
  console.log(o.isPrototypeOf(child), o.isPrototypeOf({})); // true false
  console.log(ipo.call(Object.prototype, child), ipo.call(Array.prototype, [])); // true true
  const nullProto: any = Object.create(null);
  const nullChild: any = Object.create(nullProto);
  console.log(ipo.call(nullProto, nullChild), ipo.call(Object.prototype, nullProto)); // true false
  console.log(ipo.call(o, 1), ipo.call(1, child)); // false false

  console.log(o.propertyIsEnumerable("a"), o.propertyIsEnumerable("hidden"), o.propertyIsEnumerable("shown")); // true false true
  console.log(pie.call([10, 20], "0"), pie.call([10, 20], "length")); // true false
  console.log(pie.call("ab", "0"), pie.call("ab", "length")); // true false
  console.log(pie.call(reflected, "length"), pie.call(reflected, "name")); // false false

  class C {
    x = 1;
  }
  const c = new C();
  console.log(c.propertyIsEnumerable("x"), c.propertyIsEnumerable("toString")); // true false

  const dynPie: any = "propertyIsEnumerable";
  const dynIpo: any = "isPrototypeOf";
  console.log(o[dynPie]("shown"), o[dynIpo](child)); // true true

  const boundPie = pie.bind(o);
  console.log(boundPie("a"), boundPie("hidden")); // true false

  const shadow: any = { propertyIsEnumerable: "own", isPrototypeOf: 9, toLocaleString: "local" };
  console.log(shadow.propertyIsEnumerable, shadow.isPrototypeOf, shadow.toLocaleString); // own 9 local

  console.log("toLocaleString" in o, "isPrototypeOf" in o, "propertyIsEnumerable" in o); // true true true
}

main();

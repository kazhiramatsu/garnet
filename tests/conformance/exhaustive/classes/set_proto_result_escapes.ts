// `Object.setPrototypeOf` returns its object: an instance made and relinked in a function leaves it
// through the result, so it must not stay in the function's frame (the escape analysis saw no link
// from the result to the object, and read a dead stack slot).
class C {
  a = 7.75;
  s = "x";
}
function detached(): C {
  return Object.setPrototypeOf(new C(), null);
}
function rebased(p: object): C {
  const o = Object.setPrototypeOf(new C(), p);
  return o;
}
const a = detached();
const b = detached();
const junk = [1, 2, 3].map((x) => x * 2);
console.log(Object.keys(a).join(), Object.keys(b).join(), junk.length);
const base = { hello(): string { return "hi"; } };
const r = rebased(base) as any;
const r2 = rebased(base) as any;
console.log(r.hello(), r.a, r2.s, Object.getPrototypeOf(r) === base);

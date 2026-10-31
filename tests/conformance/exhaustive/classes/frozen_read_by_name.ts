// A freezer read as a value off something that holds `Object`, with nothing else in the program that
// freezes: `({}).constructor` needs no load of the global, and the name is a read, not a call. Typed
// stores must still test the bit (`may_freeze_instances_init`); a static Object.freeze in this file
// would turn the tests on and hide the case, so this fixture has none.
interface H {
  v: number;
  s: string;
}
class A implements H {
  v = 1.5;
  s = "a";
}
function viaInterface(h: H): void {
  h.v = 9;
  h.s = "z";
}
function viaClass(a: A): void {
  a.v = 7;
  a.s = "y";
}
const O: any = ({}).constructor;
const fz = O.freeze;
const a = new A();
fz(a);
for (const write of [viaInterface, viaClass]) {
  try {
    (write as any)(a);
    console.log("no throw", a.v, a.s);
  } catch (e) {
    console.log((e as Error).constructor.name, a.v, a.s);
  }
}
const b = new A();
viaInterface(b);
viaClass(b);
console.log(b.v, b.s);

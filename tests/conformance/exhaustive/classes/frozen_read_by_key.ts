// As frozen_read_by_name, with the key a string the program spells out.
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
const a = new A();
O["freeze"](a);
for (const write of [viaInterface, viaClass]) {
  try {
    (write as any)(a);
    console.log("no throw", a.v, a.s);
  } catch (e) {
    console.log((e as Error).constructor.name, a.v, a.s);
  }
}

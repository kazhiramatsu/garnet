// An import cycle where the module initialized FIRST (b) reads a class of the module initialized second
// (a) in an instance field's initializer: construction runs after both modules finished, like a function
// body (vue's ComputedRefImpl: `readonly dep: Dep = new Dep(this)` with dep.ts importing computed.ts).
import { B } from "./b";
export class A {
  tag = "A";
  make(): B { return new B(this); }
}

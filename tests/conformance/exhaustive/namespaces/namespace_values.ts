// TypeScript `namespace` value support. A namespace lowers to a runtime object
// (the IIFE pattern `var N = {}; N.f = f; ...`): exported members become object
// properties, non-exported members are private (still reachable by exported
// closures). A namespace merged with a same-named class installs its exported
// members on the class's static container so `X.member` resolves.

// standalone: exported function + const, and a private member referenced by an
// exported closure.
namespace Util {
  const SCALE = 10; // private
  export const LABEL = "util";
  export function scale(n: number): number { return n * SCALE; }
  export function addOne(n: number): number { return n + 1; }
}

// internal cross-reference between exported members.
namespace Calc {
  export function viaB(): number { return b() + 1; }
  export function b(): number { return 41; }
}

// nested namespaces.
namespace Outer {
  export namespace Inner {
    export const DEPTH = 2;
    export function tag(): string { return "inner"; }
  }
}

// exported enum + class members; construct a namespace class via `N.Cls`.
namespace Geo {
  export enum Kind { Point, Line }
  export class Vec2 {
    constructor(public x: number, public y: number) {}
    len2(): number { return this.x * this.x + this.y * this.y; }
  }
  export function add(a: Vec2, b: Vec2): Vec2 { return new Vec2(a.x + b.x, a.y + b.y); }
}

// repeated `namespace N {}` declarations merge into one object.
namespace Merged { export const a = 1; }
namespace Merged { export const b = 2; }

// class + namespace merge: exported members install as statics on the class.
class Model {
  constructor(public id: number) {}
  describe(): string { return "model#" + this.id; }
}
namespace Model {
  export const VERSION = "1.0";
  export function fromId(id: number): Model { return new Model(id); }
}

// class with its own static + a merged namespace member coexist.
class Box {
  static EMPTY = 0;
  constructor(public v: number) {}
}
namespace Box {
  export function of(v: number): Box { return new Box(v); }
}

function main(): void {
  console.log(Util.scale(5), Util.addOne(9), Util.LABEL); // 50 10 util
  console.log(Calc.viaB()); // 42
  console.log(Outer.Inner.DEPTH, Outer.Inner.tag()); // 2 inner

  const v = Geo.add(new Geo.Vec2(1, 2), new Geo.Vec2(3, 4));
  console.log(v.x, v.y, v.len2(), Geo.Kind.Line); // 4 6 52 1

  console.log(Merged.a, Merged.b); // 1 2

  console.log(Model.VERSION, Model.fromId(7).describe()); // 1.0 model#7
  console.log(Box.EMPTY, Box.of(3).v); // 0 3

  // a namespace member referenced as a first-class value.
  const f = Util.scale;
  console.log(f(4)); // 40
}
main();

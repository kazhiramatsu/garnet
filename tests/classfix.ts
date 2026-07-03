// --- stable hierarchy ---
class Shape {
  id: number;
  constructor(id: number) { this.id = id; }
  area(): number { return 0; }
  describe(): string { return "shape"; }
}
class Circle extends Shape {
  radius: number;
  constructor(r: number) { super(r); this.radius = r; }
  area(): number { return 3.14 * this.radius * this.radius; }   // override
  scale(k: number): void { this.radius = this.radius * k; }      // new method
  get diameter(): number { return this.radius * 2; }             // getter
}
class Square extends Shape {
  side: number;
  constructor(s: number) { super(s); this.side = s; }
  area(): number { return this.side * this.side; }               // override
}
const c = new Circle(2);
const sq = new Square(3);
const shapes: Shape[] = [c, sq];
let t = 0;
for (const s of shapes) t = t + s.area();

// --- unstable: prototype mutation ---
class Patched { f(): number { return 1; } }
(Patched.prototype as any).f = function () { return 2; };
const pp = new Patched();

// --- unstable: method reassignment on an instance ---
class Reassigned { g(): number { return 1; } }
const r = new Reassigned();
(r as any).g = () => 2;

// --- unstable: dynamic property write (undeclared) ---
class Grown { x: number; constructor() { this.x = 1; } }
const g = new Grown();
(g as any).y = 5;

// --- unstable: setPrototypeOf ---
class Reproto { h(): number { return 1; } }
const rp = new Reproto();
Object.setPrototypeOf(rp, {});

// --- unstable: mixin (extends expression) ---
function mixin<T>(base: any) { return class extends base {}; }

// An `abstract` property emits nothing: a subclass implements it with a field of its own or an accessor
// on its prototype, and a slot in the base hid the accessor. `this.w = v` in a constructor with an
// accessor `w` runs the setter and adds no field. A class instance on a prototype chain answers its fields.
abstract class Shape {
  abstract readonly kind: string;
  abstract area: number;
  name = "shape";
  describe(): string {
    return this.kind + ":" + this.area + ":" + this.name;
  }
  grow(by: number): void {
    this.area = this.area + by;
  }
}
class Circle extends Shape {
  r = 2;
  get kind(): string {
    return "circle";
  }
  get area(): number {
    return this.r * 10;
  }
  set area(v: number) {
    this.r = v / 10;
  }
}
class Square extends Shape {
  kind = "square";
  area = 4;
}
class Late extends Shape {
  z = 1;
  area = 9;
  kind = "late";
}
const shapes: Shape[] = [new Circle(), new Square(), new Late()];
for (const s of shapes) {
  s.grow(1);
  console.log(s.describe(), s.kind, s.area, Object.keys(s).join());
}
const held: Shape = new Circle();
console.log(held.kind, held.area);
function kindOf(s: Shape): string {
  return s.kind;
}
const onlyHere = new Circle();
console.log(kindOf(onlyHere), onlyHere.describe());

// the receiver has no field the inlined method reads: it stays an object
abstract class Tag {
  abstract readonly label: string;
  text(): string {
    return "<" + this.label + ">";
  }
}
class Bold extends Tag {
  get label(): string {
    return "b";
  }
}
class Plain extends Tag {
  label = "p";
}
console.log(new Bold().text(), new Plain().text());

class P {
  backing = 1;
  get w(): number {
    return this.backing;
  }
  set w(n: number) {
    this.backing = n + 1;
  }
}
class C extends P {
  constructor() {
    super();
    this.w = 10;
  }
}
const c = new C();
console.log(c.w, c.backing, Object.keys(c).join(), JSON.stringify(c));
class Own {
  #x = 0;
  log: string[] = [];
  get v(): number {
    return this.#x;
  }
  set v(n: number) {
    this.log.push("set " + n);
    this.#x = n * 2;
  }
  constructor() {
    this.v = 5;
  }
}
const own = new Own();
console.log(own.v, own.log.join(), Object.keys(own).join());

class K {
  field = 7;
  num = 1.5;
  method(): string {
    return "m" + this.field;
  }
}
const protoK = new K();
const child = Object.create(protoK);
console.log(child.field, child.num, child.method(), "field" in child, child.hasOwnProperty("field"));
child.field = 8;
console.log(child.field, protoK.field, child.hasOwnProperty("field"), child.method());
const keys: string[] = [];
for (const k in Object.create(protoK)) keys.push(k);
console.log(keys.join());
protoK.field = 9;
const grandchild = Object.create(Object.create(protoK));
console.log(grandchild.field, grandchild.num);

// A method returning `this` (fluent/builder pattern): the returned value aliases
// the receiver, so field reads through it must see the receiver's real state.
class Builder {
  v = 0;
  add(n: number): this { this.v += n; return this; }
  mul(n: number): this { this.v *= n; return this; }
}

class Box {
  v = 0;
  self(): Box { const me = this; return me; }   // returns this via a copy
  set(n: number): void { this.v = n; }
}

function main(): void {
  // single call: r aliases b.
  const b = new Builder();
  const r = b.add(5);
  console.log(r.v, b.v);              // 5 5

  // chaining accumulates on the same instance.
  const c = new Builder();
  c.add(1).add(2).add(3);
  console.log(c.v);                   // 6

  const d = new Builder();
  d.add(10).mul(3).add(1);
  console.log(d.v);                   // 31

  // returning this via a local copy still aliases the receiver.
  const box = new Box();
  box.self().set(9);
  console.log(box.v);                 // 9
}

main();

// Each built-in Error prototype wires `constructor` back to its constructor
// value (mirroring Function.prototype.constructor), so `new TypeError().
// constructor` is `TypeError` and `.constructor.name` is "TypeError" — not
// "Object" inherited from Object.prototype. The property is non-own (lives on
// the prototype) and does not perturb instanceof / name / message / toString.
class MyErr extends Error {
  constructor(m: string) {
    super(m);
    this.name = "MyErr";
  }
}

function main(): void {
  // constructor.name for each kind
  console.log(new Error().constructor.name);
  console.log(new TypeError().constructor.name);
  console.log(new RangeError().constructor.name);
  console.log(new SyntaxError().constructor.name);
  console.log(new ReferenceError().constructor.name);

  // identity: e.constructor === <Ctor>
  console.log(new TypeError().constructor === TypeError);
  console.log(new Error().constructor === Error);
  console.log(new RangeError().constructor === RangeError);

  // a runtime-thrown built-in error has the right constructor too
  try {
    const a: any = [];
    a.length = -1;
  } catch (e: any) {
    console.log(e.constructor.name);
  }
  try {
    const x: any = null;
    x.foo;
  } catch (e: any) {
    console.log(e.constructor.name);
  }

  // constructor is non-own (on the prototype)
  const te = new TypeError("boom");
  console.log(te.hasOwnProperty("constructor"), Object.keys(te).length);

  // existing Error semantics unchanged
  console.log(te instanceof TypeError, te instanceof Error);
  console.log(te.name, te.message, String(te));

  // user subclass: its prototype's constructor is the subclass
  const my = new MyErr("oops");
  console.log(my.constructor.name, my instanceof Error, my.message);
}
main();

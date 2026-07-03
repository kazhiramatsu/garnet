// Built-in class names (Map, Set, Array, Error, Promise, Date, ...) are ORDINARY
// identifiers, not reserved words. A user class declared with such a name shadows the
// built-in within its scope, so `new Map()` etc. must construct the USER class and its
// methods/fields are the user's — resolved by lexical scope (the TS checker), not by
// matching the name text. (Previously `new`/method-dispatch keyed on the name, so a
// user `class Map {}` was mis-built as the runtime Map container — a silent miscompile.
// The genuine built-in, where no user binding shadows it, is unaffected.)

function shadowMap(): number {
  class Map {
    x = 5;
    doubled(): number {
      return this.x * 2;
    }
  }
  const m = new Map();
  return m.x + m.doubled();
}

function shadowError(): string {
  class Error {
    tag = "user-error";
    label(): string {
      return this.tag;
    }
  }
  const e = new Error();
  return e.label();
}

function shadowArrayWithInheritance(): number {
  class Base {
    b = 100;
  }
  class Array extends Base {
    a = 7;
    sum(): number {
      return this.a + this.b;
    }
  }
  const x = new Array();
  return x.sum();
}

function shadowPromise(): number {
  class Promise {
    v = 42;
  }
  return new Promise().v;
}

// A genuine built-in used in a DIFFERENT scope must still work (scope separation).
function realMap(): number {
  const m = new Map<string, number>();
  m.set("k", 9);
  m.set("j", 4);
  return (m.get("k") ?? 0) + m.size;
}
function realSet(): number {
  const s = new Set<number>();
  s.add(1);
  s.add(1);
  s.add(2);
  return s.size;
}

function main(): void {
  console.log(shadowMap()); // 15
  console.log(shadowError()); // user-error
  console.log(shadowArrayWithInheritance()); // 107
  console.log(shadowPromise()); // 42
  console.log(realMap()); // 11
  console.log(realSet()); // 2

  // genuine built-ins inline alongside the shadowing functions above
  const a = [3, 1, 2];
  console.log(a.slice().sort((x, y) => x - y).join(",")); // 1,2,3
  try {
    throw new Error("boom");
  } catch (e: any) {
    console.log(e.message); // boom
  }
}

main();

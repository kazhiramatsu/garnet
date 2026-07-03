// `extends X` resolves X by normal lexical (outer-scope) name resolution, NOT by a
// global name table. Same-named classes declared in different scopes are distinct, so
// each `extends P` must bind to the `P` visible in its own scope. (Previously the
// parent was resolved by NAME, so a second same-named `P` mis-bound the inheritance —
// a silent miscompile.) Covers the inheritance paths driven by parent resolution:
// methods, fields, super, static members, generator methods, and builtin-vs-user
// `extends Error` disambiguation.

function methodScope1(): number {
  class P {
    p(): number {
      return 1;
    }
  }
  class C extends P {}
  return new C().p();
}
function methodScope2(): number {
  class P {
    p(): number {
      return 2;
    }
  }
  class C extends P {}
  return new C().p();
}

function fieldScope1(): number {
  class P {
    v = 10;
  }
  class C extends P {}
  return new C().v;
}
function fieldScope2(): number {
  class P {
    v = 20;
  }
  class C extends P {}
  return new C().v;
}

function superScope1(): string {
  class P {
    g(): string {
      return "P1";
    }
  }
  class C extends P {
    g(): string {
      return super.g() + ":C1";
    }
  }
  return new C().g();
}
function superScope2(): string {
  class P {
    g(): string {
      return "P2";
    }
  }
  class C extends P {
    g(): string {
      return super.g() + ":C2";
    }
  }
  return new C().g();
}

function staticScope1(): string {
  class P {
    static sv = 10;
    static sm(): number {
      return 1;
    }
  }
  class C extends P {}
  return `${C.sv},${C.sm()}`;
}
function staticScope2(): string {
  class P {
    static sv = 20;
    static sm(): number {
      return 2;
    }
  }
  class C extends P {}
  return `${C.sv},${C.sm()}`;
}

function genScope1(): string {
  class P {
    *g(): Generator<number> {
      yield 1;
      yield 2;
    }
  }
  class C extends P {}
  return [...new C().g()].join(",");
}
function genScope2(): string {
  class P {
    *g(): Generator<number> {
      yield 9;
    }
  }
  class C extends P {}
  return [...new C().g()].join(",");
}

// `extends Error`: a USER class named Error in scope shadows the builtin, so the
// subclass inherits the user Error (lexical resolution). A separate scope with no such
// shadow extends the genuine builtin Error.
function userErrorScope(): string {
  class Error {
    tag = "user";
    greet(): string {
      return this.tag;
    }
  }
  class C extends Error {}
  return new C().greet();
}
function builtinErrorScope(): string {
  class E extends Error {
    constructor(m: string) {
      super(m);
    }
  }
  try {
    throw new E("boom");
  } catch (e: any) {
    return e.message;
  }
}

function main(): void {
  console.log(methodScope1(), methodScope2()); // 1 2
  console.log(fieldScope1(), fieldScope2()); // 10 20
  console.log(superScope1(), superScope2()); // P1:C1 P2:C2
  console.log(staticScope1(), staticScope2()); // 10,1 20,2
  console.log(genScope1(), genScope2()); // 1,2 9
  console.log(userErrorScope()); // user
  console.log(builtinErrorScope()); // boom
}

main();

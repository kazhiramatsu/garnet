class BaseReflect {
  m(): number {
    return 1;
  }

  get x(): number {
    return 2;
  }

  set x(v: number) {
    void v;
  }
}

class ChildReflect extends BaseReflect {
  n(): number {
    return 3;
  }
}

class StaticReflect {
  static value = 10;

  static own(): number {
    return 11;
  }
}

class ComputedReflect {
  ["lit"](): number {
    return 5;
  }

  [10](): number {
    return 6;
  }

  #hidden(): number {
    return 7;
  }

  [Symbol.iterator](): IterableIterator<number> {
    return [][Symbol.iterator]();
  }

  visibleHidden(): number {
    return this.#hidden();
  }
}

function main(): void {
  const B: any = BaseReflect;
  console.log(B.prototype.constructor === B);
  console.log(Object.getOwnPropertyNames(B.prototype).join(","));
  console.log(Object.keys(B.prototype).join(","));

  const cd: any = Object.getOwnPropertyDescriptor(B.prototype, "constructor");
  const md: any = Object.getOwnPropertyDescriptor(B.prototype, "m");
  const xd: any = Object.getOwnPropertyDescriptor(B.prototype, "x");
  console.log(cd.writable, cd.enumerable, cd.configurable, cd.value === B);
  console.log(typeof md.value, md.writable, md.enumerable, md.configurable);
  console.log(typeof xd.get, typeof xd.set, xd.enumerable, xd.configurable);

  const Child: any = ChildReflect;
  console.log(Object.getPrototypeOf(Child.prototype) === B.prototype);
  console.log(Object.getOwnPropertyNames(Child.prototype).join(","));
  console.log(new ChildReflect().constructor === Child, new ChildReflect().m(), new ChildReflect().n());

  const S: any = StaticReflect;
  console.log(S.constructor === Function, Object.hasOwn(S, "constructor"));
  console.log(S.value, S.own());

  const C: any = ComputedReflect;
  console.log(Object.getOwnPropertyNames(C.prototype).join(","));
  console.log(typeof C.prototype.lit, typeof C.prototype[10], "#hidden" in C.prototype, "@@iterator" in C.prototype);
  console.log(new ComputedReflect().visibleHidden());

  B.prototype.constructor = 123;
  B.prototype.m = function (): number {
    return 9;
  };
  const b: any = new BaseReflect();
  console.log(b.constructor, b.m());
  console.log(Object.getOwnPropertyNames(B.prototype).join(","));
}

main();

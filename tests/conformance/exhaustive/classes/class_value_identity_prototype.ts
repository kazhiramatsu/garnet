class ProtoOnly {
  m(): number {
    return 1;
  }
}

class StaticNames {
  static x = 1;
  static m(): number {
    return 2;
  }
  static y = 3;
  static get z(): number {
    return 4;
  }
}

class ParentStatic {
  static base = 10;
  static pb(): number {
    return 11;
  }
}

class ChildStatic extends ParentStatic {}

function innerClassCheck(): string {
  class Inner {
    static v = 5;
    m(): number {
      return 1;
    }
  }
  const K: any = Inner;
  return [
    Inner === Inner,
    K === Inner,
    Inner.prototype === K.prototype,
    Object.getOwnPropertyNames(Inner).join(","),
  ].join(":");
}

function main(): void {
  const C: any = ProtoOnly;
  console.log(C === C, C.prototype === C.prototype, Object.hasOwn(C, "prototype"));

  const dp = Object.getOwnPropertyDescriptor(C, "prototype");
  console.log(typeof C.prototype, dp.value === C.prototype, dp.writable, dp.enumerable, dp.configurable);
  console.log(Object.getOwnPropertyNames(C).join(","));

  const S: any = StaticNames;
  console.log(Object.getOwnPropertyNames(StaticNames).join(","));
  console.log(Object.keys(StaticNames).join(","));
  console.log(S.m(), S.z);

  const Child: any = ChildStatic;
  console.log(Child.base, Child.pb());
  console.log(Object.getOwnPropertyNames(ChildStatic).join(","));
  console.log(Object.keys(ChildStatic).join(","));

  console.log(innerClassCheck());
}

main();

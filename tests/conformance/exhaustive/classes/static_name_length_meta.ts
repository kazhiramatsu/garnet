class StaticMeta {
  static y = 1;
}

class StaticReadsOwnName {
  static x = StaticReadsOwnName.name;
  static m(): string {
    return StaticReadsOwnName.name;
  }
  static {
    console.log(StaticReadsOwnName.name);
  }
}

class StaticReadsLength {
  static x = StaticReadsLength.length;
  constructor(_a: any, _b: any) {}
}

// NOTE: a `static name = 7` field, under ES2020 transpilation + ESM strict mode,
// becomes an ASSIGNMENT to the constructor's non-writable `name` and throws at
// class-definition time (uncaught) — intentionally not exercised here (it can't
// be wrapped in try/catch at class-declaration scope).

class StaticNameMethod {
  static name(): number {
    return 9;
  }
}

class StaticMetaBase {
  constructor(_a: any, _b: any, _c: any) {}
  static who(): string {
    return this.name;
  }
}

class StaticMetaChild extends StaticMetaBase {
  static parentName = super.name;
  static parentLength = super.length;
  static parentNameMethod(): string {
    return super.name;
  }
  static parentLengthMethod(): number {
    return super.length;
  }
}

function main(): void {
  console.log(StaticMeta.name);
  console.log(StaticMeta.length);
  console.log(StaticMeta.y);

  console.log(StaticReadsOwnName.x);
  console.log(StaticReadsOwnName.m());

  console.log(StaticReadsLength.x, StaticReadsLength.length);

  console.log(StaticNameMethod.name());

  console.log(StaticMetaBase.who(), StaticMetaChild.who());
  console.log(StaticMetaChild.parentName, StaticMetaChild.parentNameMethod());
  console.log(StaticMetaChild.parentLength, StaticMetaChild.parentLengthMethod());
}

main();

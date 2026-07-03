class StaticReflectBase {
  static base = 1;
  static bm(): number {
    return 7;
  }
}

class StaticReflect extends StaticReflectBase {
  static x = 2;
  static m(): number {
    return this.x + 1;
  }
  static get y(): number {
    return this.x + 2;
  }
}

class StaticReflectName {
  static name(): number {
    return 9;
  }
}

class StaticOnly {
  static x = 1;
  y = 2;
}

function main(): void {
  const K: any = StaticReflect;

  console.log(StaticReflect.m(), K.m()); // 3 3
  console.log(StaticReflect.y, K.y); // 4 4

  const dx = Object.getOwnPropertyDescriptor(StaticReflect, "x");
  const dm = Object.getOwnPropertyDescriptor(StaticReflect, "m");
  const dy = Object.getOwnPropertyDescriptor(StaticReflect, "y");
  const dn = Object.getOwnPropertyDescriptor(StaticReflect, "name");
  console.log(dx.value, dx.enumerable, dx.writable, dx.configurable); // 2 true true true
  console.log(typeof dm.value, dm.enumerable, dm.writable, dm.configurable); // function false true true
  console.log(typeof dy.get, typeof dy.set, dy.enumerable, dy.configurable); // function undefined false true
  console.log(dn.value, dn.enumerable, dn.writable, dn.configurable); // StaticReflect false false true

  console.log(Object.keys(StaticReflect).join(",")); // x
  console.log(Object.values(StaticReflect).join(",")); // 2
  console.log(Object.entries(StaticReflect)[0].join(":")); // x:2
  const copied = Object.assign({}, StaticReflect) as any;
  console.log(copied.x, Object.keys(copied).join(",")); // 2 x

  console.log(StaticReflect.base, StaticReflect.bm()); // 1 7
  console.log(Object.hasOwn(StaticReflect, "base"), Object.hasOwn(StaticReflect, "x")); // false true
  console.log(Object.getOwnPropertyDescriptor(StaticReflect, "base") === undefined); // true

  console.log(typeof StaticReflectName.name, StaticReflectName.name()); // function 9
  const KN: any = StaticReflectName;
  console.log(typeof KN.name, KN.name()); // function 9

  K.z = 5;
  console.log(K.z, (StaticReflect as any).z, Object.keys(K).join(",")); // 5 5 x,z

  const inst: any = new StaticOnly();
  console.log(inst.x, inst.y, Object.keys(inst).join(",")); // undefined 2 y
}

main();

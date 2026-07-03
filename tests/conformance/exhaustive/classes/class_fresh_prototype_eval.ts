function makeFreshClass() {
  class Local {
    m(): number {
      return 1;
    }
  }
  return Local;
}

function makeConstructed() {
  class Constructed {
    value = 7;
  }
  const inst = new Constructed();
  return { Constructed, inst };
}

function makeFreshPair() {
  class Base {
    base(): number {
      return 11;
    }
  }

  class Child extends Base {
    child(): number {
      return 22;
    }
  }

  const child = new Child();
  return { Base, Child, child };
}

function main(): void {
  const A = makeFreshClass();
  const B = makeFreshClass();

  console.log(A === A, A === B);
  console.log(A.prototype === A.prototype, A.prototype === B.prototype);
  console.log(A.prototype.constructor === A, B.prototype.constructor === B, A.prototype.constructor === B);

  const ai = new A();
  const bi = new B();
  console.log(Object.getPrototypeOf(ai) === A.prototype, Object.getPrototypeOf(ai) === B.prototype);
  console.log(ai.constructor === A, bi.constructor === B);

  A.prototype.m = function (): number {
    return 10;
  };
  B.prototype.m = function (): number {
    return 20;
  };
  console.log(new A().m(), new B().m());
  console.log(new A() instanceof A, new A() instanceof B, new B() instanceof B);

  const ca = makeConstructed();
  const cb = makeConstructed();
  console.log(Object.getPrototypeOf(ca.inst) === ca.Constructed.prototype, Object.getPrototypeOf(ca.inst) === cb.Constructed.prototype);
  console.log(ca.inst.constructor === ca.Constructed, cb.inst.constructor === cb.Constructed);

  const p1 = makeFreshPair();
  const p2 = makeFreshPair();
  const Base1 = p1.Base;
  const Child1 = p1.Child;
  const Base2 = p2.Base;
  const Child2 = p2.Child;

  console.log(Base1.prototype === Base2.prototype, Child1.prototype === Child2.prototype);
  console.log(Object.getPrototypeOf(Child1.prototype) === Base1.prototype, Object.getPrototypeOf(Child1.prototype) === Base2.prototype);
  console.log(p1.child instanceof Child1, p1.child instanceof Base1, p1.child instanceof Base2);
  console.log(p2.child instanceof Child2, p2.child instanceof Base2, p2.child instanceof Base1);
  console.log(p1.child.base(), p1.child.child(), p2.child.base(), p2.child.child());
}

main();

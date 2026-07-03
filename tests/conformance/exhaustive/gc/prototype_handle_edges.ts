function churn(n: number): number {
  let i = 0;
  let sum = 0;
  while (i < n) {
    const a: any = { v: i };
    sum = sum + a.v;
    i = i + 1;
  }
  return sum;
}

class Base {
  value(): number {
    return 11;
  }
}

class Derived extends Base {
  own(): number {
    return 22;
  }
}

const g: any = globalThis;

const proto: any = { p: 5 };
const child: any = Object.create(proto);
g.__proto_child = child;
churn(70000);
console.log(Object.getPrototypeOf(child) === proto, child.p);

const oldObj: any = { local: 1 };
g.__old_proto_owner = oldObj;
churn(70000);
const youngProto: any = {
  inherited: 41,
  method: function(): number {
    return 42;
  }
};
Object.setPrototypeOf(oldObj, youngProto);
churn(70000);
console.log(oldObj.local, oldObj.inherited, oldObj.method(), Object.getPrototypeOf(oldObj) === youngProto);

const d: any = new Derived();
g.__derived_instance = d;
churn(70000);
console.log(d instanceof Derived, d instanceof Base, d.value(), d.own());

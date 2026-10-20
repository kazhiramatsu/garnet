// Reflect.set(target, key, value, receiver) with a proxy as the receiver: the
// value lands through the receiver's [[GetOwnProperty]] and
// [[DefineOwnProperty]] (its getOwnPropertyDescriptor and defineProperty
// traps), not its [[Set]], so a set trap that forwards its own receiver does
// not call itself.

class Point {
  x = 1;
  y = 2;
}

function main(): void {
  const log: string[] = [];

  // the forwarding set trap (the usual logging / validation proxy)
  const p = new Proxy(new Point(), {
    set(target: Point, key: string | symbol, value: unknown, receiver: unknown): boolean {
      log.push("set " + String(key));
      return Reflect.set(target, key, value, receiver);
    },
  }) as Point;
  p.x = 5;
  p.y = p.x + 1;
  console.log(p.x, p.y, log.join(","));

  // the receiver's defineProperty trap sees the update ({ value } only) and,
  // for a new key, a full data descriptor
  const seen: string[] = [];
  const recv = new Proxy({ a: 1 } as Record<string, number>, {
    defineProperty(target: Record<string, number>, key: string | symbol, desc: PropertyDescriptor): boolean {
      seen.push(String(key) + ":" + JSON.stringify(desc));
      return Reflect.defineProperty(target, key, desc);
    },
  });
  const plain: Record<string, number> = { a: 0 };
  console.log(Reflect.set(plain, "a", 10, recv), Reflect.set(plain, "b", 20, recv));
  console.log(JSON.stringify(recv), plain.a, seen.join(" | "));

  // an existing non-writable property on the receiver: false, nothing defined
  const frozenTarget: Record<string, number> = {};
  Object.defineProperty(frozenTarget, "k", { value: 3, writable: false, configurable: true });
  const fr = new Proxy(frozenTarget, {});
  console.log(Reflect.set({ k: 0 } as Record<string, number>, "k", 9, fr), frozenTarget.k);

  // an accessor reported by getOwnPropertyDescriptor: false
  const acc = new Proxy({ q: 1 } as Record<string, number>, {
    getOwnPropertyDescriptor(): PropertyDescriptor {
      return { get: () => 7, configurable: true, enumerable: true };
    },
  });
  console.log(Reflect.set({ q: 0 } as Record<string, number>, "q", 9, acc));

  // a setter on the target's chain is called with the proxy receiver as this
  const withSetter = {
    stored: 0,
    set v(n: number) {
      (this as { stored: number }).stored = n * 2;
    },
  };
  const wr = new Proxy({ stored: 0 } as { stored: number }, {});
  Reflect.set(withSetter, "v", 4, wr);
  console.log(wr.stored, withSetter.stored);
}
main();

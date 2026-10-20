// A Proxy that has been promoted is referenced in the old-pointer form; a full
// collection must mark it through that form (it used to skip the proxy kind
// and free the live cell, so later traps read freed memory).

class Point {
  x = 1;
  y = 2;
}

let traps = 0;

function churn(rounds: number): number {
  // keep cells alive across minor collections so they are promoted, then drop
  // them: old garbage grows until a full collection runs
  const ring: unknown[][] = [];
  let made = 0;
  for (let r = 0; r < rounds; r++) {
    const batch: unknown[] = [];
    for (let i = 0; i < 200; i++) batch.push({ r, i, s: "c" + i });
    made += batch.length;
    ring.push(batch);
    if (ring.length > 30) ring.shift();
  }
  return made;
}

function readBoth(p: Point): number {
  return p.x * 10 + p.y;
}

function main(): void {
  const handler: ProxyHandler<Point> = {
    get(target: Point, key: string | symbol, receiver: unknown): unknown {
      traps++;
      return Reflect.get(target, key, receiver);
    },
    set(target: Point, key: string | symbol, value: unknown): boolean {
      traps++;
      return Reflect.set(target, key, value);
    },
  };
  const proxied = new Proxy(new Point(), handler) as Point;
  const plainProxy = new Proxy({ tag: "plain" } as { tag: string }, {});
  const results: string[] = [];
  for (let round = 0; round < 6; round++) {
    const made = churn(400);
    proxied.x = proxied.x + 1;
    results.push(round + ": " + made + " " + readBoth(proxied) + " " + plainProxy.tag);
  }
  results.push("traps " + traps);
  for (const r of results) console.log(r);
}
main();

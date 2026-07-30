const dynamicName = "dynamic";

function main(): void {
  const base = { spreadA: 1, overridden: 2 };
  const shorthand = 3;
  const sym = Symbol("member");
  const obj: any = {
    plain: 4,
    "quoted-name": 5,
    6: 6,
    shorthand,
    [dynamicName]: 7,
    ...base,
    overridden: 8,
    method(x: number): number { return this.plain + x; },
    get doubled(): number { return this.plain * 2; },
    set doubled(v: number) { this.plain = v / 2; },
    [sym]: 9,
  };

  console.log(
    obj.plain,
    obj["quoted-name"],
    obj[6],
    obj.shorthand,
    obj.dynamic,
    obj.spreadA,
    obj.overridden,
  );
  console.log(obj.method(10), obj.doubled, obj[sym]);
  obj.doubled = 30;
  console.log(obj.plain, obj.doubled);

  const sparse = [1, , 3];
  const spread = [0, ...sparse, 4,];
  console.log(sparse.length, 1 in sparse, spread.length, spread.join(","));

  const nested: [{ a: number }, { b: number[] }] = [{ a: 1 }, { b: [2, 3] }];
  console.log(nested[0].a, nested[1].b[1]);
}

main();

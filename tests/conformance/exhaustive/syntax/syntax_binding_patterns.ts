function parameterPatterns(
  [first, , third = 30, ...tail]: number[],
  { a: renamed, b = 20, ...rest }: any,
): string {
  return [first, third, tail.join("-"), renamed, b, rest.c].join("|");
}

function main(): void {
  const [a, , b = 9, ...tail] = [1, 2, undefined, 4, 5];
  console.log(a, b, tail.join(","));

  const source: any = { x: 10, y: undefined, z: 30, extra: 40 };
  const { x: renamed, y = 20, z, ...remaining } = source;
  console.log(renamed, y, z, remaining.extra);

  const nested: any = { p: [7, { q: 8 }] };
  const { p: [n1, { q: n2 }] } = nested;
  console.log(n1, n2);

  let assignA = 0;
  let assignB = 0;
  [assignA, assignB] = [11, 12];
  let objectA = 0;
  let objectB = 0;
  ({ a: objectA, b: objectB } = { a: 13, b: 14 });
  console.log(assignA, assignB, objectA, objectB);

  const dynamicKey = "picked";
  const { [dynamicKey]: picked } = { picked: 15 };
  console.log(picked);

  console.log(parameterPatterns(
    [1, 2, undefined as any, 4, 5],
    { a: 6, c: 7 },
  ));

  const pairs = [[1, 2], [3, 4]];
  let sum = 0;
  for (const [left, right] of pairs) sum += left + right;
  console.log(sum);
}

main();

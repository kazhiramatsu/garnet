function main(): void {
  console.log(Math.f16round(1), Math.f16round(1.337), Math.f16round(-1.337));
  console.log(Math.f16round(1 + 2 ** -11), Math.f16round(1 + 3 * 2 ** -11));
  console.log(Math.f16round(2 ** -24) * 2 ** 24, Math.f16round(2 ** -25), Math.f16round((2 ** -25) * (1 + 2 ** -52)) * 2 ** 24);
  console.log(Math.f16round(-(2 ** -25)), 1 / Math.f16round(-(2 ** -25)), Object.is(Math.f16round(-(2 ** -25)), -0));
  console.log(Math.f16round(-(2 ** -24)) * 2 ** 24, 1 / Math.f16round(-(2 ** -24)));
  console.log(Math.f16round(65504), Math.f16round(65519), Math.f16round(65520), Math.f16round(70000));
  console.log(Math.f16round(NaN), Math.f16round(Infinity), Math.f16round(-Infinity));
  console.log(Math.f16round("1.5" as any), Math.f16round(true as any), Math.f16round(null as any), Math.f16round(undefined as any));

  const f16round = Math.f16round;
  console.log(f16round(1.337), f16round.length, typeof f16round);
}

main();

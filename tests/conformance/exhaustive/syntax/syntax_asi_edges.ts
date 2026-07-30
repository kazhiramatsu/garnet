function newlineReturn(): { value: number } | undefined {
  return
  { value: 1 };
}

function main(): void {
  let value = 1
  value
  ++value
  console.log(value);

  let guarded = 2
  ;(guarded as number)
  console.log(guarded, newlineReturn());

  const call = function (x: number): number { return x + 1 }
  console.log(call
  (4));
}

main();

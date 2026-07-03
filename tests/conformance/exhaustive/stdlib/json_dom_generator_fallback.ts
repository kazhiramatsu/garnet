function* counts(text: string): Generator<number> {
  const root: any = JSON.parse(text);
  yield root.x;
  yield root.items.length;
}

function main(): void {
  let total = 0;
  for (const n of counts("{\"x\":7,\"items\":[1,2,3,4]}")) total = total + n;
  console.log(total);
}

main();

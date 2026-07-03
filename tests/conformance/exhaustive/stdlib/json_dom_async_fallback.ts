async function readCount(text: string): Promise<number> {
  const root: any = JSON.parse(text);
  return root.x + root.items.length;
}

async function main(): Promise<void> {
  console.log(await readCount("{\"x\":5,\"items\":[1,2,3]}"));
}

main();

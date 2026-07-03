function main(): void {
  const first = "{\"x\":1,\"arr\":[10],\"dup\":{\"old\":[1,2]},\"dup\":{\"old\":[3]}}";
  const second = "{\"x\":2,\"arr\":[20]}";
  let root: any = JSON.parse(first);
  const alias: any = root;
  root = JSON.parse(second);
  console.log(alias.x + root.x + alias.arr[0] + root.arr[0] + alias.dup.old.length);
  console.log(JSON.stringify(alias.dup));
}

main();

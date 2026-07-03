function main(): void {
  const text = "{\"n\":5,\"s\":\"7\",\"b\":true,\"z\":null,\"arr\":[8]}";
  const root: any = JSON.parse(text);
  console.log(root.n + 2);
  console.log(2 + root.n);
  console.log(root.s + 2);
  console.log(2 + root.s);
  console.log(root.b + 2);
  console.log(root.z + 2);
  console.log(root.s - 2);
  console.log(root.arr - 1);
}

main();

function main(): void {
  const o: any = {};
  for (let i = 0; i < 5; i++) o["key" + i] = i * 10;
  console.log(o.key0, o.key3, Object.keys(o).length);
  console.log(JSON.stringify(o));
}

main();

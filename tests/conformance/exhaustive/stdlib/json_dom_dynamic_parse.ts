function main(): void {
  const text = '{"items":[{"id":1,"name":"one","flag":true,"nested":{"x":4}},{"id":2,"name":"two","flag":false,"nested":{"x":5}}],"meta":{"count":2}}';
  const root: any = JSON.parse(text);
  const items: any = root.items;
  let acc = 0;
  let i = 0;
  while (i < items.length) {
    const it: any = items[i];
    acc = acc + it.id + it.name.length + it.nested.x;
    if (it.flag) acc = acc + 10;
    i = i + 1;
  }
  console.log(acc);
  console.log(root.meta.count);
  console.log(JSON.stringify(root));
}

main();

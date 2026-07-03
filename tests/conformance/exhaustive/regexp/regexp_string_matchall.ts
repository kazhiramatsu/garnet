function main(): void {
  const a: any = Array.from("ab ab".matchAll(/a(b)/g));
  console.log(a.length, a[0][0], a[0][1], a[0].index, a[1].index);

  const it: any = "baaa".matchAll(/a+/g);
  const n1: any = it.next();
  const n2: any = it.next();
  console.log(n1.done, n1.value[0], n1.value.index, n2.done, String(n2.value));

  const r = /a/g;
  r.lastIndex = 1;
  const fromObj: any = [..."baaa".matchAll(r)];
  console.log(fromObj.length, fromObj[0].index, fromObj[2].index, r.lastIndex);

  const d: any = Array.from("aa".matchAll(/(?<x>a)/dg));
  console.log(d[0].groups.x, d[0].indices.groups.x[0], d[1].index);

  const empty: any = Array.from("😀😀".matchAll(/(?:)/gu));
  console.log(empty.length, empty[0].index, empty[1].index, empty[2].index);

  const sticky: any = Array.from("aa ba".matchAll(/a/gy));
  console.log(sticky.length, sticky[0].index, sticky[1].index);
}

main();

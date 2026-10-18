function code(text: string, index: number): void {
  const dynamic: any = text;
  console.log(text.charCodeAt(index), dynamic.charCodeAt(index));
}
for (const index of [-Infinity, -1, -0.5, 0, 1.9, 3, NaN, Infinity]) code("abc", index);
code("", 0);
code("", -0.5);
code("😀", 1);
const dynamic: any = "abc";
console.log(dynamic.charCodeAt(true), dynamic.charCodeAt(undefined));
const emptySlice = "abc".slice(1, 1);
console.log(emptySlice.length, emptySlice.charCodeAt(-0.5));

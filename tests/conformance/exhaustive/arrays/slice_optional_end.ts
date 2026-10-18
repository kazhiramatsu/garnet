function slice(end?: number): void {
  console.log([1, 2, 3].slice(1, end).join(","), "abc".slice(1, end), "abc".substring(1, end));
  const dynamicArray: any = [1, 2, 3];
  const dynamicString: any = "abc";
  console.log(dynamicArray.slice(1, end).join(","), dynamicString.slice(1, end), dynamicString.substring(1, end));
  console.log("abc".slice(1, end).length, "abc".substring(1, end).length,
    "abc".slice(1, end).charCodeAt(0));
}
slice();
slice(NaN);
slice(Infinity);
slice(-Infinity);
slice(-1.5);
const array: any = [1, 2, 3];
const method = array.slice;
console.log(method.call(array, 1, undefined).join(","));

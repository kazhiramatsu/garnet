function main(): void {
  console.log(/abc/.test("zzabczz"));
  console.log(/abc/.test("ab"));
  console.log(/^abc/.test("abcdef"));
  console.log(/^abc/.test("zabc"));
  console.log(/abc/y.test("abcdef"));
  console.log(/abc/y.test("zabc"));
  console.log(/\x61\u0062c/.test("xxabc"));
  console.log(/😀/.test("A😀B"));
  console.log(/abc/.test(12345));
  console.log("zzabczz".search(/abc/));
  console.log("zabc".search(/^abc/));
  console.log("abc".search(/abc/y));
}
main();

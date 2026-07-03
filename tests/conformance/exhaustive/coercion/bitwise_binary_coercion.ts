// Binary bitwise operators also apply ToInt32/ToUint32(ToNumber(x)) to operands.
// This locks the any/string/bool/null/object paths separately from unary `~`.
function main(): void {
  const s5: any = "5";
  const sf: any = "5.9";
  const sneg: any = "-9";
  const shex: any = "0x10";
  const sws: any = "  8  ";
  const bad: any = "abc";

  console.log(s5 & 3, s5 | 8, s5 ^ 3);          // 1 13 6
  console.log(sf & 7, sf | 0, sf ^ 1);          // 5 5 4
  console.log(sneg & 7, sneg | 0, sneg ^ 3);    // 7 -9 -10
  console.log(shex | 1, sws >> 1, bad | 9);     // 17 4 9

  console.log("8" << 1, "8" >> 1, "8" >>> 1); // 16 4 4
  console.log("-8" << 1, "-8" >> 1, "-8" >>> 1); // -16 -4 2147483644
  console.log("1" << "33", "256" >> "2", "-1" >>> "0"); // 2 64 4294967295

  console.log(true & "3", false | "3", null ^ "3", undefined | "3"); // 1 3 3 3
  console.log([7] & 3, [8] | 1, [9] >> 1); // 3 9 4

  const obj: any = { valueOf() { return "12"; } };
  console.log(obj & 10, obj | 1, obj >> 2); // 8 13 3

  let a: any = "5";
  a &= "3";
  console.log(a); // 1
  let b: any = "5.9";
  b |= "8";
  console.log(b); // 13
  let c: any = "-8";
  c >>>= "1";
  console.log(c); // 2147483644

  const vals: any[] = ["1", "2.9", "0x10", true, null, "bad"];
  let acc = 0;
  for (const v of vals) acc = (acc << 1) ^ (v | 0);
  console.log(acc); // 42
}

main();

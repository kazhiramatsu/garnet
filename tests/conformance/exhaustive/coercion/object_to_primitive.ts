// A plain object literal's user-defined valueOf/toString/[Symbol.toPrimitive]
// must drive ToPrimitive across ALL numeric and string coercion paths. Object
// literal methods are stored as own data properties (FIELD keys), distinct from
// the class-vtable/builtin-prototype METHOD keys; ToPrimitive resolves both, with
// the own method shadowing the prototype default. ToPrimitive(number) tries
// valueOf first; ToPrimitive(string) tries toString first; Symbol.toPrimitive
// takes precedence over both.
function main(): void {
  // valueOf drives every numeric operator
  const v: any = { valueOf() { return 5; } };
  console.log(v & 7, v | 8, v ^ 3, v << 1, v >> 1, v >>> 0); // 5 13 6 10 2 5
  console.log(~~v, -v, +v);                                   // 5 -5 5
  console.log(v * 2, v / 2, v % 3, v - 1);                    // 10 2.5 2 4
  console.log(Number(v));                                     // 5
  console.log(v + 1, v + "");                                 // 6 "5"
  console.log(v < 10, v > 3, v >= 5, v <= 5);                 // true true true true

  // toString drives string coercion
  const t: any = { toString() { return "hi"; } };
  console.log(String(t), `${t}`, t + "!");                    // hi hi hi!
  console.log(Number({ toString() { return "42"; } } as any)); // 42

  // hint precedence: number -> valueOf first, string -> toString first
  const both: any = { valueOf() { return 1; }, toString() { return "2"; } };
  console.log(+both, both + 0);    // 1 1   (number/default -> valueOf)
  console.log(String(both), `${both}`); // 2 2 (string -> toString)

  // Symbol.toPrimitive takes precedence over valueOf/toString
  const sp: any = {
    [Symbol.toPrimitive](hint: string) { return hint === "number" ? 9 : "S"; },
    valueOf() { return -1; }, toString() { return "X"; },
  };
  console.log(+sp, sp * 1, String(sp), sp + ""); // 9 9 S S

  // valueOf returning an object falls back to toString
  const fb: any = { valueOf() { return {}; }, toString() { return "T"; } };
  console.log(fb + "", Number(fb)); // T NaN  (Number("T") is NaN)

  // closure-captured valueOf
  let base = 100;
  const cap: any = { valueOf() { return base + 5; } };
  console.log(cap * 2); // 210

  // an object with no override keeps the default conversions
  const plain: any = { a: 1 };
  console.log(String(plain), plain + ""); // [object Object] [object Object]

  // ---- regressions: previously-working coercions must be unchanged ----
  console.log(~~[7], [1, 2] + "");           // 7 1,2  (array ToPrimitive via join)
  class C { valueOf() { return 3; } toString() { return "K"; } }
  const c = new C();
  console.log(+c, String(c), c + "");        // 3 K 3  (class instance, METHOD key)

  // hot loops with unboxed operands are unaffected by the coercion change
  let si = 0; for (let i = 0; i < 10000; i++) si = (si + i) % 1000007;
  console.log(si);                           // 994657
  let sd = 0; for (let i = 0; i < 1000; i++) sd += (i * 1.5) % 7;
  console.log(sd.toFixed(1));                // 3246.0
}

main();

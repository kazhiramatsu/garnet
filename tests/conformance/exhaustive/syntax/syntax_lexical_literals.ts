function main(): void {
  // Decimal, separators, non-decimal bases, exponent forms, and leading/trailing
  // decimal points all arrive at the same JavaScript Number semantics.
  const nums = [
    0,
    1_000_000,
    0xff,
    0b1010_0101,
    0o755,
    1.25e2,
    1e-3,
    .5,
    5.,
  ];
  console.log(nums.join(","));

  // Every escape family accepted in a normal string literal. Print code units
  // so control characters cannot make the oracle output ambiguous.
  const escaped = "\0\b\t\n\v\f\r\x41\u0042\u{43}\\\"'";
  const codes: number[] = [];
  for (let i = 0; i < escaped.length; i++) codes.push(escaped.charCodeAt(i));
  console.log(codes.join(","));

  const noSubstitution = `plain`;
  const name = "TS";
  const templated = `hello ${name}: ${1 + 2}`;
  console.log(noSubstitution, templated);

  // Unicode identifiers and keyword/numeric/string property names are all
  // lexically distinct from their runtime property values.
  const café = 7;
  const 日本語 = 8;
  const props: any = {
    default: café,
    class: 日本語,
    "space key": 9,
    0x10: 10,
  };
  console.log(café + 日本語, props.default, props.class, props["space key"], props[16]);

  // RegExp literal syntax, including flags and Unicode code-point escapes.
  console.log(/a+b?/i.test("AAAb"), /^\u{1F600}$/u.test("😀"));
}

main();

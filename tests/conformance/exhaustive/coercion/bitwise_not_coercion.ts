// JS bitwise operators apply ToInt32(ToNumber(x)) to each operand. The unary `~`
// must ToNumber its operand the same way the binary bitwise ops do — parsing
// strings, mapping bool->0/1 and null->0 — not via ts_to_num (which yields NaN
// for non-numbers, making ToInt32 collapse to 0). The double-tilde `~~x` idiom
// (truncate-to-int32) is the common case.
function main(): void {
  // string operands (the classic ~~"5" truncation idiom)
  const s5: any = "5";
  console.log(~s5, ~~s5);            // -6 5
  const sf: any = "5.9";
  console.log(~~sf, sf | 0);         // 5 5  (binary | already worked)
  const sneg: any = "-9";
  console.log(~sneg, ~~sneg);        // 8 -9
  const sempty: any = "";
  console.log(~~sempty);             // 0  (Number("") === 0)
  const sgarbage: any = "abc";
  console.log(~~sgarbage);           // 0  (NaN -> ToInt32 -> 0)
  const sws: any = "  7  ";
  console.log(~~sws);                // 7  (leading/trailing whitespace trimmed)
  const shex: any = "0x1F";
  console.log(~~shex);               // 31

  // bool / null / undefined operands
  console.log(~true, ~false, ~~true, ~~false); // -2 -1 1 0
  console.log(~null, ~~null);        // -1 0
  console.log(~undefined, ~~undefined); // -1 0

  // arrays ToPrimitive via join -> string -> number
  const a: any = [7];
  console.log(~~a);                  // 7

  // numeric edge cases (no coercion change, must stay correct)
  console.log(~~3.9, ~3.2, ~~(-3.9));   // 3 -4 -3
  console.log(~~NaN, ~~Infinity, ~~(-Infinity)); // 0 0 0
  console.log(~~4294967296, ~~4294967297);       // 0 1  (ToInt32 wraps mod 2^32)

  // the ~~ idiom over a mixed list, summed (exercises the boxed-any path)
  const vals: any[] = ["3.7", "8.2", 5.5, "abc", true];
  let sum = 0;
  for (const v of vals) sum += ~~v;
  console.log(sum);                  // 3 + 8 + 5 + 0 + 1 = 17

  // raw int hot path (unboxed) is unaffected
  let acc = 0;
  for (let i = 0; i < 100; i++) acc += ~~(i * 1.5);
  console.log(acc);                  // 7375
}

main();

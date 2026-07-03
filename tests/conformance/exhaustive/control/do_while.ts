// do-while runs the body at least once; break and continue work inside it
// (continue re-checks the condition), including when nested.
function main(): void {
  let i = 0, s = 0;
  do { s += i; i++; } while (i < 5);
  console.log(s);                                  // 10

  // continue re-checks the loop condition.
  let j = 0, c = 0;
  do { j++; if (j % 2 === 0) continue; c += j; } while (j < 6);
  console.log(c);                                  // 9 (1+3+5)

  // break exits even from `while (true)`.
  let k = 0;
  do { k++; if (k >= 5) break; } while (true);
  console.log(k);                                  // 5

  // runs once even when the condition is false.
  let r = "";
  do { r += "x"; } while (false);
  console.log(r);                                  // x

  // nested do-while with an inner break.
  let out = "";
  let a = 0;
  do {
    let b = 0;
    do { if (b === 2) break; out += a + "" + b; b++; } while (b < 5);
    a++;
  } while (a < 2);
  console.log(out);                                // 000110
}

main();

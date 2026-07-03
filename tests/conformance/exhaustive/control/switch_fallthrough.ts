// switch fall-through: a case body without `break` falls into the next clause,
// `default` may sit anywhere (and is reached only when no case matches), and
// `break` exits the switch even from inside a nested loop.
function f1(n: number): string {
  let r = "";
  switch (n) {
    case 1: r += "a";       // falls through into case 2
    case 2: r += "b"; break;
    case 3: r += "c";       // falls through into default
    default: r += "d";
  }
  return r;
}

function f2(n: number): string {
  // default positioned in the middle, with fall-through out of it.
  let r = "";
  switch (n) {
    case 1: r += "1"; break;
    default: r += "D";      // falls through into case 2
    case 2: r += "2";
  }
  return r;
}

function f3(n: number): number {
  // break inside a nested loop breaks the loop, not the switch.
  let s = 0;
  switch (n) {
    case 1:
      for (let i = 0; i < 3; i++) { if (i === 2) break; s += i; }
      s += 100;
      break;
    default:
      s = -1;
  }
  return s;
}

function main(): void {
  console.log(f1(1), f1(2), f1(3), f1(9)); // ab b cd d
  console.log(f2(1), f2(2), f2(9));        // 1 2 D2
  console.log(f3(1), f3(9));               // 101 -1

  // no default + no match runs nothing.
  let r = "x";
  switch (5) { case 1: r = "1"; break; case 2: r = "2"; break; }
  console.log(r);                          // x
}

main();

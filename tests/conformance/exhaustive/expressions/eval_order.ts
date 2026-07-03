// JS left-to-right evaluation order / sequence points: an operand's value is
// fixed at its evaluation point even if a later sibling mutates the variable.
// (tsaot snapshots a bare-variable read when a later sibling has a side effect;
// and evaluates an assignment target's object/key before the RHS.)
function f3(a: number, b: number, c: number): void { console.log(a, b, c); }

function main(): void {
  // binary operators: left operand fixed before the right mutates it
  let i = 5;
  console.log(i + i++);          // 10
  i = 5; console.log(i++ + i);   // 11
  i = 5; console.log(i === (i++) ? "eq" : "ne"); // eq

  // call arguments evaluated left-to-right with snapshots
  i = 5; console.log(i, i++, i); // 5 5 6
  i = 5; f3(i, i++, i);          // 5 5 6
  i = 5; console.log(Math.max(i, i++)); // 5
  i = 5; f3(i, (i = 99), i);     // 5 99 99
  i = 5; f3(i, ((): number => { i = 7; return -1; })(), i); // 5 -1 7

  // new arguments
  class P { a: number; b: number; constructor(a: number, b: number) { this.a = a; this.b = b; } }
  i = 5; const p: any = new P(i, i++); console.log(p.a, p.b, i); // 5 5 6

  // assignment target evaluated BEFORE the rhs
  i = 5; const arr: any[] = []; arr[i] = i++; console.log(arr[5], i, arr[6]); // 5 6 undefined
  i = 5; const a2: any[] = [];
  const key = (): number => { i = 9; return 0; };
  a2[key()] = i; console.log(a2[0]); // 9 (key() runs before rhs)
  let o: any = { x: 1 }; const saved = o; o.x = (o = { x: 2 }, 7);
  console.log(saved.x, o.x);     // 7 2

  // no-side-effect control (no extra work, must match)
  let aa = 2, bb = 3, cc = 4;
  console.log(aa * bb + cc);     // 10
  const nums = [1, 2, 3, 4]; let s = 0;
  for (let k = 0; k < nums.length; k++) s += nums[k];
  console.log(s);                // 10
  console.log(nums[0] + nums[1]); // 3
}

main();

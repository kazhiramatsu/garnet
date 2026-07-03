// A compound assignment (`a[i] += v`) must evaluate its target reference
// (object AND key) EXACTLY ONCE, shared by the read and the write-back. Lowering
// the read and write separately re-evaluates the target — incrementing a postfix
// index twice, calling a side-effecting receiver twice, or writing to a slot the
// RHS moved. (tsaot evaluates the ref once via lowerAssignRefPre/lowerReadFromRef
// and writes through the same snapshotted ref.)
function main(): void {
  // computed index with a side effect: i++ evaluated once
  let i = 0;
  const a = [10];
  a[i++] += 5;
  console.log(a[0], i);                 // 15 1

  // the target index is captured BEFORE the RHS mutates it
  i = 0;
  const b = [10, 20];
  b[i] += (i = 1, 5);
  console.log(b[0], b[1], i);           // 15 20 1

  // a side-effecting receiver (object) is evaluated once
  let count = 0;
  const obj = { x: 10 };
  function getObj() { count++; return obj; }
  getObj().x += 5;
  console.log(obj.x, count);            // 15 1

  // postfix index on a member, evaluated once
  i = 1;
  const o = { arr: [1, 2, 3] };
  o.arr[i++] += 10;
  console.log(o.arr[1], i);             // 12 2

  // string-keyed compound with a side-effecting key
  const m: { [k: string]: number } = { a: 1, b: 2 };
  const keys = ["a", "b"];
  let j = 0;
  m[keys[j++]] += 100;
  console.log(m.a, m.b, j);             // 101 2 1

  // postfix index selecting which object's field to bump
  let p = 0;
  const objs = [{ v: 1 }, { v: 2 }];
  objs[p++].v += 100;
  console.log(objs[0].v, objs[1].v, p); // 101 2 1

  // all the compound operators on a fixed index (plain correctness)
  const c = [100];
  c[0] -= 10; c[0] *= 2; c[0] /= 3; c[0] %= 7;
  console.log(c[0]);                    // 4   (((100-10)*2)/3)=60, 60%7=4
  const d = [12];
  d[0] &= 10; d[0] |= 1; d[0] ^= 3;
  console.log(d[0]);                    // (12&10=8, |1=9, ^3=10) 10
  const e = [16];
  e[0] <<= 2; e[0] >>= 1; e[0] **= 2;
  console.log(e[0]);                    // ((16<<2=64)>>1=32)**2 = 1024

  // string concat compound on an element
  const s = ["x", "y"];
  s[0] += "!";
  console.log(s[0], s[1]);              // x! y

  // identifier / static targets keep working (no ref hazard)
  let x = 10; x += 5; console.log(x);   // 15
}

main();

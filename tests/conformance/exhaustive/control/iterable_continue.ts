const values: string[] = [];
outer: for (const x of [1, 2, 3]) {
  for (const y of [4, 5]) {
    values.push(x + ":" + y);
    continue outer;
  }
}
for (const ch of "a😀b𠮷c") {
  if (ch === "😀" || ch === "b") continue;
  values.push(ch);
}
for (const [k, v] of new Map([["a", 1], ["b", 2]])) {
  if (v === 1) continue;
  values.push(k);
}
for (const x of new Set([1, 2, 3])) {
  switch (x) {
    case 1: continue;
    case 2:
      switch (x + 1) { case 3: continue; }
  }
  values.push("set:" + x);
}
let key = "";
for (key in { a: 1, b: 2, c: 3 }) {
  if (key === "b") continue;
  values.push(key);
}
let assigned = 0;
for (assigned of [7, 8]) {
  values.push("assigned:" + assigned);
  continue;
}
const fresh: (() => number)[] = [];
const shared: (() => number)[] = [];
for (let x of [1, 2, 3]) { fresh.push(() => x); continue; }
for (var x of [1, 2, 3]) { shared.push(() => x); continue; }
console.log(values.join(","), key, assigned);
console.log(fresh.map(f => f()).join(","), shared.map(f => f()).join(","));

function* source(name: string): Generator<number> {
  try { yield 1; yield 2; yield 3; }
  finally { console.log("close", name); }
}
outerIterator: for (const x of [1, 2]) {
  for (const y of source("nested")) {
    switch (y) {
      case 1: continue;
      case 2: console.log("jump", x, y); continue outerIterator;
    }
  }
}
for (assigned of source("assign")) {
  if (assigned < 3) continue;
  console.log("driven", assigned);
}
function* switching(): Generator<number> {
  for (const x of [1, 2, 3]) {
    switch (x) { case 2: continue; }
    yield x;
  }
}
console.log(Array.from(switching()).join(","));

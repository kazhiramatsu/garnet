// Typed array operations (the receiver's static type is an array) through a Proxy: every operation
// goes through the traps, as vue's reactive arrays require. The first part checks the exact trap
// sequence of the common operations (for..of, length, index, push); the rest checks the values and
// the mutations (set and deleteProperty traps) of every array method, whose read sequences differ
// in detail from V8's (a species lookup, an early exit, a has before a get).
function main(): void {
  const seq: string[] = [];
  const raw0 = [1, 2, 3];
  const p0: number[] = new Proxy(raw0, {
    get(t, k, r) { seq.push("get:" + String(k)); return Reflect.get(t, k, r); },
    set(t, k, v, r) { seq.push("set:" + String(k) + "=" + v); return Reflect.set(t, k, v, r); },
  });
  const out: number[] = [];
  for (const v of p0) out.push(v);
  console.log("forof", out.join(","), "|", seq.join(" "));
  seq.length = 0;
  console.log("len", p0.length, "idx", p0[0], p0[5], "|", seq.join(" "));
  seq.length = 0;
  p0[1] = 20; p0.push(4, 5); p0.unshift(0);
  console.log("push", raw0.join(","), "|", seq.join(" "));

  const log: string[] = [];
  const raw = [1, 2, 3];
  const arr: number[] = new Proxy(raw, {
    get(t, k, r) { return Reflect.get(t, k, r); },
    set(t, k, v, r) { log.push("set:" + String(k) + "=" + v); return Reflect.set(t, k, v, r); },
    deleteProperty(t, k) { log.push("del:" + String(k)); return Reflect.deleteProperty(t, k); },
  });
  arr[1] = 20; arr.push(4, 5);
  console.log("filter", arr.filter((v) => v > 2).join(","), "map", arr.map((v) => v * 2).join(","));
  console.log("some", arr.some((v) => v === 20), "every", arr.every((v) => v > 0), "find", arr.find((v) => v > 3), arr.findIndex((v) => v === 4), arr.findLast((v) => v < 4), arr.findLastIndex((v) => v < 4));
  console.log("includes", arr.includes(20), arr.indexOf(5), arr.lastIndexOf(1), arr.at(-1));
  console.log("join", arr.join("|"), "slice", arr.slice(1, 3).join(","), "concat", arr.concat([9]).length, arr.concat(7, [8]).join(","));
  console.log("spread", [...arr].join(","), "from", Array.from(arr).length, "isArray", Array.isArray(arr));
  console.log("splice", arr.splice(0, 1).join(","), raw.join(","), "shift", arr.shift(), "unshift", arr.unshift(7), raw.join(","));
  console.log("reduce", arr.reduce((a, v) => a + v, 0), arr.reduceRight((a, v) => a + "-" + v, ""), "forEach", (() => { let n = 0; arr.forEach((v) => { n += v; }); return n; })());
  console.log("in", 1 in arr, 10 in arr, "delete", delete arr[0], "keys", Object.keys(arr).join(","));
  console.log("sort", arr.sort((a, b) => a - b).join(","), "reverse", arr.reverse().join(","), "pop", arr.pop(), "fill", arr.fill(1, 1).join(","));
  console.log("entries", [...arr.entries()].length, "values", [...arr.values()].join(","), "keys2", [...arr.keys()].join(","));
  console.log("flat", ([[1], [2]] as number[][]).flat().length, "toSorted", arr.toSorted((a, b) => b - a).join(","), "toReversed", arr.toReversed().join(","), "with", arr.with(0, 9).join(","), "toSpliced", arr.toSpliced(0, 1).join(","), raw.join(","));
  console.log("json", JSON.stringify(arr), "str", String(arr), "tostr", arr.toString());
  console.log(log.join(" "));
}
main();

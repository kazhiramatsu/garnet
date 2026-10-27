// JSON.stringify's replacer argument: a function (called with the holder as `this`, the key and the
// value, after toJSON; its result serialized, undefined and functions omitted from objects and null
// in arrays; the root under the key "" of a wrapper object) and an array of property names (the
// properties every object serializes, in the array's order, numbers as names, duplicates once;
// arrays are not filtered), each with and without indentation, a replacer of another kind, and the
// function value called with extra arguments.
function main(): void {
  const out: string[] = [];
  const data: Record<string, unknown> = {
    a: 1, b: "two",
    c: [1, "x", { d: 4, e: undefined, f: () => 0 }],
    g: { h: null, i: true, j: 2.5 },
    k: undefined,
  };
  out.push(JSON.stringify(data, (key, value) => {
    if (key === "b") return undefined;
    if (typeof value === "number") return value * 2;
    if (typeof value === "string") return value.toUpperCase();
    return value;
  }));
  const seen: string[] = [];
  JSON.stringify(data, function (this: unknown, key: string, value: unknown) {
    seen.push(key + ":" + (Array.isArray(this) ? "array" : typeof this));
    return value;
  });
  out.push(seen.join(","));
  out.push(JSON.stringify(42, (k, v) => (k === "" ? { wrapped: v } : v)));
  out.push(JSON.stringify([1, undefined, () => 1, "s"], (k, v) => (v === "s" ? undefined : v)));
  out.push(JSON.stringify(data, ["g", "a", "j", "h", "nope", "a"]));
  out.push(JSON.stringify({ 1: "one", two: 2, 3: "three" }, [1, "two", 3]));
  out.push(JSON.stringify(data, ["c", "d"]));
  out.push(JSON.stringify(data, (k, v) => (typeof v === "number" ? v + 1 : v), 2));
  out.push(JSON.stringify(data, ["a", "g", "i"], "\t"));
  const t = { toJSON(key: string): unknown { return { tj: key }; } };
  out.push(JSON.stringify({ x: t, y: [t] }, (k, v) => (v !== null && typeof v === "object" && "tj" in v ? { ...v, seen: true } : v)));
  out.push(JSON.stringify(data, 5 as unknown as undefined));
  out.push(JSON.stringify(data, {} as unknown as undefined, 1));
  const f = JSON.stringify;
  out.push(f({ p: 1, q: 2 }, ["q"]));
  out.push(f({ p: 1, q: 2 }, null, 1));
  out.push(String(f(undefined, (k, v) => v)));
  class Point { constructor(public x: number, public y: number) {} }
  out.push(JSON.stringify([new Point(1, 2), new Point(3, 4)], ["y"]));
  out.push(JSON.stringify(new Point(5, 6), (k, v) => (k === "x" ? v * 10 : v)));
  console.log(out.join("\n"));
}
main();

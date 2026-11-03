// console.log's format string (Node's formatWithOptions), a symbol at any depth of an inspected value, the
// RangeErrors of `new Array(n)` and `repeat`, the default collation of localeCompare.
console.log("%s is %d", "x", 5, { a: 1 }, [1, "s"]);
console.log("%s", "only");
console.log("100%", 5);
console.log("%% %s %%", "m");
console.log("no args %s %d");
console.log("%d %i %f", "12.5", "12.5", "12.5abc");
console.log("%d %i %f", {}, null, undefined);
console.log("%j %O %o", { a: [1] }, { b: "s" }, "str");
console.log("%c styled %s", "color: red", "text");
console.log("%x stays %s", "y");
console.log("%s %s", -0, 1.5);
console.log("%s %s %s %s", null, undefined, true, Symbol("q"));
console.log("trailing %", 1);
console.log("%s", "a", "b", 3);
console.log(5, "%s", "not a format");
console.log(Symbol("top"), [Symbol("in")], { s: Symbol.for("f"), k: Symbol.iterator }, new Map([[Symbol("k"), 1]]));
function attempt(f: () => unknown): string {
  try {
    return String(f());
  } catch (e) {
    return (e as Error).name + ": " + (e as Error).message;
  }
}
console.log(attempt(() => new Array(-1)), attempt(() => new Array(1.5)), attempt(() => new Array(2 ** 32)), attempt(() => new Array(2).length));
console.log(attempt(() => "x".repeat(-1)), attempt(() => "x".repeat(Infinity)), attempt(() => "x".repeat(2.7)), attempt(() => "x".repeat(0)));
const names = ["b", "a", "C", "A", "é", "e", "f", "Z", "z", "1", "10", "2", "_", "-", " ", "ä", "aa", "ab", "Ab", "aB", "résumé", "resume", ""];
console.log(names.slice().sort((x, y) => x.localeCompare(y)).join("|"));
console.log("a".localeCompare("b"), "b".localeCompare("a"), "a".localeCompare("a"), "a".localeCompare("A"), "A".localeCompare("a"), "".localeCompare("a"), "résumé".localeCompare("resume"));
const hole: number[] = [1, , 3] as number[];
console.log(hole.map((x) => x * 2));

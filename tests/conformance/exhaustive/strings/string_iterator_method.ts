// String.prototype[Symbol.iterator] as a method: code points (a surrogate pair
// is one element), the iterator protocol by hand, and the places that take an
// iterable of a string (Set, Array.from, spread, destructuring).
function main(): void {
  const s = "h\u00e9\ud83d\ude00!";
  const it = s[Symbol.iterator]();
  console.log(typeof s[Symbol.iterator], typeof it.next, it.next().value, it.next().value, (it.next().value as string).length, it.next().value, it.next().done);
  console.log([...s].length, Array.from(s).join("|"), new Set("abca").size, [...new Set("hello")].join(""));
  const [first, , third] = "xyz";
  console.log(first, third);
  const m = new Map<string, number>();
  for (const ch of "aab") m.set(ch, (m.get(ch) ?? 0) + 1);
  console.log([...m.entries()].map(([k, v]) => k + v).join(","));
  const iter = "ok"[Symbol.iterator]();
  console.log(typeof iter[Symbol.iterator], iter[Symbol.iterator]() === iter, [...iter].join("+"));
  console.log(String.prototype[Symbol.iterator].call("12").next().value);
}
main();

// Strict equality against string literals (ts_eq_strlit): the lengths first,
// the content only for an equal length; every representation of an equal
// string must compare equal, and no non-string may.
function kindOf(name: string): number {
  switch (name) {
    case "document": case "console": return 1;
    case "$": return 2;
    case "describe": case "suite": case "it": case "test": return 3;
    case "process": case "require": case "Buffer": case "module": return 4;
    case "Map": case "Set": case "Promise": case "Symbol": case "WeakMap": case "WeakSet":
    case "Iterator": case "AsyncIterator": case "SharedArrayBuffer": case "Atomics": return 5;
    case "日本": return 6;
    case "": return 7;
    default: return 0;
  }
}
function main(): void {
  const src = "xx document console $ Promise WeakSet SharedArrayBuffer it test nothing Set Mapx 日本 yy";
  const words = src.split(" ");
  const out: number[] = [];
  for (const w of words) out.push(kindOf(w));
  // views (slices), concatenations, short immediates, characters
  out.push(kindOf(src.slice(3, 11)), kindOf("con" + "sole"), kindOf("Se" + "t"), kindOf(src.substring(src.indexOf("$"), src.indexOf("$") + 1)));
  out.push(kindOf(String.fromCharCode(0x65e5, 0x672c)), kindOf(""), kindOf("".slice(0)), kindOf("Mapx".slice(0, 3)));
  console.log(out.join(","));
  const anyVals: any[] = ["quit", "qui" + "t", 4, { toString() { return "quit"; } }, undefined, null, ["quit"]];
  const eq = anyVals.map((v) => (v === "quit" ? 1 : 0) + (v !== "quit" ? 10 : 0));
  console.log(eq.join(","));
  let hits = 0;
  for (let i = 0; i < 20000; i++) hits += kindOf(words[i % words.length]);
  console.log(hits);
}
main();

// A switch on string literals: many cases, grouped labels, a default, the
// discriminant short (immediate), long (heap), built at run time (unhashed),
// two-byte, and not a string at all; a two-byte label; nested switches.
function kindOf(name: string): number {
  switch (name) {
    case "document": return 1;
    case "console": return 2;
    case "window": return 3;
    case "require": case "exports": case "module": return 4;
    case "process": return 5;
    case "Buffer": return 6;
    case "describe": case "it": case "test": return 7;
    case "a": return 8;
    case "αβγ": return 9;
    case "a somewhat longer label that is a heap string": return 10;
    case "": return 11;
    default: return 0;
  }
}
function viaAny(x: unknown): string {
  switch (x as string) {
    case "one": return "1";
    case "two": return "2";
    case "three": return "3";
    case "four": return "4";
    case "five": return "5";
    default: return typeof x;
  }
}
function nested(a: string, b: string): string {
  switch (a) {
    case "x": switch (b) { case "p": return "xp"; case "q": return "xq"; case "r": return "xr"; case "s": return "xs"; default: return "x?"; }
    case "y": return "y" + b;
    case "z": case "w": return "zw";
    case "v": return "v";
    default: return "?";
  }
}
function main() {
  const out: unknown[] = [];
  const names = ["document", "console", "window", "require", "exports", "module", "process", "Buffer", "describe", "it", "test", "a", "αβγ", "a somewhat longer label that is a heap string", "", "nope", "documen", "documentX", "Document", "αβ", "αβγδ"];
  out.push(names.map(kindOf).join(","));
  const built = ["doc" + "ument", "con" + "sole", "re" + "quire", "α" + "βγ", "a somewhat longer label " + "that is a heap string", "x".repeat(0), "it" + "", "tes" + "t"];
  out.push(built.map(kindOf).join(","));
  out.push([1, "one", "two", undefined, null, {}, [], "five", "six", true, 2.5, "three"].map(viaAny).join(","));
  out.push(["xp", "xq", "xs", "xt", "ya", "zb", "wc", "v", "u"].map((s) => nested(s[0], s.slice(1))).join(","));
  let acc = 0;
  for (let i = 0; i < 2000; i++) acc += kindOf(names[i % names.length]) + kindOf(String.fromCharCode(97 + (i % 26)));
  out.push(acc);
  console.log(JSON.stringify(out));
}
main();

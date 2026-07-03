function main(): void {
  // A string held in an `any`-typed binding resolves its builtin methods
  // dynamically through String.prototype (the static fast path requires a
  // concrete string type; this mirrors arrays/Maps/Sets typed as `any`).
  const s: any = "Hello, World";

  console.log(s.toUpperCase());                  // HELLO, WORLD
  console.log(s.toLowerCase());                  // hello, world
  console.log(s.slice(0, 5));                    // Hello
  console.log(s.substring(7));                   // World
  console.log(s.indexOf("World"));               // 7
  console.log(s.lastIndexOf("o"));               // 8
  console.log(s.includes("World"));              // true
  console.log(s.startsWith("Hello"));            // true
  console.log(s.endsWith("World"));              // true
  console.log(s.charAt(1));                       // e
  console.log(s.charCodeAt(0));                   // 72
  console.log(s.at(-1));                          // d
  console.log(s[0], s["1"], s[99], s["length"]);  // H e undefined 12
  const dynKey: any = 2;
  console.log(s[dynKey], s[String(3)]);            // l l
  const upperKey: any = "toUpperCase";
  const sliceKey: any = "slice";
  console.log(s["toLowerCase"](), s[upperKey]());   // hello, world HELLO, WORLD
  console.log(s[sliceKey](7, 12));                  // World

  const wideAny: any = "A😀B";
  console.log(wideAny[1].length, wideAny[1].charCodeAt(0), wideAny[2].charCodeAt(0), wideAny["length"]); // 1 55357 56832 4

  const csv: any = "a,b,c";
  console.log(csv.split(",").join("|"));          // a|b|c

  const pad: any = "5";
  console.log(pad.padStart(3, "0"));              // 005
  console.log(pad.padEnd(3, "."));                // 5..

  const dashed: any = "a-b-c";
  console.log(dashed.replace("-", "+"));          // a+b-c
  console.log(dashed.replaceAll("-", "+"));       // a+b+c

  const sp: any = "  trim me  ";
  console.log(sp.trim());                          // trim me
  console.log(sp.trimStart().length);             // 9
  console.log(sp.trimEnd().length);               // 9

  const r: any = "ab";
  console.log(r.repeat(3));                        // ababab
  console.log(r.concat("c", "d"));                 // abcd

  // Chained dynamic-dispatch calls.
  const mixed: any = "  fOo  ";
  console.log(mixed.trim().toUpperCase().slice(0, 2));   // FO

  // Combined with optional chaining.
  console.log(s?.toUpperCase());                  // HELLO, WORLD
}
main();

// Symbol.toStringTag customizes Object.prototype.toString: a string-valued
// [Symbol.toStringTag] makes the default toString yield "[object <tag>]". This
// flows through o.toString(), String(o), `${o}`, and "" + o (the toString step of
// ToPrimitive). A non-string tag is ignored; an own toString shadows it entirely.
function main(): void {
  // element-access set, then every default-toString path reflects the tag
  const o: any = {};
  o[Symbol.toStringTag] = "Foo";
  console.log(o.toString());            // [object Foo]
  console.log(String(o));               // [object Foo]
  console.log(`${o}`);                  // [object Foo]
  console.log("" + o);                  // [object Foo]

  // object-literal symbol data-property form
  const lit: any = { [Symbol.toStringTag]: "Lit" };
  console.log(String(lit), `${lit}`);   // [object Lit] [object Lit]

  // empty-string tag
  const e: any = { [Symbol.toStringTag]: "" };
  console.log(String(e));               // [object ]

  // a non-string tag is ignored -> default "[object Object]"
  const n: any = {}; n[Symbol.toStringTag] = 42;
  console.log(String(n));               // [object Object]

  // an own toString shadows the tag (Object.prototype.toString never runs)
  const s: any = { [Symbol.toStringTag]: "Ignored", toString() { return "own"; } };
  console.log(String(s), `${s}`);       // own own

  // string hint uses toString(tag); number/default hint uses valueOf
  const m: any = { [Symbol.toStringTag]: "M", valueOf() { return 7; } };
  console.log(String(m), m + "", m * 2); // [object M] 7 14

  // multi-character / spaced tag content
  const w: any = {}; w[Symbol.toStringTag] = "My Cool Tag";
  console.log(w.toString());            // [object My Cool Tag]

  // an object with no tag keeps the default
  const plain: any = { a: 1 };
  console.log(String(plain));           // [object Object]
}
main();

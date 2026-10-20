// Object.defineProperty with a descriptor that names only some fields: an
// existing property keeps the others (ValidateAndApplyPropertyDescriptor),
// a non-configurable one accepts only compatible changes, and a
// non-extensible object takes no new property.

class Point {
  x = 1;
  y = 2;
}

function attrs(o: object, k: string): string {
  const d = Object.getOwnPropertyDescriptor(o, k);
  if (d === undefined) return "absent";
  const kind = "value" in d ? "data:" + String(d.value) + (d.writable ? " w" : " -") : "acc" + (d.get ? " g" : "") + (d.set ? " s" : "");
  return kind + (d.enumerable ? " e" : " -") + (d.configurable ? " c" : " -");
}

function attempt(label: string, f: () => void): string {
  try {
    f();
    return label + " ok";
  } catch (e) {
    return label + " " + (e as Error).constructor.name + ": " + (e as Error).message;
  }
}

function main(): void {
  const out: string[] = [];

  // partial updates keep the fields left out
  const o: Record<string, number> = { a: 1, b: 2, c: 3, d: 4 };
  Object.defineProperty(o, "a", { value: 10 });
  Object.defineProperty(o, "b", { enumerable: false });
  Object.defineProperty(o, "c", { writable: false });
  Object.defineProperty(o, "d", { configurable: false });
  out.push(attrs(o, "a"), attrs(o, "b"), attrs(o, "c"), attrs(o, "d"), JSON.stringify(o), Object.keys(o).join(""));

  // a new property: the absent fields are false / undefined
  Object.defineProperty(o, "e", { value: 5 });
  Object.defineProperty(o, "f", {});
  out.push(attrs(o, "e"), attrs(o, "f"));

  // data -> accessor keeps enumerable / configurable; partial accessor updates
  const acc: Record<string, number> = { v: 1 };
  let backing = 7;
  Object.defineProperty(acc, "v", { get: () => backing });
  out.push(attrs(acc, "v"), String(acc.v));
  Object.defineProperty(acc, "v", { set: (n: number) => { backing = n * 2; } });
  acc.v = 5;
  out.push(attrs(acc, "v"), String(acc.v));
  Object.defineProperty(acc, "v", { value: 3 });
  out.push(attrs(acc, "v"));

  // non-configurable properties
  const nc: Record<string, number> = {};
  Object.defineProperty(nc, "k", { value: 1, writable: true, enumerable: true });
  out.push(attempt("value", () => Object.defineProperty(nc, "k", { value: 2 })), String(nc.k));
  out.push(attempt("make readonly", () => Object.defineProperty(nc, "k", { writable: false })), attrs(nc, "k"));
  out.push(attempt("value again", () => Object.defineProperty(nc, "k", { value: 3 })));
  out.push(attempt("same value", () => Object.defineProperty(nc, "k", { value: 2 })));
  out.push(attempt("configurable", () => Object.defineProperty(nc, "k", { configurable: true })));
  out.push(attempt("enumerable", () => Object.defineProperty(nc, "k", { enumerable: false })));
  out.push(attempt("to accessor", () => Object.defineProperty(nc, "k", { get: () => 1 })));
  // Reflect.defineProperty answers false instead of throwing
  out.push(String(Reflect.defineProperty(nc, "k", { value: 9 })), String(Reflect.defineProperty(nc, "k", { value: 2 })), String(nc.k));
  out.push(attempt("reflect primitive", () => Reflect.defineProperty(5 as unknown as object, "x", { value: 1 })));

  // sealed, frozen, non-extensible objects
  const sealed: Record<string, number> = Object.seal({ s: 1 });
  out.push(attempt("sealed value", () => Object.defineProperty(sealed, "s", { value: 2 })), String(sealed.s));
  out.push(attempt("sealed new", () => Object.defineProperty(sealed, "t", { value: 2 })));
  const frozen: Record<string, number> = Object.freeze({ z: 1 });
  out.push(attempt("frozen same", () => Object.defineProperty(frozen, "z", { value: 1 })));
  out.push(attempt("frozen other", () => Object.defineProperty(frozen, "z", { value: 2 })), String(frozen.z));
  const closed: Record<string, number> = Object.preventExtensions({ m: 1 });
  out.push(attempt("closed existing", () => Object.defineProperty(closed, "m", { enumerable: false })), attrs(closed, "m"));

  // Object.defineProperties applies each descriptor the same way
  const many: Record<string, number> = { p: 1, q: 2 };
  Object.defineProperties(many, { p: { value: 11 }, q: { enumerable: false }, r: { value: 3, enumerable: true } });
  out.push(JSON.stringify(many), attrs(many, "q"), attrs(many, "r"));

  // a class field takes a new value and keeps its attributes
  const pt = new Point();
  Object.defineProperty(pt, "x", { value: 5 });
  Object.defineProperty(pt, "y", { value: 6, writable: true, enumerable: true, configurable: true });
  out.push(String(pt.x), String(pt.y), attrs(pt, "x"), JSON.stringify(pt));

  // functions take properties too; a primitive is a TypeError
  function tagged(): number {
    return 1;
  }
  Object.defineProperty(tagged, "label", { value: "fn", enumerable: true });
  out.push(String((tagged as unknown as { label: string }).label), attrs(tagged, "label"));
  out.push(attempt("primitive", () => Object.defineProperty(5 as unknown as object, "x", { value: 1 })));

  // a proxy target sees the descriptor as written
  const seen: string[] = [];
  const px = new Proxy({ h: 1 } as Record<string, number>, {
    defineProperty(t: Record<string, number>, k: string | symbol, d: PropertyDescriptor): boolean {
      seen.push(String(k) + JSON.stringify(d));
      return Reflect.defineProperty(t, k, d);
    },
  });
  Object.defineProperty(px, "h", { value: 9 });
  Object.defineProperty(px, "i", { value: 8, writable: true });
  out.push(seen.join(" "), JSON.stringify(px));

  for (const line of out) console.log(line);
}
main();

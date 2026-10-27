// An ordinary (non-const) enum's literal members fold to their constants at a read site, as a
// const enum's do; the values, the control flow and the enum object (kept for the reflective uses)
// must agree with V8, where every read goes through the object.
enum Flags { SKIP = "__v_skip", IS_REACTIVE = "__v_isReactive", RAW = "__v_raw" }
enum Kind { Root, Element, Text = 5, Comment, Interp = Text * 2, Named = "n" }
enum Mixed { A = 1 << 0, B = 1 << 1, AB = A | B, S = "s", L = "ab".length }
namespace NS { export enum Inner { X = "x", Y = 7 } }
enum Neg { M = -3, Z = 0, Big = 2 ** 40, Half = 0.5 }

function classify(key: string): number {
  if (key === Flags.SKIP) return 1;
  if (key === Flags.IS_REACTIVE) return 2;
  return key === Flags.RAW ? 3 : 0;
}
function kindName(k: Kind): string {
  switch (k) {
    case Kind.Root: return "root";
    case Kind.Element: return "element";
    case Kind.Text: return "text";
    case Kind.Comment: return "comment";
    case Kind.Interp: return "interp";
    default: return "other";
  }
}
function flagName(f: string): string {
  switch (f) {
    case Flags.SKIP: return "skip";
    case Flags.RAW: return "raw";
    default: return "?";
  }
}
function main(): void {
  console.log(classify("__v_skip"), classify("__v_isReactive"), classify("__v_raw"), classify("x"));
  console.log(Kind.Root, Kind.Element, Kind.Text, Kind.Comment, Kind.Interp, Kind.Named);
  console.log([0, 1, 5, 6, 10, 3].map((n) => kindName(n as Kind)).join(","));
  console.log(flagName("__v_skip"), flagName("__v_raw"), flagName("__v_isReactive"));
  console.log(Mixed.A, Mixed.B, Mixed.AB, Mixed.S, Mixed.L);
  console.log(Flags["SKIP"], Kind["Text"], NS.Inner.X, NS.Inner.Y, NS.Inner["Y"]);
  console.log(Neg.M, Neg.Z, Neg.Big, Neg.Half, Neg.M * 2 + Neg.Half);
  // the enum object stays: reflective uses read it
  console.log(Kind[5], Kind[10], Kind[Kind.Comment], (Kind as any)["Named"], Object.keys(Flags).join(","));
  console.log(Object.keys(Mixed).join(","), JSON.stringify(NS.Inner));
  const obj: Record<string, number> = { [Flags.RAW]: 4, [Kind.Text]: 9 };
  console.log(obj["__v_raw"], obj[5], obj[Flags.RAW] + obj[Kind.Text]);
  const o: any = { __v_skip: true };
  console.log(o[Flags.SKIP], o[Flags.RAW], Flags.SKIP in o, Flags.RAW in o);
  let acc = 0;
  for (let i = 0; i < 1000; i++) acc += (i & 1) ? Kind.Comment : Kind.Interp;
  console.log(acc);
  console.log(typeof Kind.Root, typeof Flags.SKIP, Kind.Element === 1, Flags.SKIP.length, `${Flags.RAW}:${Kind.Interp}`);
  const E = Kind;
  console.log(E.Text, E["Comment"], E.Named + "!");
  const members = [Flags.SKIP, Flags.RAW, Flags.IS_REACTIVE];
  console.log(members.indexOf("__v_raw" as Flags), members.includes(Flags.IS_REACTIVE));
  let k: Kind = Kind.Root;
  k = Kind.Interp;
  console.log(k === Kind.Interp, k > Kind.Text, kindName(k));
}
main();

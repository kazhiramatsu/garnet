interface Merge {
  a: number;
}
interface Merge {
  b: string;
}

enum NumericEnum {
  Zero,
  Five = 5,
  Six,
}

enum StringEnum {
  A = "A",
  B = "B",
}

const enum InlinedEnum {
  X = 10,
  Y = X * 2,
}

namespace MergedNamespace {
  export const a = 1;
}
namespace MergedNamespace {
  export function twice(n: number): number {
    return n * 2;
  }
}

function format(value: number): string;
function format(value: string): string;
function format(value: number | string): string {
  return typeof value === "number" ? "n" + value : "s" + value;
}

function main(): void {
  const merged: Merge = { a: 2, b: "m" };
  console.log(merged.a, merged.b);
  console.log(NumericEnum.Zero, NumericEnum.Five, NumericEnum.Six);
  console.log(StringEnum.A, StringEnum.B, InlinedEnum.X, InlinedEnum.Y);
  console.log(MergedNamespace.a, MergedNamespace.twice(3));
  console.log(format(4), format("q"));
}

main();

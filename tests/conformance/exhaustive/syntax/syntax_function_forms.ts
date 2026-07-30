type Pair = [number, number];

function declared(a: number, b = a + 1): number {
  return a + b;
}

function overloaded(x: number): string;
function overloaded(x: string): string;
function overloaded(x: number | string): string {
  return typeof x === "number" ? "n" + x : "s" + x;
}

function destructured(
  [a, b = 2]: Pair,
  { scale = 1, label: renamed = "x" }: { scale?: number; label?: string },
): string {
  return renamed + ":" + (a + b) * scale;
}

function withRest(head: string, ...tail: number[]): string {
  return head + tail.join(",");
}

function withOptional(value?: number): number {
  return value === undefined ? -1 : value;
}

function explicitThis(this: { base: number }, n: number): number {
  return this.base + n;
}

function main(): void {
  const namedExpression = function localName(n: number): number {
    return n <= 1 ? 1 : n * localName(n - 1);
  };
  const arrowExpression = (n: number): number => n * 2;
  const arrowBlock = (n: number): number => {
    return n * 3;
  };

  console.log(declared(3), declared(3, 10));
  console.log(overloaded(4), overloaded("q"));
  console.log(destructured([3, undefined as any], { scale: 4, label: "p" }));
  console.log(withRest("r:", 1, 2, 3), withOptional(), withOptional(9));
  console.log(namedExpression(5), arrowExpression(6), arrowBlock(7));
  console.log(explicitThis.call({ base: 8 }, 9));

  // IIFE and immediately invoked arrow cover expression-position function
  // creation and call evaluation.
  console.log((function (x: number): number { return x + 1; })(10));
  console.log(((x: number): number => x + 2)(10));
}

main();

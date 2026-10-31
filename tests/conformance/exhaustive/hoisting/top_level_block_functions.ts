// A function declaration in a block at the top level of a module: the program has no enclosing function to
// hoist it in, so its closure must exist when the block runs (a call read an unset binding).
{
  console.log(early(1));
  function early(x: number): number {
    return x + 1;
  }
  function run(x: number): string {
    return "r" + later(x);
  }
  function later(x: number): number {
    return x * 2;
  }
  console.log(run(5));
  const f = run;
  console.log(f(6));
}
if (Date.now() > 0) {
  function inIf(): string {
    return "if";
  }
  console.log(inIf());
} else {
  function inElse(): string {
    return "else";
  }
  console.log(inElse());
}
for (let i = 0; i < 2; i++) {
  function inLoop(): number {
    return i;
  }
  console.log(inLoop());
}
try {
  function inTry(): string {
    return "try";
  }
  console.log(inTry());
} finally {
  function inFinally(): string {
    return "finally";
  }
  console.log(inFinally());
}
switch (1) {
  case 1: {
    function inCase(): string {
      return "case";
    }
    console.log(inCase());
  }
}
label: {
  function inLabel(): string {
    return "label";
  }
  console.log(inLabel());
}

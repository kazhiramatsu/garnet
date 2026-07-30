type OptionalTuple = [required: number, optional?: string];
type ReadonlyOptionalRest = readonly [head?: number, ...tail: string[]];

abstract class AbstractBase {
  abstract read(): number;
}

class Concrete extends AbstractBase {
  ;
  value = 4;
  read(): number { return this.value; }
}

function describe(tuple: OptionalTuple, rest: ReadonlyOptionalRest): string {
  return tuple.length + ":" + (tuple[1] ?? "none") + ":" + rest.length;
}

function main(): void {
  debugger;
  const short: OptionalTuple = [1];
  const full: OptionalTuple = [2, "two"];
  const rest: ReadonlyOptionalRest = [3, "a", "b"];
  console.log(describe(short, []), describe(full, rest), new Concrete().read());
}

main();

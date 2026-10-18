function destructured({ value, nested: [step], ...rest }: {
  value: number; nested: number[]; extra: number;
}): number {
  const { extra: offset } = rest;
  const [a, , ...tail] = [value, 99, step];
  return (() => value + step + offset + a + tail[0])();
}

function typedClosure<T>(value: T): T {
  interface Local { item: T }
  type Result = Local["item"];
  const get = (): Result => {
    const box: Local = { item: value };
    return box.item;
  };
  return get();
}

function overload(value: number): number;
function overload(value: string): string;
function overload(value: number | string): number | string {
  return value;
}

function localOverload(n: number): number {
  function double(value: number): number;
  function double(value: string): string;
  function double(value: any): any { return value + value; }
  return double(n);
}

function orderedDefaults(a = 3, { b = a + 1 }: { b?: number } = {},
                         read = () => a + b): number {
  return read();
}

console.log(destructured({ value: 2, nested: [3], extra: 4 }));
console.log(typedClosure(17), typedClosure("typed"));
console.log(overload(8), overload("overload"), localOverload(6));
console.log(orderedDefaults(), orderedDefaults(6, { b: 2 }));

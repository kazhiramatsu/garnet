interface Callable {
  (n: number): number;
}

interface Constructable {
  new (n: number): { value: number };
}

interface Indexed {
  readonly fixed: number;
  optional?: string;
  [key: string]: number | string | undefined;
}

type PrimitiveUnion = string | number | boolean | null | undefined;
type OptionalUnnamedTuple = [number, string?];
type KeywordTypes = [
  any, unknown, never, void, undefined, null,
  bigint, object, symbol, string, number, boolean,
];
interface Producer<out T> { produce(): T; }
interface Consumer<in T> { consume(value: T): void; }
type Both = { a: number } & { b: string };
type NamedTuple = [head: number, label?: string, ...tail: boolean[]];
type Fn = (a: number, b?: number) => number;
type Ctor = new (n: number) => { value: number };
type Keys = keyof Both;
type ValueOf<T> = T[keyof T];
type ElementOf<T> = T extends readonly (infer U)[] ? U : never;
type Mutable<T> = { -readonly [K in keyof T]-?: T[K] };
type EventName<T extends string> = `on${Capitalize<T>}`;
type Pair<T = number, U = string> = { first: T; second: U };
type Unique = typeof uniqueKey;

const uniqueKey: unique symbol = Symbol("unique");

class Box {
  constructor(public value: number) {}
}

function identity<const T>(value: T): T {
  return value;
}

function apply(fn: Callable, value: number): number {
  return fn(value);
}

function construct(C: Constructable, value: number): { value: number } {
  return new C(value);
}

function consume(value: PrimitiveUnion): string {
  return value === null ? "null" : typeof value;
}

function main(): void {
  const both: Both = { a: 1, b: "b" };
  const key: Keys = "a";
  const indexed: Indexed = { fixed: 2, optional: "yes", extra: 3 };
  const tuple: NamedTuple = [4, "t", true, false];
  const optionalTuple: OptionalUnnamedTuple = [5];
  const fn: Fn = (a, b = 1) => a + b;
  const C: Ctor = Box;
  const pair: Pair = { first: 5, second: "p" };
  const mutable: Mutable<{ readonly x?: number }> = { x: 6 };
  const event: EventName<"click"> = "onClick";
  const element: ElementOf<number[]> = 7;
  const value: ValueOf<{ a: number; b: number }> = 8;
  const asserted = ({ n: 9 } as const) satisfies { readonly n: number };
  const nonNull: string | null = "ok";
  const unique: Unique = uniqueKey;

  console.log(both[key], indexed.optional, indexed.extra);
  console.log(tuple[0], tuple[1], tuple.slice(2).join(","), optionalTuple.length);
  console.log(fn(10), apply((n) => n * 2, 11), construct(C, 12).value);
  console.log(pair.first, pair.second, mutable.x, event, element, value);
  console.log(identity(asserted).n, nonNull!.toUpperCase(), typeof unique);
  console.log(consume("x"), consume(1), consume(true), consume(null), consume(undefined));
}

main();

export function q(a: number): typeof local {
  const local = { deep: 1 };
  return local;
}
export function ini(a = start()): number {
  function start(): string { return "s"; }
  return 1;
}
export function pat({ a, b } = seed()): void {
  function seed(): { a: number; b: string } { return { a: 1, b: "b" }; }
}
export function fine(a: number, b?: string, ...rest: boolean[]): Promise<number[]> {
  const inner: string = a;
  return Promise.resolve([a]);
}

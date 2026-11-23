export interface Host { name: string; size: number }
export function make(host: Host): { get(): string; n: number } {
  let count = 0;
  const wrong: number = host.name;          // error inside the body
  function inner(x: number): string {
    return x;                                 // error inside the body
  }
  return { get: () => inner(count++), n: host.size };
}
export function plain(a: number, b = 2) {
  return a + b;
}
export const value = make({ name: "x", size: 1 });

export function over(a: number): number;
export function over(a: string): string;
export function over(a: number | string): number | string {
  const bad: boolean = a;
  return a;
}
export async function later(a: number): Promise<string> {
  const v = await a;
  return v;
}
export function* gen(a: number): Generator<number, string, boolean> {
  const got: string = yield a;
  return got;
}
export default function main(flag: boolean): void {
  if (flag) {
    return 1;
  }
}
declare global {
  interface Array<T> { extra(): T }
}
export namespace N {
  export function inNamespace(a: number): string {
    return a;
  }
}

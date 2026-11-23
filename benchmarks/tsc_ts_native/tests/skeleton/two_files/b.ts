import { fromA, A, counter } from "./a";
export class B { count = 1; constructor(public a: A) {} }
export function fromB(a: A): string {
  const n: string = fromA(a.b) + counter;
  return n;
}

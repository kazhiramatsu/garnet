import { fromB, B } from "./b";
export class A { constructor(public b: B) {} run(): string { return fromB(this).length; } }
export function fromA(b: B): number {
  const v: string = b.a.b.count;
  return v;
}
export let counter = 0;

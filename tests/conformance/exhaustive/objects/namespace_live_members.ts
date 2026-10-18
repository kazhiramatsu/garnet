namespace State {
  export let count = 1;
  export let optional: number | undefined;
  export const fixed = 7;
  const { offset, nested: { scale } } = { offset: 2, nested: { scale: 3 } };
  export function increment(): number { count++; return count + offset * scale; }
  export function read(): string { return count + ":" + fixed + ":" + optional; }
}
console.log(State.count, State.increment(), State.count, State.read());
console.log(Object.keys(State).sort().join(","));
State.count = 10;
(State as any).fixed = 9;
State.optional = 3;
console.log(State.increment(), State.read());
namespace State {
  export function again(): number { return count + 1; }
}
console.log(State.again(), State.count);

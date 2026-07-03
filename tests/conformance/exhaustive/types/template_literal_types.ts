type Greeting = `Hello, ${string}!`;
type EventName<T extends string> = `${T}Changed`;
type CssUnit = `${number}px` | `${number}em`;
type Getter<T extends string> = `get${Capitalize<T>}`;

function on<T extends string>(ev: EventName<T>, cb: () => void): string { cb(); return ev; }
function makeGetter<K extends string>(k: K): Getter<K> { return ("get" + k.charAt(0).toUpperCase() + k.slice(1)) as Getter<K>; }

function main(): void {
  const g: Greeting = "Hello, World!";
  console.log(g);                                   // Hello, World!
  let fired = 0;
  console.log(on<"name">("nameChanged", () => { fired++; }), fired); // nameChanged 1
  const c: CssUnit = "10px";
  console.log(c);                                   // 10px
  console.log(makeGetter("value"));                 // getValue
}
main();

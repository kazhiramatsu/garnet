// Conditional, mapped, keyof, indexed-access types are erased at runtime; verify
// codegen is unaffected and values flow correctly.
type ElementType<T> = T extends (infer U)[] ? U : T;
type Flatten<T> = T extends Array<infer Item> ? Item : T;
type Keys<T> = keyof T;
type ValueOf<T> = T[keyof T];
type Stringify<T> = { [K in keyof T]: string };
type Optional<T> = { [K in keyof T]?: T[K] };

interface Cfg { host: string; port: number; secure: boolean; }

function getKey<T, K extends keyof T>(o: T, k: K): T[K] { return o[k]; }

function main(): void {
  const a: ElementType<number[]> = 5;
  const b: Flatten<string[]> = "x";
  const c: Cfg = { host: "h", port: 80, secure: true };
  const s: Stringify<Cfg> = { host: "h", port: "80", secure: "no" };
  const o: Optional<Cfg> = { host: "only" };
  const v: ValueOf<Cfg> = 443;
  console.log(a, b, getKey(c, "host"), getKey(c, "port"), s.port, o.host ?? "?", v);
}
main();

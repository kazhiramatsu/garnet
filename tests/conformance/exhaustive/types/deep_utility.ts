type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
type Awaited2<T> = T extends Promise<infer U> ? Awaited2<U> : T;

interface Config { server: { host: string; ports: number[] }; debug: boolean; }

function freeze<T>(x: DeepReadonly<T>): DeepReadonly<T> { return x; }

function main(): void {
  const c: DeepReadonly<Config> = { server: { host: "h", ports: [80, 443] }, debug: true };
  console.log(c.server.host, c.server.ports[1], c.debug);   // h 443 true
  const p: DeepPartial<Config> = { server: { host: "only" } };
  console.log(p.server?.host ?? "?", p.debug ?? false);     // only false
  const a: Awaited2<Promise<Promise<number>>> = 5;
  console.log(a);                                           // 5
  console.log(freeze({ x: 1 }).x);                          // 1
}
main();

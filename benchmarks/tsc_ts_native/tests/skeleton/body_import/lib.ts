export function lazy(a: number): Promise<number> {
  return import("./extra").then((m) => m.extra + a + m.nothing);
}

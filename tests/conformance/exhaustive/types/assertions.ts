function main(): void {
  const tuple = [1, "two", true] as const;
  console.log(tuple[0], tuple[1], tuple[2]);            // 1 two true
  const obj = { a: 1, b: 2 } as const;
  console.log(obj.a + obj.b);                           // 3
  const x: unknown = "hello";
  console.log((x as string).length);                   // 5
  const y = <number>42;                                 // angle-bracket assertion
  console.log(y + 1);                                   // 43
  const maybe: string | null = "v";
  console.log(maybe!.toUpperCase());                   // V
  const cfg = { port: 8080 } satisfies { port: number };
  console.log(cfg.port);                                // 8080
  const nums = [3, 1, 2];
  console.log(([...nums] as number[]).sort((a, b) => a - b).join(","));  // 1,2,3
}
main();

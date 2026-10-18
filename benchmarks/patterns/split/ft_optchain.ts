interface N { flags: number; parent?: N; name?: string; v: number | string | undefined; }
function main(): void {
  const ns: N[] = []; for (let i = 0; i < 1024; i++) ns.push({ flags: i, parent: i ? ns[i >> 1] : undefined, name: (i & 3) ? "x" : undefined, v: (i % 3 === 0) ? i : (i % 3 === 1) ? "s" : undefined });
  let sum = 0;
  for (let r = 0; r < 32000; r++) for (let i = 0; i < 1024; i++) { const n = ns[i];
    if (n.parent?.parent && n.parent.parent.flags & 1) sum += 2;
  }
  console.log(sum);
}
main();

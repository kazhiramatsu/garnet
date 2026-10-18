// `switch (node.kind)` with many cases (tsc visitors/checker).
interface Nd { kind: number; v: number; }
function visit(n: Nd): number {
  switch (n.kind) {
    case 0: return n.v + 1; case 1: return n.v * 2; case 2: return n.v - 3; case 3: return n.v ^ 5;
    case 4: return n.v + 7; case 5: return n.v * 3; case 6: return n.v - 1; case 7: return n.v | 2;
    case 8: return n.v + 11; case 9: return n.v * 5; case 10: return n.v - 7; case 11: return n.v & 255;
    case 12: return n.v + 13; case 13: return n.v * 7; case 14: return n.v - 9; case 15: return n.v >> 1;
    case 16: return n.v + 17; case 17: return n.v * 11; case 18: return n.v - 13; case 19: return n.v << 1;
    case 20: return n.v + 19; case 21: return n.v * 13; case 22: return n.v - 17; case 23: return n.v % 97;
    case 24: return n.v + 23; case 25: return n.v * 17; case 26: return n.v - 19; case 27: return n.v + 29;
    case 28: return n.v + 31; case 29: return n.v * 19; case 30: return n.v - 23; case 31: return n.v + 37;
    default: return 0;
  }
}
function main(): void {
  const nodes: Nd[] = []; for (let i = 0; i < 4096; i++) nodes.push({ kind: (i * 7) % 33, v: i });
  let sum = 0;
  for (let r = 0; r < 24000; r++) for (let i = 0; i < nodes.length; i++) sum = (sum + visit(nodes[i])) | 0;
  console.log(sum);
}
main();

class Stable { v: number; constructor(v: number) { this.v = v; } get(): number { return this.v; } }
function useStable(s: Stable): number { return s.get(); }
function main(): void {
  const s = new Stable(1);
  console.log(useStable(s));   // 1
}

main();

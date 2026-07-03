class Base { v: number; constructor(v: number) { this.v = v; } describe(): number { return this.v * 2; } }
class Sub extends Base { constructor(v: number) { super(v); } }
function main(): void {
  const s: any = new Sub(21);   // any -> dynamic; describe() inherited from Base
  console.log(s.describe());     // 42
}

main();

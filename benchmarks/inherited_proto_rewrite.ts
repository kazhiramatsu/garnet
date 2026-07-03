class Base { greet(): number { return 1; } }
class Sub extends Base { }
function run(s: any): number { return s.greet(); }
function main(): void {
  const s = new Sub();
  (Base.prototype as any).greet = function() { return 99; };  // 親を書き換え
  console.log(run(s));   // JS: 99 (チェーン経由で親の新メソッドが見える)
}

main();

// GC bench: escape-hardened — 多相呼び出し境界を越えて alloc を渡す。
// per-body の escape/SROA 解析では消せない alloc 圧の下限を測る fixture。
// sink がフィールドに保持するため型駆動最適化が効いてもヒープ alloc は残る。
interface Sink {
  take(o: { a: number; b: number }): number;
}
class KeepSink implements Sink {
  last: { a: number; b: number } | null = null;
  take(o: { a: number; b: number }): number {
    this.last = o; // 保持 → 確実にエスケープ
    return o.a;
  }
}
class SumSink implements Sink {
  sum = 0;
  take(o: { a: number; b: number }): number {
    this.sum = (this.sum + o.b) % 1000000007;
    return o.b;
  }
}
function main(): void {
  const sinks: Sink[] = [new KeepSink(), new SumSink()];
  let acc = 0;
  for (let i = 0; i < 2000000; i++) {
    const o = { a: i, b: i * 3 };
    acc = (acc + sinks[i & 1].take(o)) % 1000000007;
  }
  const k = sinks[0] as KeepSink;
  if (k.last !== null) acc = (acc + k.last.a) % 1000000007;
  console.log("gc_escape_poly " + acc);
}
main();

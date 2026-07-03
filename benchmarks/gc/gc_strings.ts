// GC bench: 文字列構築 churn（concat alloc + 可変長ヒープ）。
// parts 配列に退避してエスケープさせ、fused metric loop への畳み込みを防ぐ
// （消費側も length + 可変位置 charCodeAt の混合で単一 metric 形にしない）。
function main(): void {
  const parts: string[] = [];
  for (let r = 0; r < 150; r++) {
    let s = "";
    for (let i = 0; i < 1500; i++) s += "ab" + (i & 7);
    parts.push(s);
  }
  let total = 0;
  for (let j = 0; j < parts.length; j++) {
    const p = parts[j];
    total += p.length + p.charCodeAt((j * 97) % p.length) + p.charCodeAt((j * 31 + 7) % p.length);
  }
  console.log("gc_strings " + total);
}
main();

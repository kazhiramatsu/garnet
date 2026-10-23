// A scanner's identifier loop over a Uint16Array text, as tsc-ts's scanner does it:
// per code unit a typed-array read, an ASCII identifier-part predicate and an
// FNV-1a step (Math.imul). The hash keeps the loop honest.
function isASCIIIdentifierPart(ch: number): boolean {
  return (ch >= 97 && ch <= 122) || (ch >= 65 && ch <= 90) || (ch >= 48 && ch <= 57) || ch === 36 || ch === 95;
}
class Scanner {
  pos = 0;
  constructor(readonly text: Uint16Array, readonly end: number) {}
  scanIdentifierHash(): number {
    let pos = this.pos | 0;
    const end = this.end | 0;
    const text = this.text;
    let hash = 2166136261 | 0;
    while (pos < end) {
      const ch = text[pos] | 0;
      if (!isASCIIIdentifierPart(ch)) break;
      hash = Math.imul(hash ^ ch, 16777619);
      pos = (pos + 1) | 0;
    }
    this.pos = pos;
    return hash;
  }
}
function main() {
  const n = 4000000;
  const text = new Uint16Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const r = seed % 10;
    text[i] = r === 0 ? 32 : r < 4 ? 97 + (seed % 26) : r < 7 ? 65 + (seed % 26) : 48 + (seed % 10);
  }
  const sc = new Scanner(text, n);
  let acc = 0;
  let idents = 0;
  for (let rep = 0; rep < 10; rep++) {
    sc.pos = 0;
    while (sc.pos < n) {
      const h = sc.scanIdentifierHash();
      acc = (acc + h) | 0;
      idents++;
      sc.pos = (sc.pos + 1) | 0;
    }
  }
  console.log(acc, idents);
}
main();

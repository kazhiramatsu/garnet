function kernel(N: number): number {
  const latin = "é".repeat(128) + "|";
  const face = "😀".repeat(64) + "END";
  const mixed = ("a😀éZ|").repeat(64);
  const pair = "😀é";
  const tail = "éZ";
  const sl = mixed.slice(1, 3);
  const parts = "é-😀-é".split("-");
  const replaced = mixed.replace("😀", "Q");
  const latinLen = latin.length;
  const faceLen = face.length;
  const faceLast = face.lastIndexOf("END", face.length);
  const mixedLast = mixed.lastIndexOf(tail, mixed.length);
  const sliceMetric = sl.length + (sl.codePointAt(0) as number);
  let idx = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    const li = idx & 127;
    sum = sum + latinLen + latin.charCodeAt(li);
    sum = sum + faceLen + face.indexOf("😀", idx & 31) + faceLast;
    sum = sum + mixed.indexOf(pair, idx & 255) + mixedLast;
    sum = sum + sliceMetric;
    idx = (idx + 3) & 255;
    i = i + 1;
  }
  return sum + parts.length + parts[1].length + replaced.length + replaced.indexOf("Q")
    + String.fromCodePoint(0x1f600).length + String.fromCharCode(0xd83d, 0xde00).length;
}

console.log(kernel(1000000));

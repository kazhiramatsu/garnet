function kernel(N: number): number {
  const prefix = "row:";
  const marker = "😀";
  const tail = ":x";
  let sum = 0;
  let last = "";
  let i = 0;
  while (i < N) {
    const s = prefix + i + ":" + marker + tail;
    last = s;
    sum = sum + s.length + s.charCodeAt(0) + s.charCodeAt(s.length - 1) + s.indexOf(marker);
    i = i + 1;
  }
  return sum + last.length + last.indexOf(marker);
}

console.log(kernel(5000000));

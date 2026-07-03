function kernel(N: number): number {
  const block = "0123456789abcdef".repeat(16) + "XYZ";
  const hay = block.repeat(8) + "needle";
  let from = 0;
  let sum = 0;
  let i = 0;
  while (i < N) {
    sum = sum + hay.indexOf("needle", from);
    sum = sum + hay.lastIndexOf("XYZ", hay.length);
    from = from + 19;
    if (from >= 1024) from = from - 1024;
    i = i + 1;
  }
  return sum;
}

console.log(kernel(5000000));

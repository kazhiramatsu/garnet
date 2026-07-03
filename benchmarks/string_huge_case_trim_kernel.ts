function kernel(N: number): number {
  const s = " \t " + "Hello String Kernel 123 xyz ABC ".repeat(4096) + " \n ";
  let sum = 0;
  let i = 0;
  while (i < N) {
    const a = s.trim();
    const b = a.toUpperCase();
    const c = b.toLowerCase();
    sum = sum + c.length + c.charCodeAt(0) + c.charCodeAt(c.length - 1);
    i = i + 1;
  }
  return sum + s.length;
}

console.log(kernel(10000));

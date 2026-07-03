function kernel(N: number): number {
  const s = " \t Hello String Kernel 123 xyz ABC \n ";
  let sum = 0;
  let i = 0;
  let last = "";
  while (i < N) {
    const a = s.trim();
    const b = a.toUpperCase();
    const c = b.toLowerCase();
    last = c;
    sum = sum + c.length + c.charCodeAt(0) + c.charCodeAt(c.length - 1);
    i = i + 1;
  }
  return sum + last.length;
}

console.log(kernel(5000000));

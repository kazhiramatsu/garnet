function mandelbrot(width: number, height: number, maxIter: number): number {
  let checksum = 0;
  let y = 0;
  while (y < height) {
    const ci = (y / height) * 2.4 - 1.2;
    let x = 0;
    while (x < width) {
      const cr = (x / width) * 3.5 - 2.5;
      let zr = 0.0;
      let zi = 0.0;
      let iter = 0;
      while (iter < maxIter) {
        const zr2 = zr * zr;
        const zi2 = zi * zi;
        if (zr2 + zi2 > 4.0) break;
        zi = 2.0 * zr * zi + ci;
        zr = zr2 - zi2 + cr;
        iter = iter + 1;
      }
      checksum = (checksum + iter * (x + 3) + y) % 1000000007;
      x = x + 1;
    }
    y = y + 1;
  }
  return checksum;
}

console.log(mandelbrot(900, 650, 160));

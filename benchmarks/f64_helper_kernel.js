function curve(x) {
  if (x < 0) {
    return -x * 0.5 + 0.125;
  }
  return x * 1.000001 + 0.25;
}

function kernel(N) {
  let acc = 0.0;
  let i = 0;
  while (i < N) {
    const x = (i % 1000) * 0.5;
    acc = acc + curve(x) - curve(x * 0.25);
    i = i + 1;
  }
  return acc;
}

console.log(kernel(50000000));

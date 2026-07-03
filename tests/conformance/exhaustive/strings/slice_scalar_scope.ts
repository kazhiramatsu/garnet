function choose(flag: boolean): number {
  const s = "abcdef";
  let x = s;
  if (flag) {
    x = s.slice(2, 4);
  }
  return x.length + x.charCodeAt(0);
}

console.log(choose(false));
console.log(choose(true));

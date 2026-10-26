// Date.now() and a Date's time value are integral milliseconds (a fractional value leaked
// into a printed elapsed time once); the checks hold under both engines whatever the clock says.
function main(): void {
  const a = Date.now();
  const d = new Date();
  const t = d.getTime();
  console.log(Number.isInteger(a), a % 1 === 0, Number.isInteger(t), t % 1, Number.isInteger(d.valueOf()), a > 1.6e12, t >= a);
  const elapsed = Date.now() - a;
  console.log(Number.isInteger(elapsed), elapsed >= 0, Number.isInteger(elapsed / 1000 * 1000));
}
main();

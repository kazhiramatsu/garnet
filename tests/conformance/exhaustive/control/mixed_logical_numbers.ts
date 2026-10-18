function side(value: { flags: number }): boolean {
  console.log("side", value.flags);
  return false;
}
function guarded(value: { flags: number } | undefined): number {
  if (!value || (value.flags & 2) || side(value)) return 1;
  return 0;
}
console.log(guarded(undefined), guarded({ flags: 0 }), guarded({ flags: 2 }));
function choose(first: boolean, second: boolean): boolean | number {
  return first && 8 || second && 16 || false;
}
for (const first of [false, true]) for (const second of [false, true])
  console.log(choose(first, second), typeof choose(first, second));
function overwrite(value: any): void {
  console.log(value);
  value = 3;
  console.log(value);
  value = "text";
  console.log(value);
}
overwrite(false);

function mark(log: string[], label: string, value: any): any {
  log.push(label);
  return value;
}

function main(): void {
  const log: string[] = [];
  const comma = (mark(log, "a", 1), mark(log, "b", 2));
  const conditional = mark(log, "c", true)
    ? mark(log, "d", 3)
    : mark(log, "e", 4);
  const andValue = mark(log, "f", 1) && mark(log, "g", 5);
  const orValue = mark(log, "h", 0) || mark(log, "i", 6);
  const nullishValue = mark(log, "j", null) ?? mark(log, "k", 7);
  console.log(comma, conditional, andValue, orValue, nullishValue, log.join(""));

  let side = 0;
  const voided = void (side += 2);
  console.log(voided, side);

  const target: any = { x: 1, nested: { value: 8 }, fn(n: number) { return n + 1; } };
  console.log(target?.nested?.value, target.missing?.value, target.fn?.(9));
  console.log(delete target.x, "x" in target, typeof target, target instanceof Object);

  let prefix = 1;
  const prefixResult = ++prefix;
  const postfixResult = prefix++;
  console.log(prefixResult, postfixResult, prefix);

  const bitwise = ((5 & 3) | 8) ^ 2;
  const shifts = [1 << 4, -8 >> 1, -1 >>> 30];
  console.log(bitwise, shifts.join(","), 2 ** 3 ** 2);

  let assignments: any = null;
  assignments ??= 10;
  assignments &&= 11;
  assignments ||= 12;
  assignments += 1;
  console.log(assignments);

  const parenthesized = (((1 + 2) * 3));
  const asserted = (<number>(parenthesized as unknown))!;
  console.log(asserted);
}

main();

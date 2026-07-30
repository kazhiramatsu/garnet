function returnWithoutValue(flag: boolean): number | undefined {
  if (flag) return;
  return 4;
}

function main(): void {
  ; // EmptyStatement

  let scoped = 1;
  {
    let scoped = 2;
    const inner = scoped + 1;
    console.log(scoped, inner);
  }
  console.log(scoped);

  // All three for-header expressions are optional.
  let forever = 0;
  for (;;) {
    forever++;
    if (forever === 3) break;
  }
  let noInit = 0;
  for (; noInit < 2; noInit++) {}
  let noUpdate = 0;
  for (let i = 0; i < 3;) {
    noUpdate += i;
    i++;
  }
  console.log(forever, noInit, noUpdate);

  let whileCount = 0;
  while (whileCount < 2) whileCount++;
  do {
    whileCount++;
  } while (whileCount < 4);
  console.log(whileCount);

  const inherited = Object.create({ inherited: 1 });
  inherited.own = 2;
  const keys: string[] = [];
  for (const key in inherited) keys.push(key);
  console.log(keys.join(","));

  let optionalCatch = "";
  try {
    throw new Error("ignored");
  } catch {
    optionalCatch += "c";
  } finally {
    optionalCatch += "f";
  }
  console.log(optionalCatch, returnWithoutValue(true), returnWithoutValue(false));

  // Default in the middle plus fall-through to the following case.
  let switched = "";
  let switchValue = 9;
  switch (switchValue) {
    case 1:
      switched += "one";
      break;
    default:
      switched += "default-";
    case 2:
      switched += "tail";
  }
  console.log(switched);
}

main();

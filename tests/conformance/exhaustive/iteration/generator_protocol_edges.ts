// Generator lifecycle, re-entry, throw, return-completion, and IteratorClose.
function* values(): Generator<number, number, unknown> {
  try {
    yield 1;
    yield 2;
    return 3;
  } finally {
    console.log("closed");
  }
}

function* cleanupYield(): Generator<number, number, unknown> {
  try {
    yield 1;
  } finally {
    yield 2;
  }
}

function* cleanupOverride(): Generator<number, number, unknown> {
  try {
    yield 1;
  } finally {
    return 7;
  }
}

function main(): void {
  const before = values();
  try {
    before.throw("before");
  } catch (e: any) {
    console.log(e, before.next().done); // before true
  }

  const escaped = values();
  console.log(escaped.next().value); // 1
  try {
    escaped.throw("uncaught");
  } catch (e: any) {
    console.log(e, escaped.next().done); // uncaught true
  }

  let active: Generator<boolean, void, unknown>;
  function* reentrant(): Generator<boolean, void, unknown> {
    try {
      active.next();
    } catch (e: any) {
      yield e instanceof TypeError;
    }
  }
  active = reentrant();
  console.log(active.next().value); // true

  const through = cleanupYield();
  through.next();
  const firstReturn = through.return(9);
  console.log(firstReturn.value, firstReturn.done); // 2 false
  const secondReturn = through.next();
  console.log(secondReturn.value, secondReturn.done); // 9 true

  const override = cleanupOverride();
  override.next();
  const overridden = override.return(9);
  console.log(overridden.value, overridden.done); // 7 true

  let sum = 0;
  for (const value of values()) {
    sum += value;
    if (value === 1) break;
  }
  console.log(sum); // closed, then 1
}

main();

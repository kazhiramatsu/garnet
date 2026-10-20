// Static-slot probes validate a slot's key and attributes with one table per
// access (docs/static_slots_design.md): a read takes any slot that is not an
// accessor, a write only plain writable data. Every other slot falls to the
// inline cache's out-of-line path.

interface Rec {
  a: number;
  b: number;
  c: number;
}

function make(a: number, b: number, c: number): Rec {
  return { a, b, c };
}

function readAll(r: Rec): number {
  return r.a * 100 + r.b * 10 + r.c;
}

function writeB(r: Rec, v: number): string {
  try {
    r.b = v;
    // read back untyped: a setter-only property reads undefined, which a
    // `number` annotation would claim it is not
    return "ok " + String((r as unknown as Record<string, unknown>).b);
  } catch (e) {
    return (e as Error).constructor.name;
  }
}

function main(): void {
  const out: string[] = [];
  const plain = make(1, 2, 3);
  out.push(String(readAll(plain)), writeB(plain, 5), String(readAll(plain)));

  // a read-only data slot: reads hit, writes reject
  const ro = make(1, 2, 3);
  Object.defineProperty(ro, "b", { writable: false });
  out.push(String(readAll(ro)), writeB(ro, 9), String(readAll(ro)));

  // the slot turned into an accessor: reads call the getter, writes the setter
  const acc = make(1, 2, 3);
  let backing = 7;
  Object.defineProperty(acc, "b", {
    get: () => backing,
    set: (v: number) => {
      backing = v * 2;
    },
  });
  out.push(String(readAll(acc)), writeB(acc, 4), String(readAll(acc)));

  // a getter without a setter: the write rejects
  const getOnly = make(1, 2, 3);
  Object.defineProperty(getOnly, "b", { get: () => 8 });
  out.push(String(readAll(getOnly)), writeB(getOnly, 6));

  // a setter without a getter: the read is undefined
  const setOnly = make(1, 2, 3);
  let seen = 0;
  Object.defineProperty(setOnly, "b", {
    set: (v: number) => {
      seen = v;
    },
  });
  out.push(String(readAll(setOnly)), writeB(setOnly, 3), String(seen));

  // frozen and sealed objects
  const frozen = Object.freeze(make(1, 2, 3));
  out.push(String(readAll(frozen)), writeB(frozen, 1));
  const sealed = Object.seal(make(1, 2, 3));
  out.push(writeB(sealed, 4), String(readAll(sealed)));

  // the same sites over all of them again, mixed
  const all = [plain, ro, acc, getOnly, setOnly, frozen, sealed];
  let sum = 0;
  for (let i = 0; i < 40; i++) {
    const r = all[i % all.length];
    sum += readAll(r);
    if (i % 3 === 0) writeB(r, i);
  }
  out.push(String(sum), String(backing), String(seen));
  console.log(out.join(" | "));
}
main();

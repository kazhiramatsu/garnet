function main(): void {
  const keyA: object = { id: "a" };
  const keyB: object = { id: "b" };
  const wm = new WeakMap<object, any>();

  // Basic identity, chaining, replacement, absence, and deletion.
  console.log(wm.set(keyA, { n: 1 }) === wm, wm.has(keyA), wm.get(keyA).n);
  wm.set(keyA, { n: 2 });
  console.log(wm.get(keyA).n, wm.has(keyB), wm.get(keyB));
  console.log(wm.delete(keyA), wm.delete(keyA), wm.has(keyA));
  const identityA = { id: 1 };
  const identityB = { id: 1 };
  wm.set(identityA, undefined).set(identityB, null);
  console.log(wm.has(identityA), wm.get(identityA), wm.has(identityB), wm.get(identityB));

  // Array seeding, duplicate replacement, missing values, null/undefined, and
  // function keys.
  const seededKey: object = { id: "seed" };
  const partialKey: object = { id: "partial" };
  const seeded = new WeakMap<object, any>([
    [seededKey, "first"],
    [seededKey, "ok"],
    [partialKey] as any,
  ]);
  console.log(seeded.get(seededKey), seeded.has(seededKey),
              seeded.has(partialKey), seeded.get(partialKey));
  console.log(new WeakMap<any, any>(undefined).has(keyA),
              new WeakMap<any, any>(null as any).has(keyA));
  const functionKey = (): number => 1;
  seeded.set(functionKey, "function");
  console.log(seeded.get(functionKey));

  function* mapEntries(): Generator<[object, string]> {
    yield [keyA, "generated-a"];
    yield [keyB, "generated-b"];
  }
  const generatedMap = new WeakMap<object, string>(mapEntries());
  console.log(generatedMap.get(keyA), generatedMap.get(keyB));

  // WeakSet mirrors the same identity, chaining, duplicate, constructor, and
  // deletion rules.
  const ws = new WeakSet<object>([keyA, keyB, keyA]);
  console.log(ws.has(keyA), ws.has(keyB), ws.add(keyA) === ws);
  console.log(ws.delete(keyA), ws.delete(keyA), ws.has(keyA), ws.has(keyB));
  function* setEntries(): Generator<object> {
    yield keyA;
    yield keyB;
    yield keyA;
  }
  const generatedSet = new WeakSet<object>(setEntries());
  console.log(generatedSet.has(keyA), generatedSet.has(keyB));
  console.log(wm instanceof WeakMap, ws instanceof WeakSet, wm instanceof WeakSet);

  // First-class prototype methods and any-typed dispatch use the same runtime
  // prototypes as the typed fast path.
  const get = WeakMap.prototype.get;
  const has = WeakSet.prototype.has;
  console.log(get.call(seeded, seededKey), has.call(ws, keyB));
  const dyn: any = seeded;
  console.log(dyn.get(seededKey), dyn.has({ id: "seed" }));

  // Every primitive insertion is rejected. Primitive queries never throw and
  // report absence.
  const invalidKeys: any[] = [undefined, null, false, 0, "x"];
  let mapTypeErrors = "";
  let setTypeErrors = "";
  let absentQueries = true;
  for (const invalid of invalidKeys) {
    try { (wm as any).set(invalid, "bad"); }
    catch (e: any) { mapTypeErrors += e.name + ","; }
    try { (ws as any).add(invalid); }
    catch (e: any) { setTypeErrors += e.name + ","; }
    absentQueries = absentQueries &&
      !(wm as any).has(invalid) &&
      (wm as any).get(invalid) === undefined &&
      !(wm as any).delete(invalid) &&
      !(ws as any).has(invalid) &&
      !(ws as any).delete(invalid);
  }
  console.log(mapTypeErrors, setTypeErrors, absentQueries);

  let mapSeedTypeError = "";
  let mapEntryTypeError = "";
  let setSeedTypeError = "";
  try { new WeakMap<any, any>([[1, "bad"]]); } catch (e: any) { mapSeedTypeError = e.name; }
  try { new WeakMap<any, any>([7] as any); } catch (e: any) { mapEntryTypeError = e.name; }
  try { new WeakSet<any>([1]); } catch (e: any) { setSeedTypeError = e.name; }
  console.log(mapSeedTypeError, mapEntryTypeError, setSeedTypeError);

  // All prototype methods enforce the WeakMap/WeakSet brand, including when
  // borrowed with Function.prototype.call.
  let brandErrors = "";
  try { (WeakMap.prototype.set as any).call(new Map(), keyA, 1); }
  catch (e: any) { brandErrors += e.name + ","; }
  try { (WeakMap.prototype.get as any).call(new Map(), keyA); }
  catch (e: any) { brandErrors += e.name + ","; }
  try { (WeakMap.prototype.has as any).call(new Map(), keyA); }
  catch (e: any) { brandErrors += e.name + ","; }
  try { (WeakMap.prototype.delete as any).call(new Map(), keyA); }
  catch (e: any) { brandErrors += e.name + ","; }
  try { (WeakSet.prototype.add as any).call(new Set(), keyA); }
  catch (e: any) { brandErrors += e.name + ","; }
  try { (WeakSet.prototype.has as any).call(new Set(), keyA); }
  catch (e: any) { brandErrors += e.name + ","; }
  try { (WeakSet.prototype.delete as any).call(new Set(), keyA); }
  catch (e: any) { brandErrors += e.name + ","; }
  console.log(brandErrors);

  // ES2023 CanBeHeldWeakly: ordinary and well-known Symbols are valid weak
  // keys. Global-registry Symbols are not collectible and are rejected.
  const symbolA = Symbol("same-description");
  const symbolB = Symbol("same-description");
  const symbolMap: any = new WeakMap<any, any>([[symbolA, "seeded-symbol"]]);
  const symbolSet: any = new WeakSet<any>([symbolA, symbolA]);
  symbolMap.set(symbolB, "second-symbol");
  symbolSet.add(symbolB);
  console.log(symbolMap.get(symbolA), symbolMap.get(symbolB),
              symbolSet.has(symbolA), symbolSet.has(symbolB));
  console.log(symbolMap.delete(symbolA), symbolMap.has(symbolA),
              symbolSet.delete(symbolA), symbolSet.has(symbolA));

  const wellKnown = Symbol.iterator;
  symbolMap.set(wellKnown, "well-known");
  symbolSet.add(wellKnown);
  console.log(symbolMap.get(wellKnown), symbolSet.has(wellKnown));

  const registered = Symbol.for("weak-collection-registered");
  let registeredMapError = "";
  let registeredSetError = "";
  try { symbolMap.set(registered, "bad"); }
  catch (e: any) { registeredMapError = e.name; }
  try { symbolSet.add(registered); }
  catch (e: any) { registeredSetError = e.name; }
  console.log(registeredMapError, registeredSetError,
              symbolMap.has(registered), symbolMap.get(registered),
              symbolMap.delete(registered),
              symbolSet.has(registered), symbolSet.delete(registered));

  // Weak collections expose neither entries nor size and stringify as ordinary
  // objects with no enumerable weak entries.
  console.log(typeof (wm as any).entries, typeof (wm as any).keys,
              typeof (wm as any).values, typeof (wm as any).forEach,
              typeof (wm as any).clear, typeof (wm as any).size,
              typeof (wm as any)[Symbol.iterator]);
  console.log(typeof (ws as any).entries, typeof (ws as any).keys,
              typeof (ws as any).values, typeof (ws as any).forEach,
              typeof (ws as any).clear, typeof (ws as any).size,
              typeof (ws as any)[Symbol.iterator]);
  console.log(JSON.stringify(wm), Object.keys(wm).length);
}

main();

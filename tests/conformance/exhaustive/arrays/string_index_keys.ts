// Element access on an array (or a string) with a key that is not typed as a
// number: a string key from for..in, an index held in a string, an `any` or a
// union key. The key is a property key after ToPropertyKey, so a canonical
// index string reaches the element and any other string a named property.
// (The element fast path read its key as a raw number: every such access
// read and wrote element 0.)
function main(): void {
  const a = [10, 20, 30];
  const k = "1";
  console.log(a[k as any], a[2 as any], a["x" as any]);
  for (const i in a) console.log(i, a[i as any]);

  const d: any[] = [];
  d[3] = { id: 9 };
  d[100000] = { id: 7 };
  for (const i in d) console.log(i, d[i] === undefined ? "undef" : d[i].id);

  // writes through string keys reach the element, not element 0
  const w: number[] = [1, 2, 3];
  const two = "2";
  (w as any)[two] = 33;
  w[k as any] += 100;
  w["0" as any]++;
  console.log(w.join(","), w.length);
  const named = "tag";
  (w as any)[named] = "t";
  console.log(w.length, (w as any).tag, Object.keys(w).join(","));

  // a union and an any key
  const pick = (x: number | string): number => a[x as any];
  console.log(pick(0), pick("1"), pick(2));
  const anyKey: any = "2";
  console.log(a[anyKey], d[anyKey]);

  // string receivers
  const s = "hello";
  const len = "length";
  const one = "1";
  console.log((s as any)[len], (s as any)[one], s[1]);

  // numeric keys keep the element path
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i];
  console.log(sum);
}
main();

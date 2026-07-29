// A computed-key site cycles through more keys than the four-entry PIC can
// retain. The runtime should settle on its indexed megamorphic fallback instead
// of returning to a linear scan of the object's property vector.
const dictionary: any = {};
const keys: string[] = [];
for (let i = 0; i < 32; i++) {
  const key = `p${i}`;
  dictionary[key] = i;
  keys.push(key);
}

let total = 0;
for (let i = 0; i < 3_200_000; i++) {
  total += dictionary[keys[i & 31]];
}
console.log(total);

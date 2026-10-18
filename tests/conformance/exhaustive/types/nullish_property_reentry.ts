interface Cache { value?: { id: number } }
function initialize(cache: Cache): void { cache.value = { id: 7 }; }
function read(cache: Cache): number {
  if (!cache.value) {
    initialize(cache);
    if (!cache.value) cache.value = { id: 9 };
  }
  return cache.value.id;
}
console.log(read({}));
const absent: undefined = undefined;
const empty: null = null;
console.log(absent === undefined, empty === null, typeof absent, typeof empty);
function nothing(): void {}
console.log(nothing() === undefined);

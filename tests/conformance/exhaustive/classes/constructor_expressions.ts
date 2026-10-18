class Item {
  value: number;
  constructor(value: number) { this.value = value; }
  read(): number { return this.value; }
}
function getConstructor(): typeof Item { return Item; }
let cached: typeof Item | undefined;
console.log(new (cached || (cached = getConstructor()))(7).read());
console.log(new (getConstructor())(8).read());
const holder = { make: Item };
console.log(new holder.make(9).read());
const constructors = [Item];
console.log(new constructors[0](10).read());
const args: [number] = [11];
console.log(new (getConstructor())(...args).read());
const invalid: any = 123;
try { new (invalid as any)(); }
catch (error) { console.log(error instanceof TypeError); }

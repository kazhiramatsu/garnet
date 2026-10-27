// A module-level `const f = NS.member` naming a builtin function is called as the builtin itself
// (vue's `isArray = Array.isArray`, `extend = Object.assign`), and `const m = Object.prototype.X`
// makes `m.call(x, ...)` the runtime's implementation; the value forms, the argument counts the
// builtin does not take, a spread, a shadowing local and the TDZ keep JS's behavior.
const isArray = Array.isArray;
const keys = Object.keys;
const assign = Object.assign;
const max = Math.max;
const floor = Math.floor;
const isInt = Number.isInteger;
const fromCodes = String.fromCharCode;
const now = Date.now;
const hasOwnProperty = Object.prototype.hasOwnProperty;
const objectToString = Object.prototype.toString;
const hasOwn = (val: object, key: string | symbol): boolean => hasOwnProperty.call(val, key);
const toTypeString = (value: unknown): string => objectToString.call(value);
const toRawType = (value: unknown): string => toTypeString(value).slice(8, -1);
function early(): number { return lateMax(1, 2); }
function main(): void {
  console.log(isArray([]), isArray("no"), isArray(new Proxy([], {})), keys({ a: 1, b: 2 }).join(","));
  console.log(JSON.stringify(assign({ x: 1 }, { y: 2 }, { z: 3 })), max(3, 9, 4), max(), floor(2.7), isInt(5), isInt(5.5), fromCodes(72, 105));
  console.log(typeof now(), now() > 0);
  const o = { a: 1, __typename: "T" }; const arr = [1, 2];
  console.log(hasOwn(o, "a"), hasOwn(o, "toString"), hasOwn(o, "__typename"), hasOwn(arr, "length"), hasOwn(arr, "0" as any), hasOwn(arr, "2" as any));
  console.log(toTypeString(null), toTypeString(undefined), toTypeString(1), toTypeString("s"), toTypeString([]), toTypeString(new Map()), toTypeString(new Date(0)), toTypeString(/x/), toTypeString(() => 1), toTypeString(Promise.resolve()));
  console.log(toRawType(new Set()), toRawType({}), toRawType(Symbol("s")), toRawType(true));
  try { hasOwn(null as any, "a"); } catch (e) { console.log((e as Error).constructor.name); }
  // the value forms: an alias passed as a callback or held in a table calls through the value
  console.log([1, 2.5, 3].filter(isInt).join(","), [[1], 2, [3]].map(isArray).join(","), [1.9, 2.1].map(floor).join(","));
  const table: Record<string, (x: any) => any> = { isArray, keys };
  console.log(table.isArray([1]), table.keys({ q: 1 }).join(","), (0, isArray)([]), typeof isArray, isArray.length, isArray.name);
  // a spread and an argument count without a static form keep the value call
  const nums = [4, 8, 2];
  console.log(max(...nums), Math.max.apply(null, nums), keys.call(null, { s: 1 }).join(","), (assign as any)({}).constructor === Object);
  // a shadowing local is a different function
  { const isArray = (x: unknown): string => "shadow:" + typeof x; console.log(isArray([])); }
  function inner(keys: (o: object) => string[]): string { return keys({ i: 1 }).join("+") + "!"; }
  console.log(inner((o) => ["only"]), inner(keys));
  // a call before the alias's declaration in module order is a ReferenceError
  try { console.log(early()); } catch (e) { console.log((e as Error).constructor.name); }
}
main();
const lateMax = Math.max;

const object: any = { a: 1, b: 2 };
let calls = 0;
const key: any = { toString() { calls++; return "a"; } };
console.log(delete object[key], calls, "a" in object, object.b);
const symbol = Symbol("key");
object[symbol] = 3;
console.log(delete object[symbol], object[symbol]);
const array: any = [1, 2, 3];
let index = 1;
console.log(delete array[index], array.length, index in array, array.join(","));
const sealed: any = Object.seal({ a: 1 });
const name = "a";
try { delete sealed[name]; }
catch (error) { console.log(error instanceof TypeError, sealed.a); }
let base: any = { x: 1 };
const original = base;
function changeBase(): string { base = { x: 2 }; return "x"; }
console.log(delete base[changeBase()], original.x, base.x);
class Receiver { method(): number { return 7; } }
const receiver: any = new Receiver();
const methodName = "method";
console.log(receiver.method());
console.log(delete (Receiver.prototype as any)[methodName]);
try { receiver.method(); }
catch (error) { console.log(error instanceof TypeError); }

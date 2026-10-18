const text = "a😀b\0c";
const inputs: any[] = [undefined, NaN, Infinity, -Infinity, -20, -2.8, -0, 0, 1.9, 4, 20];
const results: string[] = [];
for (const start of inputs) {
  for (const length of inputs) {
    const part = text.substr(start, length);
    let units = "";
    for (let i = 0; i < part.length; i++) units += part.charCodeAt(i) + ":";
    results.push(units);
  }
}
console.log(results.join("|"));
console.log(JSON.stringify(text.substr(-2)), text.toString() === text, text.valueOf() === text);
console.log(String.prototype.substr.call(12345, 1, 3));
const trace: string[] = [];
const receiver: any = { toString() { trace.push("string"); return "abcdef"; } };
const start: any = { valueOf() { trace.push("start"); return 1; } };
const length: any = { valueOf() { trace.push("length"); return 3; } };
console.log(String.prototype.substr.call(receiver, start, length), trace.join(","));
console.log(String.prototype.toString.call("ok"), String.prototype.valueOf.call("value"));
for (const receiver of [null, undefined, 42, {}]) {
  try { console.log(String.prototype.toString.call(receiver)); }
  catch (error) { console.log(error instanceof TypeError); }
}

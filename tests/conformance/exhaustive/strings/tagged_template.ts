let value: unknown;
function tag(strings: TemplateStringsArray, ...values: unknown[]): TemplateStringsArray {
  value = values[0];
  return strings;
}
function call(input: unknown): TemplateStringsArray { return tag`head\n${input}tail`; }
const object = { id: 1 };
const first = call(object);
console.log(value === object, JSON.stringify(first), JSON.stringify(first.raw));
console.log(first === call(42), value, Object.isFrozen(first), Object.isFrozen(first.raw));
console.log(first === tag`head\n${0}tail`, first.raw === call(0).raw);
const rawDescriptor = Object.getOwnPropertyDescriptor(first, "raw")!;
console.log(rawDescriptor.enumerable, rawDescriptor.writable, rawDescriptor.configurable);
try { (first as any)[0] = "changed"; }
catch (error) { console.log(error instanceof TypeError); }
const receiver = {
  prefix: "bound",
  method(strings: TemplateStringsArray, input: unknown) { return this.prefix + ":" + strings[0] + input; },
};
console.log(receiver.method`x${7}`, receiver["method"]`y${8}`);
function invalid(strings: TemplateStringsArray): void {
  console.log(strings[0] === undefined, strings.raw[0]);
}
invalid`\u{}`;

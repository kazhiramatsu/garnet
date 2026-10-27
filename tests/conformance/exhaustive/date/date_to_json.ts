// Date.prototype.toJSON (the ISO string, null for an invalid date) and JSON.stringify of a Date
// (through it), with a user toJSON for comparison; an invalid date's toISOString is a catchable RangeError.
function main(): void {
  const d = new Date(0);
  console.log(d.toJSON(), JSON.stringify(d), JSON.stringify({ when: d, n: 1 }), JSON.stringify([d, new Date(86400000)]));
  const bad = new Date(NaN);
  console.log(bad.toJSON(), JSON.stringify(bad), JSON.stringify({ when: bad }));
  try { console.log(bad.toISOString()); } catch (e) { console.log((e as Error).constructor.name, (e as Error).message); }
  const custom = { toJSON(): string { return "custom"; }, d };
  console.log(JSON.stringify({ custom, list: [d] }), JSON.stringify(d, null, 2), JSON.stringify({ d }, ["d"]));
  console.log(JSON.stringify({ d }, (k, v) => (k === "d" ? typeof v : v)));
  const nested = { a: { b: { when: new Date(1234567890123) } } };
  console.log(JSON.stringify(nested), typeof d.toJSON(), d.toJSON().length);
}
main();

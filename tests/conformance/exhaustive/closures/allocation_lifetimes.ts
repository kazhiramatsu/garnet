// Captured cells and old containers must retain young values under ordinary
// allocation pressure. No explicit collection or threshold override is used.
interface Entry { value: number; }
const keep: Entry[] = [];
function churn(): void {
  for (let i = 0; i < 150000; i++) keep[i & 31] = { value: i };
}
function capture(value: number): () => number {
  const entry: Entry = { value };
  return () => entry.value;
}
function main(): void {
  const read = capture(137);
  const rows: Entry[] = [];
  const table = new Map<number, Entry>();
  for (let i = 0; i < 512; i++) {
    rows.push({ value: i });
    table.set(i, { value: i });
  }
  churn();
  rows[511] = { value: 1001 };
  rows.reverse();
  table.set(511, { value: 1002 });
  for (let i = 0; i < 300; i++) table.delete(i);
  churn();
  console.log(read(), rows[0].value, table.get(511)!.value, rows.length, table.size);
  table.clear();
  table.set(0, { value: 1003 });
  rows.copyWithin(511, 0, 1);
  rows[0] = { value: 1004 };
  churn();
  console.log(read(), rows[0].value, rows[511].value, table.get(0)!.value);
}
main();

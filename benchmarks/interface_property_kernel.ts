interface Entry {
  left: number;
  right: number;
  bump(value: number): number;
}

function bump(value: number): number { return value + 1; }

const entries: Entry[] = [];
for (let i = 0; i < 32; i++) {
  const entry: Entry = { left: i, right: i + 1, bump };
  const dynamic: any = entry;
  dynamic["extra" + i] = i;
  if (i & 1) delete dynamic["extra" + i];
  entries.push(entry);
}

let total = 0;
for (let i = 0; i < 2000000; i++) {
  const entry = entries[i & 31];
  total += entry.left + entry.right + entry.bump(i & 7);
  entry.left += 1;
}
console.log(total);

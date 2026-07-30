// Single-shot module allocations that escape to a process-lifetime root are
// pretenuring candidates. The loop allocation and returned allocation are not:
// they may execute repeatedly and must retain the normal nursery policy.
const processRoot: any = {
  child: { value: 41 },
  values: [1, 2, 3],
};
(globalThis as any).__pretenure_process_root = processRoot;

function makeReturned(value: number): any {
  return { value };
}

let checksum = 0;
for (let i = 0; i < 2000; i++) {
  const temporary: any = { value: i };
  checksum += temporary.value;
}

const returned: any = makeReturned(7);
console.log(
  (globalThis as any).__pretenure_process_root.child.value,
  processRoot.values.join(","),
  returned.value,
  checksum,
);

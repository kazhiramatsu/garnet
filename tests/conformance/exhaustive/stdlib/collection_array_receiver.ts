const stack: Map<string, number>[] = [];
stack.push(new Map([["key", 7]]));
console.log(stack.length, stack.pop()!.get("key"), stack.length);
const sets: Set<number>[] = [];
sets.push(new Set([4, 5]));
console.log(sets.shift()!.has(5), sets.length);
const maps: readonly Map<string, number>[] = [new Map([["k", 9]])];
console.log(maps.map(m => m.get("k")).join(","));

export let current = 3;
export function read(): number { return current; }
export function update(value: number): void { current = value; }

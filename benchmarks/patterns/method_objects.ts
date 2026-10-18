// Objects with function-valued properties called through the property (host/factory style).
interface Host { read(k: number): number; has(k: number): boolean; count: number; }
function makeHost(base: number): Host { let count = 0; return { read: (k) => { count++; return k + base; }, has: (k) => (k & 1) === 0, get count() { return count; } } as Host; }
function main(): void {
  const hosts: Host[] = []; for (let i = 0; i < 16; i++) hosts.push(makeHost(i));
  let sum = 0;
  for (let r = 0; r < 2400000; r++) { const h = hosts[r & 15]; if (h.has(r)) sum += h.read(r & 1023); else sum += h.read(1); }
  console.log(sum, hosts[0].count);
}
main();

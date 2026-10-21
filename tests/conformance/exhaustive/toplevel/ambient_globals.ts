// Values the environment provides (`declare global`, `declare var`, an
// ambient namespace): reads, calls and writes go through the global object.
// They used to read a local nothing assigns (undefined) and to write it.
declare global {
  var hostValue: number | undefined;
  function hostDouble(x: number): number;
  namespace hostTools { function shout(s: string): string; }
}
declare var hostCounter: number;
const g = globalThis as any;
g.hostValue = 41;
g.hostDouble = (x: number) => x * 2;
g.hostTools = { shout: (s: string) => s.toUpperCase() + "!" };
g.hostCounter = 0;
console.log(hostValue! + 1, typeof hostValue, hostDouble(21), hostTools.shout("hi"));
hostValue = 7;
console.log(g.hostValue, hostValue);
hostCounter++;
hostCounter += 10;
console.log(hostCounter, g.hostCounter);
function bump(): number { return ++hostCounter; }
console.log(bump(), bump(), g.hostCounter);
g.hostValue = 99;
console.log(hostValue);
delete g.hostDouble;
console.log(typeof hostDouble);
try { hostDouble(1); } catch (e) { console.log((e as Error).constructor.name, (e as Error).message); }
declare var hostMissing: number;
try { console.log(hostMissing); } catch (e) { console.log((e as Error).constructor.name, (e as Error).message); }
try { hostMissing = 1; } catch (e) { console.log((e as Error).constructor.name, (e as Error).message); }
console.log(typeof hostMissing, typeof (hostMissing), "hostMissing" in g);
export {};

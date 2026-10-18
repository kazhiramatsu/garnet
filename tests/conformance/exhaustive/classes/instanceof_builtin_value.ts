const arrayConstructor: any = Array;
console.log([] instanceof arrayConstructor, {} instanceof arrayConstructor);
console.log([] instanceof Array, Array.prototype instanceof arrayConstructor);
const arrow: any = () => 0;
console.log((0 as any) instanceof arrow, (null as any) instanceof arrow);
try { console.log({} instanceof arrow); }
catch (error) { console.log((error as Error).name); }

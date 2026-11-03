console.log("tla start");
export const x = await new Promise<number>((r) => setTimeout(() => r(5), 1));
export const y = await Promise.resolve(x + 1);
console.log("tla end");

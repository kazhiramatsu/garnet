async function* g(): AsyncGenerator<number> { try { yield 1; yield 2; } finally { console.log("ag-cleanup"); } }
async function main(): Promise<void> { let o=""; for await (const x of g()) o=o+x; console.log(o); }

main();

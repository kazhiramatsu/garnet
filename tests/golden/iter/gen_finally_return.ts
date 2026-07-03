function* g(): Generator<number> { try { yield 1; yield 2; return; } finally { console.log("gen-finally"); } }
function main(): void { for (const x of g()) console.log(x); }

main();

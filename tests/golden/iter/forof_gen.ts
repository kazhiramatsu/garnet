function* g(): Generator<number> { yield 1; yield 2; yield 3; }
function main(): void { let o=""; for (const x of g()) o=o+x+","; console.log(o); }

main();

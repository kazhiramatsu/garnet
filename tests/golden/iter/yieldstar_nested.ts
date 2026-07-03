function* a(): Generator<number> { yield 1; yield 2; }
function* b(): Generator<number> { yield 0; yield* a(); yield 3; }
function* c(): Generator<number> { yield* b(); yield 4; }
function main(): void { let o=""; for (const x of c()) o=o+x+","; console.log(o); }

main();

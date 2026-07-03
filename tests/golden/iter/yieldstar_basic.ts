function* inner(): Generator<number> { yield 1; yield 2; yield 3; }
function* outer(): Generator<number> { yield 0; yield* inner(); yield 4; }
function main(): void { let o=""; for (const x of outer()) o=o+x+","; console.log(o); }

main();

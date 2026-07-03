function* inner(): Generator<number> { yield 1; yield 2; return 99; }
function* outer(): Generator<number> { const r = yield* inner(); yield r; }
function main(): void { let o=""; for (const x of outer()) o=o+x+","; console.log(o); }

main();

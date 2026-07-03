async function* inner(): AsyncGenerator<number> { yield 10; yield 20; }
async function* outer(): AsyncGenerator<number> { yield 5; yield* inner(); yield 30; }
async function main(): Promise<void> { let o=""; for await (const x of outer()) o=o+x+","; console.log(o); }

main();

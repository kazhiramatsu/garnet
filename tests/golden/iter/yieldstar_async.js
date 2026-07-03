async function* inner() { yield 10; yield 20; }
async function* outer() { yield 5; yield* inner(); yield 30; }
async function main() { let o = ""; for await (const x of outer())
    o = o + x + ","; console.log(o); }
main();

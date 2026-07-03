async function* nums() { let i = 0; while (true) {
    yield i;
    i = i + 1;
} }
async function main() { let s = 0; for await (const x of nums()) {
    if (x >= 5)
        break;
    s = s + x;
} console.log(s); }
main();

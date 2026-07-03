function main() {
    console.log(10 % 3);
    console.log(10.5 % 3);
    console.log(7 % 0);
    console.log((-7) % 3);
    let x = 0;
    for (let i = 0; i < 5; i++) {
        x = (x + i * 7) % 13;
    }
    console.log(x);
}
main();

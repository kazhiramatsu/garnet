let s = 0;
for (let i = 0; i < 3; i++) { s += await Promise.resolve(i); }
console.log(s);

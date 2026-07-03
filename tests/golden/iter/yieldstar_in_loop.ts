function* pair(x:number): Generator<number> { yield x; yield x*10; }
function* outer(): Generator<number> { for(let i=1;i<=3;i++) yield* pair(i); }
function main(): void { let o=""; for (const x of outer()) o=o+x+","; console.log(o); }

main();

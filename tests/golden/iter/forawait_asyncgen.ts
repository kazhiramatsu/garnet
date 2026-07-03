async function* counter(n:number): AsyncGenerator<number> { for(let i=0;i<n;i++) yield i; }
async function main(): Promise<void> { let s=0; for await (const x of counter(5)) s=s+x; console.log(s); }

main();

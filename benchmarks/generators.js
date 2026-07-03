function* accum(){let total=0;const a=yield total;total+=a;const b=yield total;total+=b;return total;}
function main(){const g=accum();console.log(g.next().value);console.log(g.next(10).value);const r2=g.next(5);console.log(r2.value);console.log(r2.done?1:0);}
main();

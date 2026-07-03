function* range(n){for(let i=0;i<n;i++)yield i;}
function main(){let sum=0;for(const i of range(3)){for(const j of range(3)){sum=sum+i*10+j;}}console.log(sum);let count=0;for(const a of range(2)){for(const b of range(2)){for(const c of range(2)){count++;}}}console.log(count);}
main();

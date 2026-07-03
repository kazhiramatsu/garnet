async function double(x){return x*2;}
async function main(){let sum=0;for(let i=1;i<=4;i++){sum=sum+await double(i);}console.log(sum);}
main();

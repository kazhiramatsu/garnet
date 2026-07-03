function pick(x){return x;}
function kernel(N){let sum=0,i=0;while(i<N){sum=(sum+pick(i%1000))%1000007;i=i+1;}return sum;}
function main(){console.log(kernel(100000000));} main();

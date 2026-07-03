class Point{constructor(x){this.x=x;}}
function sink(p){return p.x;}
function kernel(N){let sum=0,i=0;while(i<N){const p=new Point(i%100);sum=(sum+sink(p))%1000007;i=i+1;}return sum;}
function main(){console.log(kernel(20000000));} main();

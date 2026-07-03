async function double(x){return x*2;}
async function compute(){let sum=0;const a=await double(5);sum+=a;const b=await double(a);sum+=b;return sum;}
async function main(){console.log("start");const r=await compute();console.log(r);console.log("end");}
main();

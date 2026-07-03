async function fetchVal(i){return i*10;}
async function* pipeline(n){for(let i=0;i<n;i++){const v=await fetchVal(i);yield v+1;}}
async function main(){let out="";for await(const x of pipeline(4))out=out+x+",";console.log(out);}
main();

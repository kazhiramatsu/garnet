async function ok(){return 10;}
async function bad(){throw "rejected!";}
async function main(){try{const r=await ok();console.log(r);}catch(e){console.log("caught: "+e);}try{const r=await bad();console.log("unreachable "+r);}catch(e){console.log("caught: "+e);}console.log("done");}
main();

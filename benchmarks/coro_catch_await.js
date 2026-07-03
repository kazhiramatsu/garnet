async function bad(){throw "fail";}
async function recover(){return 99;}
async function main(){try{const r=await bad();console.log("unreachable "+r);}catch(e){console.log("caught: "+e);const fallback=await recover();console.log("fallback: "+fallback);}console.log("done");}
main();

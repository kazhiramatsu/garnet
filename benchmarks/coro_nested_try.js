async function ok(){return 5;}
async function bad(){throw "inner-fail";}
async function main(){try{const a=await ok();try{const b=await bad();console.log("unreachable "+b);}catch(e){console.log("inner: "+e);}console.log("after inner: "+a);}catch(e){console.log("outer: "+e);}console.log("---");try{const a=await ok();try{const b=await bad();console.log("unreachable "+b);}catch(e){console.log("inner caught, rethrowing");throw "outer-fail";}}catch(e){console.log("outer: "+e);}console.log("done");}
main();

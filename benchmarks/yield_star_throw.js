function* inner(){try{yield 1;yield 2;}catch(e){console.log("inner caught "+e);yield 99;}}
function* outer(){yield* inner();}
const g=outer();console.log(g.next().value);console.log(g.throw("boom").value);

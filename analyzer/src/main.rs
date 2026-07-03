//! tsaot analyzer+codegen driver.
//! Usage:
//!   tsaot <program.json> emit      -> print generated C to stdout
//!   tsaot <program.json> escape    -> print escape result JSON
//!   tsaot <program.json> report    -> print codegen strategy report JSON
mod call_graph;
mod codegen;
mod devirt;
mod emit_c;
mod escape_ir;
mod interproc;
mod sroa;
mod string_materialization;
mod string_metrics;
mod string_plan;

use devirt::run_devirt;
use escape_ir::Program;
use interproc::analyze_program;
use std::fs;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = match args.get(1) {
        Some(p) => p,
        None => {
            eprintln!("usage: tsaot <program.json> [emit|escape|report]");
            std::process::exit(2);
        }
    };
    let mode = args.get(2).map(|s| s.as_str()).unwrap_or("emit");
    let src = fs::read_to_string(path).expect("read program.json");
    // The self-hosted analyzer source lowers its big switch statements to deeply
    // nested If chains; the resulting IR JSON exceeds serde_json's default
    // recursion limit. Parse with the limit disabled + a growable stack
    // (serde_stacker) — parse capability only, no analysis change.
    let mut de = serde_json::Deserializer::from_str(&src);
    de.disable_recursion_limit();
    let de = serde_stacker::Deserializer::new(&mut de);
    let mut prog: Program = serde::Deserialize::deserialize(de).expect("parse Program json");
    let _ = run_devirt(&mut prog, true);
    let res = analyze_program(&prog);
    // Scalar-replace NoEscape class instances + inline their methods/ctors before
    // codegen, so the object is eliminated and emit_c keeps everything in scalars.
    if mode == "emit" {
        sroa::run_sroa(&mut prog, &res);
    }
    match mode {
        "emit" => print!("{}", emit_c::emit_program(&prog, &res)),
        // Differential target for the self-hosting TS devirt port: the IR after
        // run_devirt (callee rewrites applied, pre-sroa), as JSON.
        "devirt" => print!("{}", serde_json::to_string(&prog).unwrap()),
        // Differential target for the self-hosting TS SROA port: the IR after
        // devirt + escape + run_sroa, as JSON.
        "sroa" => {
            sroa::run_sroa(&mut prog, &res);
            print!("{}", serde_json::to_string(&prog).unwrap());
        }
        "escape" => println!("{}", serde_json::to_string(&res).unwrap()),
        "report" => println!(
            "{}",
            serde_json::to_string(&codegen::report(&prog, &res)).unwrap()
        ),
        other => {
            eprintln!("unknown mode: {}", other);
            std::process::exit(2);
        }
    }
}

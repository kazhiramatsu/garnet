//! tsaot analyzer+codegen driver.
//! Usage:
//!   tsaot <program.json> emit      -> print generated C to stdout
//!   tsaot <program.json> emit --units <dir>
//!                                  -> write the C as parallel units into <dir>
//!                                     (docs/build_split_design.md); the build
//!                                     order is printed, one unit per line
//!   tsaot <program.json> escape    -> print escape result JSON
//!   tsaot <program.json> report    -> print codegen strategy report JSON
mod c_units;
mod call_graph;
mod codegen;
mod devirt;
mod emit_c;
mod escape_ir;
mod interproc;
mod rx_native;
mod sroa;
mod string_accum;
mod string_materialization;
mod string_metrics;
mod string_plan;

use devirt::run_devirt;
use escape_ir::Program;
use interproc::analyze_program;
use std::fs;
use std::time::Instant;

fn report_phase(enabled: bool, started: &mut Instant, phase: &str) {
    if enabled {
        eprintln!(
            "tsaot phase={} milliseconds={:.3}",
            phase,
            started.elapsed().as_secs_f64() * 1000.0
        );
        *started = Instant::now();
    }
}

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
    let timings = std::env::var("TSAOT_PHASE_TIMINGS").as_deref() == Ok("1");
    let mut phase_started = Instant::now();
    let src = fs::read_to_string(path).expect("read program.json");
    report_phase(timings, &mut phase_started, "read");
    // The self-hosted analyzer source lowers its big switch statements to deeply
    // nested If chains; the resulting IR JSON exceeds serde_json's default
    // recursion limit. Parse with the limit disabled + a growable stack
    // (serde_stacker) — parse capability only, no analysis change.
    let mut de = serde_json::Deserializer::from_str(&src);
    de.disable_recursion_limit();
    let de = serde_stacker::Deserializer::new(&mut de);
    let mut prog: Program = serde::Deserialize::deserialize(de).expect("parse Program json");
    report_phase(timings, &mut phase_started, "parse");
    let _ = run_devirt(&mut prog, true);
    report_phase(timings, &mut phase_started, "devirt");
    let res = analyze_program(&prog);
    report_phase(timings, &mut phase_started, "escape");
    // Scalar-replace NoEscape class instances + inline their methods/ctors before
    // codegen, so the object is eliminated and emit_c keeps everything in scalars.
    if mode == "emit" {
        sroa::run_sroa(&mut prog, &res);
        report_phase(timings, &mut phase_started, "sroa");
    }
    match mode {
        "emit" => {
            let output = emit_c::emit_program(&prog, &res);
            report_phase(timings, &mut phase_started, "emit");
            if let Some(k) = args.iter().position(|a| a == "--units") {
                let dir = match args.get(k + 1) {
                    Some(d) => std::path::PathBuf::from(d),
                    None => {
                        eprintln!("--units needs a directory");
                        std::process::exit(2);
                    }
                };
                let opt = c_units::Options::from_env();
                match c_units::split(&output, &prog.modules, &prog.function_modules, &dir, &opt) {
                    Ok(units) => {
                        for u in units {
                            println!("{}{}", u.file, if u.cold { " cold" } else { "" });
                        }
                    }
                    Err(e) => {
                        eprintln!("tsaot: the unit split failed: {}", e);
                        std::process::exit(1);
                    }
                }
                report_phase(timings, &mut phase_started, "units");
            } else {
                print!("{}", output);
                report_phase(timings, &mut phase_started, "write");
            }
        }
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

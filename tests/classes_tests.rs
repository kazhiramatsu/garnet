mod classes;
use classes::*;

// member names
const AREA: Name = 10; const DESCRIBE: Name = 11;
const RADIUS: Name = 20; const SIDE: Name = 21; const ID: Name = 22; const SCALE: Name = 30;

fn m(name: Name, func: FuncId) -> Method { Method { name, func, kind: MKind::Method } }

// Build: Shape{ id; area=100; describe=110 }, Circle extends Shape{ radius; area=101(override); scale=130 },
//        Square extends Shape{ side; area=102(override) }
fn build(circle_inst: bool, square_inst: bool, square_stable: bool, shape_inst: bool) -> Hierarchy {
    Hierarchy::new(vec![
        Class { id: 0, parent: None, own_methods: vec![m(AREA,100), m(DESCRIBE,110)],
                own_fields: vec![ID], instantiated: shape_inst, stable: true },
        Class { id: 1, parent: Some(0), own_methods: vec![m(AREA,101), m(SCALE,130)],
                own_fields: vec![RADIUS], instantiated: circle_inst, stable: true },
        Class { id: 2, parent: Some(0), own_methods: vec![m(AREA,102)],
                own_fields: vec![SIDE], instantiated: square_inst, stable: square_stable },
    ])
}
fn ck<T: std::fmt::Debug + PartialEq>(name: &str, got: T, want: T) {
    println!("[{}] {:?} (want {:?}) {}", name, got, want, if got==want {"PASS"} else {"*** FAIL ***"});
    assert!(got==want, "{}", name);
}

fn main() {
    let h = build(true, true, true, false);

    // --- vtable slot layout (single inheritance, override reuse, new slots) ---
    ck("vtable(Shape)", h.vtable(0), vec![(AREA,100),(DESCRIBE,110)]);
    ck("vtable(Circle)", h.vtable(1), vec![(AREA,101),(DESCRIBE,110),(SCALE,130)]); // area overridden, describe inherited, scale new
    ck("vtable(Square)", h.vtable(2), vec![(AREA,102),(DESCRIBE,110)]);
    ck("slot area@Shape", h.slot_of(0, AREA), Some(0));
    ck("slot area@Circle (same slot)", h.slot_of(1, AREA), Some(0));
    ck("slot scale@Circle (new)", h.slot_of(1, SCALE), Some(2));

    // --- resolve / member kind / field offsets (prefix layout) ---
    ck("resolve area@Circle", h.resolve(1, AREA), Some(101));
    ck("resolve describe@Circle (inherited)", h.resolve(1, DESCRIBE), Some(110));
    ck("member radius@Circle", h.member_kind(1, RADIUS), Member::Field);
    ck("member area@Circle", h.member_kind(1, AREA), Member::Method);
    ck("offset id@Circle (prefix)", h.field_offset(1, ID), Some(0));
    ck("offset radius@Circle", h.field_offset(1, RADIUS), Some(1));

    // --- devirtualization ---
    // polymorphic base call -> Virtual (Circle & Square both instantiated, both override)
    ck("devirt Shape.area (poly)", h.devirtualize(0, AREA, true, true), Dispatch::Virtual{slot:0, name:AREA});
    // monomorphic leaf -> Direct
    ck("devirt Circle.area (mono)", h.devirtualize(1, AREA, true, true), Dispatch::Direct(101));
    ck("devirt Circle.scale (mono)", h.devirtualize(1, SCALE, true, true), Dispatch::Direct(130));
    // inherited, monomorphic -> Direct to inherited impl
    ck("devirt Circle.describe (inherited)", h.devirtualize(1, DESCRIBE, true, true), Dispatch::Direct(110));
    // super.area() from Circle -> Shape's impl, always Direct
    ck("super area@Circle", h.super_dispatch(1, AREA), Dispatch::Direct(100));

    // --- RTA refines CHA: only Circle instantiated -> Shape.area becomes Direct ---
    let h_rta = build(true, false, true, false);
    ck("CHA Shape.area (Square known)", h_rta.devirtualize(0, AREA, true, false), Dispatch::Virtual{slot:0, name:AREA});
    ck("RTA Shape.area (only Circle new'd)", h_rta.devirtualize(0, AREA, true, true), Dispatch::Direct(101));

    // --- soundness guards (JS semantics) ---
    // Square's prototype is mutated / unstable -> any base-typed call must be Dynamic
    let h_unstable = build(true, true, false, false);
    ck("guard: unstable subclass -> Dynamic", h_unstable.devirtualize(0, AREA, true, true), Dispatch::Dynamic);
    // receiver reaches the site via `any` / cast -> Dynamic even if classes are stable
    ck("guard: recv via any -> Dynamic", h.devirtualize(1, AREA, false, true), Dispatch::Dynamic);

    println!("\nAll class vtable + devirtualization scenarios passed.");
}

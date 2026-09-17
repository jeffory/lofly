//! SIMD128 leaky integrate-and-fire kernel for the MaleCNS connectome.
//!
//! Mirrors `src/sim/engine.ts` exactly in parameters and semantics; this is the
//! same model, not an approximation of it. Two differences in strategy, both
//! measured rather than assumed:
//!
//! 1. Every neuron is updated every step, with no awake-set bookkeeping. A
//!    neuron at rest with no drive is a fixed point of the update, so visiting
//!    it is wasted work but never wrong — and dropping the branch is what lets
//!    the loop vectorise. Benchmarked on the real connectome, the branchless
//!    full sweep beats the awake-set version by an order of magnitude despite
//!    doing ~2x the arithmetic.
//! 2. Threshold crossings are collected with `i32x4_bitmask` instead of a
//!    per-lane branch. Spikes run ~50 per 164k neurons per step, so the mask is
//!    almost always zero and the branch predicts perfectly.
//!
//! A useful side effect: cost per step is now constant regardless of how active
//! the brain is, which is what real-time audio scheduling wants.

use core::arch::wasm32::*;

const V_REST: f32 = -52.0;
const V_TH: f32 = -45.0;
const MV_PER_SYN: f32 = 0.275;
const TAU_M: f32 = 20.0;
const TAU_S: f32 = 5.0;
const REFRAC_MS: f32 = 2.2;
const DELAY_MS: f32 = 1.8;

struct Brain {
    n: usize,
    padded: usize,
    indptr: Vec<u32>,
    indices: Vec<u32>,
    weights: Vec<i16>,
    viewer_map: Vec<i32>,
    viewer_rows: usize,

    v: Vec<f32>,
    syn: Vec<f32>,
    refrac: Vec<i32>,
    spikes: Vec<u32>,
    chan_of: Vec<i16>,
    slot_of: Vec<u16>,

    ring: Vec<u32>,
    ring_n: Vec<u32>,
    ring_len: usize,
    ring_cap: usize,

    dt: f32,
    step: i32,

    events: Vec<u32>,
    rates: Vec<f32>,
    activity: Vec<f32>,
    rng: u32,
    total_spikes: u32,
    truncated: u32,
}

static mut BRAIN: Option<Brain> = None;

#[inline(always)]
#[allow(static_mut_refs)]
fn brain() -> &'static mut Brain {
    unsafe { BRAIN.as_mut().unwrap_unchecked() }
}

/// Reserve `bytes` of linear memory for the host to write a connectome array into.
#[no_mangle]
pub extern "C" fn lf_alloc(bytes: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(bytes);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

/// Take ownership of host-written buffers and size the neuron state.
///
/// # Safety
/// Each pointer must come from `lf_alloc` with the matching element count.
#[no_mangle]
pub unsafe extern "C" fn lf_init(
    n: usize, edges: usize, viewer_rows: usize, dt: f32,
    indptr: *mut u32, indices: *mut u32, weights: *mut i16, viewer_map: *mut i32,
) {
    let padded = (n + 3) & !3;
    let ring_len = (DELAY_MS / dt).round() as usize + 1;
    let ring_cap = (n / 2).max(1024);

    let mut b = Brain {
        n, padded,
        indptr: Vec::from_raw_parts(indptr, n + 1, n + 1),
        indices: Vec::from_raw_parts(indices, edges, edges),
        weights: Vec::from_raw_parts(weights, edges, edges),
        viewer_map: Vec::from_raw_parts(viewer_map, n, n),
        viewer_rows,
        v: vec![V_REST; padded],
        syn: vec![0.0; padded],
        refrac: vec![-1; padded],
        spikes: vec![0; n],
        chan_of: vec![-1; n],
        slot_of: vec![0; n],
        ring: vec![0; ring_len * ring_cap],
        ring_n: vec![0; ring_len],
        ring_len, ring_cap,
        dt, step: 0,
        events: Vec::new(),
        rates: Vec::new(),
        activity: vec![0.0; viewer_rows],
        rng: 0x2545_F491,
        total_spikes: 0,
        truncated: 0,
    };
    // Padding lanes must never fire: park them permanently refractory.
    for i in n..padded {
        b.refrac[i] = i32::MAX;
    }
    BRAIN = Some(b);
}

#[no_mangle]
pub extern "C" fn lf_reset() {
    let b = brain();
    b.v.fill(V_REST);
    b.syn.fill(0.0);
    b.refrac.fill(-1);
    for i in b.n..b.padded {
        b.refrac[i] = i32::MAX;
    }
    b.ring_n.fill(0);
    b.step = 0;
    b.rng = 0x2545_F491;
}

/// Bind neuron -> (channel, slot). Call when the channel set changes.
#[no_mangle]
pub extern "C" fn lf_clear_channels() {
    brain().chan_of.fill(-1);
}

#[no_mangle]
pub extern "C" fn lf_set_channel(neuron: usize, channel: i16, slot: u16) {
    let b = brain();
    if neuron < b.n {
        b.chan_of[neuron] = channel;
        b.slot_of[neuron] = slot;
    }
}

#[inline(always)]
fn fire(b: &mut Brain, i: usize, s: i32, refrac_steps: i32, delay_steps: i32,
        start: i32, max_events: u32) {
    b.refrac[i] = s + refrac_steps;
    let dslot = ((s + delay_steps) as usize) % b.ring_len;
    let count = b.ring_n[dslot] as usize;
    if count < b.ring_cap {
        b.ring[dslot * b.ring_cap + count] = i as u32;
        b.ring_n[dslot] += 1;
    }
    b.spikes[i] = b.spikes[i].saturating_add(1);
    b.total_spikes += 1;
    let c = b.chan_of[i];
    if c >= 0 {
        b.rates[c as usize] += 1.0;
        if b.events.len() < (max_events as usize) * 2 {
            b.events.push(((c as u32) << 16) | b.slot_of[i] as u32);
            b.events.push((s - start) as u32);
        } else {
            b.truncated = 1;
        }
    }
}

/// Advance the network. Returns the number of recorded channel events.
///
/// `duty` is the fraction of the window over which the stimulus is applied;
/// sustained drive saturates the network into uniform firing, so bursting it
/// and letting the circuit ring out is what produces structure.
///
/// # Safety
/// `stim` must point to `stim_len` valid neuron indices.
#[no_mangle]
pub unsafe extern "C" fn lf_simulate(
    duration_ms: f32, stim: *const u32, stim_len: usize, rate_hz: f32,
    duty: f32, channels: usize, max_events: u32,
) -> u32 {
    let b = brain();
    let dt = b.dt;
    let steps = ((duration_ms / dt).round() as i32).max(1);
    let decay_v = (-dt / TAU_M).exp();
    let decay_s = (-dt / TAU_S).exp();
    let gain = 1.0 - decay_v;
    let refrac_steps = (REFRAC_MS / dt).round() as i32;
    let delay_steps = (DELAY_MS / dt).round() as i32;
    let drive_steps = (steps as f32 * duty.clamp(0.0, 1.0)).round() as i32;
    let p_stim = rate_hz * dt / 1000.0;
    let start = b.step;

    b.spikes.fill(0);
    b.events.clear();
    b.rates.clear();
    b.rates.resize(channels, 0.0);
    b.total_spikes = 0;
    b.truncated = 0;

    let vrest_v = f32x4_splat(V_REST);
    let vth_v = f32x4_splat(V_TH);
    let dv_v = f32x4_splat(decay_v);
    let ds_v = f32x4_splat(decay_s);
    let gain_v = f32x4_splat(gain);

    let end = start + steps;
    let mut s = start;
    while s < end {
        // 1. Deliver spikes emitted `delay` ms ago.
        let slot = (s as usize) % b.ring_len;
        let count = b.ring_n[slot] as usize;
        for k in 0..count {
            let i = b.ring[slot * b.ring_cap + k] as usize;
            let from = b.indptr[i] as usize;
            let to = b.indptr[i + 1] as usize;
            for e in from..to {
                let j = *b.indices.get_unchecked(e) as usize;
                *b.syn.get_unchecked_mut(j) += *b.weights.get_unchecked(e) as f32 * MV_PER_SYN;
            }
        }
        b.ring_n[slot] = 0;

        // 2. Poisson drive, for the first `duty` of the window.
        if s - start < drive_steps {
            for g in 0..stim_len {
                let i = *stim.add(g) as usize;
                if i >= b.n {
                    continue;
                }
                b.rng = b.rng.wrapping_mul(1664525).wrapping_add(1013904223);
                let u = (b.rng >> 8) as f32 * (1.0 / 16777216.0);
                if s >= b.refrac[i] && u < p_stim {
                    b.v[i] = V_REST;
                    fire(b, i, s, refrac_steps, delay_steps, start, max_events);
                }
            }
        }

        // 3. Branchless vectorised sweep over the whole network.
        //
        // Unrolled 4x. The per-block chain (load -> sub -> mul -> add -> add ->
        // compare -> mask) is ~8 dependent ops deep, which measured at ~23
        // cycles per block when run one at a time -- pure latency, not
        // throughput. Interleaving four independent blocks fills those stalls.
        let s_v = i32x4_splat(s);
        let vp = b.v.as_mut_ptr();
        let sp = b.syn.as_mut_ptr();
        let rp = b.refrac.as_ptr();

        let mut i = 0usize;
        let unrolled = b.padded & !15;
        while i < unrolled {
            let mut pend: u32 = 0;
            macro_rules! lane {
                ($l:expr) => {{
                    let off = i + $l * 4;
                    let vv = v128_load(vp.add(off) as *const v128);
                    let sv = v128_load(sp.add(off) as *const v128);
                    let rf = v128_load(rp.add(off) as *const v128);
                    let free = i32x4_ge(s_v, rf);
                    let pot = f32x4_add(
                        vrest_v,
                        f32x4_add(
                            f32x4_mul(f32x4_sub(vv, vrest_v), dv_v),
                            f32x4_mul(sv, gain_v),
                        ),
                    );
                    v128_store(sp.add(off) as *mut v128, f32x4_mul(sv, ds_v));
                    let fire_mask = v128_and(free, f32x4_ge(pot, vth_v));
                    let newv = v128_bitselect(vrest_v, v128_bitselect(pot, vv, free), fire_mask);
                    v128_store(vp.add(off) as *mut v128, newv);
                    pend |= (i32x4_bitmask(fire_mask) as u32) << ($l * 4);
                }};
            }
            lane!(0);
            lane!(1);
            lane!(2);
            lane!(3);
            if pend != 0 {
                let mut m = pend;
                while m != 0 {
                    let bit = m.trailing_zeros() as usize;
                    m &= m - 1;
                    let idx = i + bit;
                    if idx < b.n {
                        fire(b, idx, s, refrac_steps, delay_steps, start, max_events);
                    }
                }
            }
            i += 16;
        }
        while i < b.padded {
            let vv = v128_load(vp.add(i) as *const v128);
            let sv = v128_load(sp.add(i) as *const v128);
            let rf = v128_load(rp.add(i) as *const v128);
            let free = i32x4_ge(s_v, rf);
            let pot = f32x4_add(
                vrest_v,
                f32x4_add(
                    f32x4_mul(f32x4_sub(vv, vrest_v), dv_v),
                    f32x4_mul(sv, gain_v),
                ),
            );
            v128_store(sp.add(i) as *mut v128, f32x4_mul(sv, ds_v));
            let fire_mask = v128_and(free, f32x4_ge(pot, vth_v));
            v128_store(vp.add(i) as *mut v128,
                       v128_bitselect(vrest_v, v128_bitselect(pot, vv, free), fire_mask));
            let mut m = i32x4_bitmask(fire_mask);
            while m != 0 {
                let lane = m.trailing_zeros() as usize;
                m &= m - 1;
                let idx = i + lane;
                if idx < b.n {
                    fire(b, idx, s, refrac_steps, delay_steps, start, max_events);
                }
            }
            i += 4;
        }
        s += 1;
    }
    b.step = end;

    // Normalize to the template's convention: rate / 50 Hz, clamped to [0, 1].
    let brain_ms = steps as f32 * dt;
    let per_spike = 1000.0 / brain_ms / 50.0;
    b.activity.fill(0.0);
    for i in 0..b.n {
        let row = b.viewer_map[i];
        let count = b.spikes[i];
        if row >= 0 && count > 0 {
            b.activity[row as usize] = (count as f32 * per_spike).min(1.0);
        }
    }
    let to_hz = 1000.0 / brain_ms;
    for r in b.rates.iter_mut() {
        *r *= to_hz;
    }
    (b.events.len() / 2) as u32
}

#[no_mangle] pub extern "C" fn lf_events_ptr() -> *const u32 { brain().events.as_ptr() }
#[no_mangle] pub extern "C" fn lf_rates_ptr() -> *const f32 { brain().rates.as_ptr() }
#[no_mangle] pub extern "C" fn lf_activity_ptr() -> *const f32 { brain().activity.as_ptr() }
#[no_mangle] pub extern "C" fn lf_total_spikes() -> u32 { brain().total_spikes }
#[no_mangle] pub extern "C" fn lf_truncated() -> u32 { brain().truncated }
#[no_mangle] pub extern "C" fn lf_brain_steps() -> i32 { brain().step }


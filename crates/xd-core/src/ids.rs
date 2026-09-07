//! Element ids, seeds and version nonces.
//!
//! Deliberately not `rand`: this crate is compiled to wasm, where the system
//! entropy source is a JS import and pulling one in for four random integers
//! costs both bytes and a host dependency. A splitmix64 counter seeded once
//! per `Doc` gives ids that never collide inside a session, which is the only
//! property that matters — Excalidraw's own ids are nanoid strings and it
//! never assumes anything about their shape.
//!
//! The sequence is *seedable*, which is what makes the fuzz tests in
//! `doc.rs` reproducible.

/// A splitmix64 stream. Small, fast, and no dependency.
#[derive(Debug, Clone)]
pub struct Rng {
    state: u64,
}

impl Rng {
    pub fn new(seed: u64) -> Self {
        // A zero seed would make splitmix64 start on a fixed point; the golden
        // ratio constant is the usual guard.
        Rng { state: seed ^ 0x9e37_79b9_7f4a_7c15 }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// A non-negative 31-bit integer, the shape Excalidraw writes for `seed`
    /// and `versionNonce`. Rough.js takes the seed modulo its own table, so
    /// the range only has to be wide enough not to repeat.
    pub fn next_nonce(&mut self) -> i64 {
        (self.next_u64() >> 33) as i64
    }

    /// A 21-character id from the same alphabet Excalidraw's nanoid uses.
    pub fn next_id(&mut self) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
        let mut out = String::with_capacity(21);
        let mut bits = self.next_u64();
        let mut left = 10; // 10 six-bit draws per u64
        for _ in 0..21 {
            if left == 0 {
                bits = self.next_u64();
                left = 10;
            }
            out.push(ALPHABET[(bits & 63) as usize] as char);
            bits >>= 6;
            left -= 1;
        }
        out
    }
}

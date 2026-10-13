//! eaglesong-oracle — reads one hex-encoded input per stdin line, writes the
//! 32-byte Eaglesong digest as 64 lowercase hex chars per line.
//! Uses the OFFICIAL nervosnetwork/eaglesong crate so JS/WASM/WGSL ports are
//! checked against an implementation none of them share code with.
use std::io::{self, BufRead, Write};

fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim().trim_start_matches("0x");
    if s.len() % 2 != 0 {
        return Err(format!("odd hex length {}", s.len()));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in stdin.lock().lines() {
        let line = line.expect("stdin read");
        if line.trim_start().starts_with('#') {
            continue;
        }
        let input = match hex_decode(&line) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("bad input line: {e}");
                std::process::exit(2);
            }
        };
        let mut digest = [0u8; 32];
        eaglesong::eaglesong(&input, &mut digest);
        let hex: String = digest.iter().map(|b| format!("{:02x}", b)).collect();
        writeln!(out, "{hex}").expect("stdout write");
    }
}

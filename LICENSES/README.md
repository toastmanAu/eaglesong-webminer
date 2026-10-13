# Third-party notices

| Component | Used for | License |
|---|---|---|
| nervosnetwork/eaglesong (`39d3832d`) | reference algorithm, official test vectors, Rust oracle (`tools/eaglesong-oracle`) | MIT — `nervosnetwork-eaglesong-MIT.txt` |
| toastmanAu/NerdMiner_CKB (`cc6d2fee`) | C reference port of Eaglesong (`src/eaglesong/eaglesong.cpp`) basis for the WASM backend; nonce/submit contract | MIT (c) 2023 Bitmaker, previous work HAN Miner (c) 2022 Valerio Vaccaro — `NerdMiner_CKB-MIT.txt` |
| toastmanAu/ckb-stratum-proxy (`027584a6`) and the local operator copy | solo-mining proxy this bridge talks to; `eaglesong.js` port lineage; audit fixtures | MIT per its `package.json` (no LICENSE file in the repository; attribution preserved here) |

The browser UX reference https://mine.solopool.com/miner.html was used for UX ideas only; no code was copied.

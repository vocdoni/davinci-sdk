//! Tracker proof vectors for the TypeScript SDK: arbo inclusion proofs of
//! vote-id leaves (davinci-sequencer `arbo`), serialized as the sequencer
//! serves them (`davinci_client::api::TrackerProof`), with the result of
//! `davinci_client::api::verify_tracker` for honest and tampered proofs.

use arbo::{MemoryStorage, Sha256, Tree};
use davinci_client::api::{self, ProcessId, TrackerProof};
use serde_json::{Value, json};

fn case(label: &str, tp: &TrackerProof, onchain: &[u8; 32]) -> Value {
    json!({
        "label": label,
        "proof": serde_json::to_value(tp).unwrap(),
        "onchainRoot": format!("0x{}", hex::encode(onchain)),
        "valid": api::verify_tracker(tp, onchain),
    })
}

fn main() {
    let pid = ProcessId([0x5a; 31]);
    let mut cases = Vec::new();

    // A tree holding only one vote id: the root is its leaf, no siblings.
    let mut single = Tree::new(MemoryStorage::new(), 64, Sha256).unwrap();
    let lone = (1u64 << 63) | 0x1234;
    single.add(&lone.to_le_bytes(), &[0u8; 32]).unwrap();
    let p = single.gen_proof(&lone.to_le_bytes()).unwrap();
    let root = single.root();
    let tp = TrackerProof { process_id: pid, vote_id: lone, root, siblings: p.siblings };
    cases.push(case("single leaf", &tp, &root));

    // Config and ballot leaves share the state tree with the vote ids.
    let mut tree = Tree::new(MemoryStorage::new(), 64, Sha256).unwrap();
    for k in [0u64, 2, 3, 4, 6, 7, 0x10, 0x11, 0x25] {
        tree.add(&k.to_le_bytes(), &[k as u8 + 1; 32]).unwrap();
    }
    let vids: Vec<u64> = (0..24u64)
        .map(|i| (1 << 63) | i.wrapping_mul(0x9e37_79b9_7f4a_7c15) >> 1)
        .collect();
    for v in &vids {
        tree.add(&v.to_le_bytes(), &[0u8; 32]).unwrap();
    }
    let root = tree.root();
    for (i, v) in vids.iter().enumerate() {
        let p = tree.gen_proof(&v.to_le_bytes()).unwrap();
        assert!(p.exists);
        let tp = TrackerProof { process_id: pid, vote_id: *v, root, siblings: p.siblings };
        assert!(api::verify_tracker(&tp, &root));
        cases.push(case(&format!("vote {i}"), &tp, &root));
        if i % 6 != 0 {
            continue;
        }
        let mut other = root;
        other[0] ^= 1;
        cases.push(case(&format!("vote {i}, other on-chain root"), &tp, &other));
        let mut t = tp.clone();
        t.root = other;
        cases.push(case(&format!("vote {i}, proof for another root"), &t, &other));
        let mut t = tp.clone();
        t.vote_id ^= 1;
        cases.push(case(&format!("vote {i}, other vote id"), &t, &root));
        if let Some(j) = tp.siblings.iter().position(|s| *s != [0u8; 32]) {
            let mut t = tp.clone();
            t.siblings[j][5] ^= 0x40;
            cases.push(case(&format!("vote {i}, tampered sibling"), &t, &root));
        }
        let mut t = tp.clone();
        t.siblings.push([0u8; 32]);
        cases.push(case(&format!("vote {i}, extra level"), &t, &root));
        let mut t = tp.clone();
        t.siblings = vec![[0u8; 32]; 65];
        cases.push(case(&format!("vote {i}, 65 levels"), &t, &root));
    }
    // A ballot leaf (non-zero value) is not a recorded vote id.
    let p = tree.gen_proof(&0x10u64.to_le_bytes()).unwrap();
    let tp = TrackerProof { process_id: pid, vote_id: 0x10, root, siblings: p.siblings };
    cases.push(case("ballot slot key", &tp, &root));
    // An absent vote id has no inclusion proof.
    let absent = (1u64 << 63) | 12345;
    let p = tree.gen_proof(&absent.to_le_bytes()).unwrap();
    assert!(!p.exists);
    let tp = TrackerProof { process_id: pid, vote_id: absent, root, siblings: p.siblings };
    cases.push(case("absent vote id", &tp, &root));

    println!("{}", serde_json::to_string_pretty(&json!({ "cases": cases })).unwrap());
}

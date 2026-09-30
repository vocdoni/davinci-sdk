//! Census file vectors for the TypeScript SDK.
//!
//! - `sets`: members (address, weight) written as the organizer client writes
//!   a census file (`organizer::census_file`): `compact` as the e2e fixtures
//!   write it (`serde_json::to_vec`) and `pretty` as the demo does
//!   (`to_vec_pretty` and a newline). Each set carries its lean-IMT root
//!   (`organizer::merkle_census`), every member's proof and ballot slot, and
//!   whether the node stores both files under that root.
//! - `documents`: edited census files and the node's verdict: accepted, with
//!   the root it built, or refused, with its error.
//! - `demo`: census files of the demo elections (`e2e/demo`), with their
//!   sha256, member count and root, and whether `pretty` rewrites them byte
//!   for byte.
//!
//! The verdict is `CensusStore::fetch` on a `file://` copy, in a fresh store
//! each time: a store answers a root it already holds without parsing.

use davinci_client::api::CensusFile;
use davinci_client::organizer::{census_file, merkle_census};
use davinci_sequencer::census::{CensusError, CensusOptions, CensusStore};
use davinci_sequencer::storage::Db;
use davinci_zkvm_sdk::census::slot_key_address;
use davinci_zkvm_sdk::crypto::field::{Fr, fr_from_be, fr_to_dec};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const SIZES: [usize; 11] = [1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 33];
const WEIGHTS: [u128; 7] = [1, 2, 7, 1000, (1 << 53) + 1, (1 << 88) - 1, 0];
const DEMO: [&str; 3] = [
    "wave2/13-dog-park/census.json",
    "3-budget-2027/census.json",
    "3-budget-2027/census-2.json",
];

fn address(tag: &str, i: usize) -> [u8; 20] {
    let d = Sha256::digest(format!("census-gen {tag} {i}"));
    let mut a = [0u8; 20];
    a.copy_from_slice(&d[..20]);
    a
}

fn pretty(file: &CensusFile) -> Vec<u8> {
    let mut b = serde_json::to_vec_pretty(file).expect("census json");
    b.push(b'\n');
    b
}

fn text(b: &[u8]) -> String {
    String::from_utf8(b.to_vec()).expect("utf-8")
}

async fn fetch(body: &[u8], root: &Fr) -> Result<(), CensusError> {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("census.json");
    std::fs::write(&path, body).expect("write");
    let db = Db::open(&dir.path().join("node.redb")).expect("db");
    let opts = CensusOptions {
        dir: Some(dir.path().to_path_buf()),
        ..CensusOptions::default()
    };
    let store = CensusStore::with_options(db, opts).expect("store");
    store.fetch(&format!("file://{}", path.display()), root).await
}

// The node's verdict: first against a root no census has, so a document that
// parses fails with the root it built, then against that root.
async fn verdict(body: &[u8]) -> Value {
    let root = match fetch(body, &Fr::from(1u64)).await {
        Err(CensusError::RootMismatch { got, .. }) => {
            let mut be = [0u8; 32];
            hex::decode_to_slice(got.trim_start_matches("0x"), &mut be).expect("root hex");
            fr_from_be(&be).expect("root")
        }
        Err(e) => return json!({ "ok": false, "error": e.to_string() }),
        Ok(()) => panic!("a document built the probe root"),
    };
    match fetch(body, &root).await {
        Ok(()) => json!({ "ok": true, "root": fr_to_dec(&root) }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

async fn sets() -> Vec<Value> {
    let mut out = Vec::new();
    for (s, &n) in SIZES.iter().enumerate() {
        let parts: Vec<([u8; 20], u128)> = (0..n)
            .map(|i| (address(&format!("set{n}"), i), WEIGHTS[(i + s) % WEIGHTS.len()]))
            .collect();
        let file = census_file(&parts);
        let tree = merkle_census(&file).expect("tree");
        let root = tree.root();
        let compact = serde_json::to_vec(&file).expect("census json");
        let pretty = pretty(&file);
        let proofs: Vec<Value> = (0..n)
            .map(|i| {
                let p = tree.proof(i).expect("proof");
                json!({
                    "root": fr_to_dec(&p.root),
                    "leaf": fr_to_dec(&p.leaf),
                    "pathBits": p.path_bits,
                    "siblings": p.siblings.iter().map(fr_to_dec).collect::<Vec<_>>(),
                })
            })
            .collect();
        out.push(json!({
            "name": format!("{n} members"),
            "participants": parts
                .iter()
                .map(|(a, w)| json!({ "key": format!("0x{}", hex::encode(a)), "weight": w.to_string() }))
                .collect::<Vec<_>>(),
            "compact": text(&compact),
            "pretty": text(&pretty),
            "root": fr_to_dec(&root),
            "proofs": proofs,
            "slots": parts.iter().map(|(a, _)| slot_key_address(a).to_string()).collect::<Vec<_>>(),
            "node": {
                "compact": fetch(&compact, &root).await.is_ok(),
                "pretty": fetch(&pretty, &root).await.is_ok(),
            },
        }));
    }
    out
}

fn documents() -> Vec<(&'static str, String)> {
    let [a, b, c] = [0, 1, 2].map(|i| hex::encode(address("doc", i)));
    let upper = a.to_uppercase();
    let zero = "0".repeat(40);
    let member = |k: &str, w: &str| format!(r#"{{"key":"{k}","weight":{w}}}"#);
    let doc = |ms: &[String]| format!(r#"{{"participants":[{}]}}"#, ms.join(","));
    let three = |wa: &str| {
        doc(&[
            member(&format!("0x{a}"), wa),
            member(&format!("0x{b}"), r#""2""#),
            member(&format!("0x{c}"), r#""3""#),
        ])
    };
    let canonical = three(r#""1""#);
    let root = merkle_census(&census_file(&[
        (address("doc", 0), 1),
        (address("doc", 1), 2),
        (address("doc", 2), 3),
    ]))
    .expect("tree")
    .root();
    let dump = |root: &str| {
        format!(
            r#"{{"root":{root},"participants":[{{"addressIndex":0,"address":"0x{a}","weight":1}},{{"addressIndex":1,"address":"0x{b}","weight":2}},{{"addressIndex":2,"address":"0x{c}","weight":3}}]}}"#
        )
    };
    vec![
        ("canonical", canonical.clone()),
        (
            "uppercase hex digits",
            doc(&[
                member(&format!("0x{upper}"), r#""1""#),
                member(&format!("0x{b}"), r#""2""#),
                member(&format!("0x{c}"), r#""3""#),
            ]),
        ),
        (
            "no 0x prefix",
            doc(&[
                member(&a, r#""1""#),
                member(&b, r#""2""#),
                member(&c, r#""3""#),
            ]),
        ),
        (
            "0X prefix",
            doc(&[
                member(&format!("0X{a}"), r#""1""#),
                member(&format!("0x{b}"), r#""2""#),
                member(&format!("0x{c}"), r#""3""#),
            ]),
        ),
        ("number weight", three("1")),
        ("number weight above 2^53", three("1152921504606846976")),
        (
            "address instead of key",
            format!(
                r#"{{"participants":[{{"address":"0x{a}","weight":"1"}},{{"address":"0x{b}","weight":"2"}},{{"address":"0x{c}","weight":"3"}}]}}"#
            ),
        ),
        ("leading zero weight", three(r#""01""#)),
        ("weight 2^88 - 1", three(r#""309485009821345068724781055""#)),
        ("weight 2^88", three(r#""309485009821345068724781056""#)),
        ("weight 2^128", three(r#""340282366920938463463374607431768211456""#)),
        ("negative weight", three(r#""-1""#)),
        ("plus sign", three(r#""+1""#)),
        ("space in weight", three(r#"" 1""#)),
        ("fractional weight", three(r#""1.0""#)),
        ("fractional number weight", three("1.0")),
        ("exponent weight", three("1e3")),
        ("hex weight", three(r#""0x1""#)),
        ("empty weight", three(r#""""#)),
        ("null weight", three("null")),
        (
            "no weight",
            format!(
                r#"{{"participants":[{{"key":"0x{a}"}},{{"key":"0x{b}","weight":"2"}},{{"key":"0x{c}","weight":"3"}}]}}"#
            ),
        ),
        (
            "no key",
            format!(
                r#"{{"participants":[{{"weight":"1"}},{{"key":"0x{b}","weight":"2"}},{{"key":"0x{c}","weight":"3"}}]}}"#
            ),
        ),
        (
            "same address twice",
            doc(&[
                member(&format!("0x{a}"), r#""1""#),
                member(&format!("0x{b}"), r#""2""#),
                member(&format!("0x{a}"), r#""3""#),
            ]),
        ),
        (
            "same address twice, other case",
            doc(&[
                member(&format!("0x{a}"), r#""1""#),
                member(&format!("0x{upper}"), r#""2""#),
            ]),
        ),
        (
            "zero address",
            doc(&[
                member(&format!("0x{a}"), r#""1""#),
                member(&format!("0x{zero}"), r#""0""#),
                member(&format!("0x{c}"), r#""3""#),
            ]),
        ),
        (
            "short address",
            doc(&[member("0x12", r#""1""#), member(&format!("0x{b}"), r#""2""#)]),
        ),
        (
            "long address",
            doc(&[
                member(&format!("0x{a}00"), r#""1""#),
                member(&format!("0x{b}"), r#""2""#),
            ]),
        ),
        ("no participants", r#"{"participants":[]}"#.to_string()),
        ("no participants field", "{}".to_string()),
        ("participants not an array", r#"{"participants":{}}"#.to_string()),
        (
            "unknown member field",
            format!(
                r#"{{"participants":[{{"key":"0x{a}","weight":"1","name":"x"}},{{"key":"0x{b}","weight":"2"}},{{"key":"0x{c}","weight":"3"}}]}}"#
            ),
        ),
        (
            "unknown top-level field",
            format!(r#"{{"version":1,{}"#, &canonical[1..]),
        ),
        ("byte-order mark", format!("\u{feff}{canonical}")),
        ("surrounding whitespace", format!("\n {canonical}\n\n")),
        (
            "jsonl",
            format!(
                "{{\"key\":\"0x{a}\",\"weight\":\"1\"}}\n{{\"key\":\"0x{b}\",\"weight\":\"2\"}}\n{{\"key\":\"0x{c}\",\"weight\":\"3\"}}\n"
            ),
        ),
        ("dump with its root", dump(&fr_to_dec(&root))),
        ("dump with another root", dump("5")),
        (
            "participants twice",
            format!(
                r#"{{"participants":[{}],{}"#,
                member(&format!("0x{a}"), r#""9""#),
                &canonical[1..]
            ),
        ),
        ("not json", "{participants".to_string()),
        ("array", "[]".to_string()),
    ]
}

async fn demo() -> Vec<Value> {
    let mut out = Vec::new();
    for path in DEMO {
        let body = std::fs::read(format!("../davinci-sequencer/e2e/demo/{path}")).expect(path);
        let file: CensusFile = serde_json::from_slice(&body).expect(path);
        let root = merkle_census(&file).expect("tree").root();
        out.push(json!({
            "path": path,
            "sha256": hex::encode(Sha256::digest(&body)),
            "members": file.participants.len(),
            "root": fr_to_dec(&root),
            "rewritten": pretty(&file) == body,
            "node": fetch(&body, &root).await.is_ok(),
        }));
    }
    out
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut docs = Vec::new();
    for (name, body) in documents() {
        let v = verdict(body.as_bytes()).await;
        docs.push(json!({ "name": name, "body": body, "node": v }));
    }
    let out = json!({
        "description": "Census files as davinci-client's organizer writes them, their lean-IMT roots, proofs and slots, and the node's verdict (CensusStore::fetch) on each file and on edited documents",
        "sets": sets().await,
        "documents": docs,
        "demo": demo().await,
    });
    println!("{}", serde_json::to_string_pretty(&out).expect("json"));
}

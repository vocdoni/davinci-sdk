//! Wire vectors for the TypeScript SDK's sequencer client. The samples are
//! those of davinci-sequencer `client/tests/api.rs`, serialized with the real
//! `davinci_client::api` types; every tampered copy carries the verdict of the
//! same types' strict decoding. `pickNode` holds `voter::pick_node` orders.

use davinci_client::api::{
    BallotResponse, BlobsResponse, CensusFile, CensusParticipant, CensusProofWire, CensusView,
    CspWire, EncryptionKeyResponse, Info, MerkleProof, ParticipantResponse, ProcessId,
    ProcessStatus, ProcessView, TrackerProof, TransitionList, TransitionView, VoteRequest,
    VoteStatus, VoteStatusResponse,
};
use davinci_client::voter::pick_node;
use davinci_zkvm_sdk::ballot::{Ballot, BallotMode};
use davinci_zkvm_sdk::census::{LeanImt, census_leaf};
use davinci_zkvm_sdk::crypto::babyjubjub::Point;
use davinci_zkvm_sdk::crypto::elgamal::encrypt;
use davinci_zkvm_sdk::crypto::field::{Fr, U256};
use davinci_zkvm_sdk::types::SnarkJsProof;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

const P: &str = "21888242871839275222246405745257275088548364400416034343698204186575808495617";

fn mode(nf: u8) -> BallotMode {
    BallotMode {
        num_fields: nf,
        group_size: 1,
        unique_values: false,
        cost_exponent: 1,
        max_value: 5,
        min_value: 0,
        max_value_sum: 1 << 62,
        min_value_sum: 0,
    }
}

fn pk() -> Point {
    Point::generator().mul(&U256::from(12345u64))
}

fn sample_ballot() -> Ballot {
    let mut b = Ballot::identity();
    b.0[0] = encrypt(&pk(), 3, &U256::from(77u64));
    b.0[1] = encrypt(&pk(), 1, &U256::from(78u64));
    b
}

fn sample_proof() -> SnarkJsProof {
    SnarkJsProof {
        pi_a: ["1".into(), "2".into(), "1".into()],
        pi_b: [
            ["1".into(), "2".into()],
            ["3".into(), "4".into()],
            ["1".into(), "0".into()],
        ],
        pi_c: ["5".into(), "6".into(), "1".into()],
        protocol: "groth16".into(),
        curve: "bn128".into(),
    }
}

fn sample_vote(census: Option<CensusProofWire>) -> VoteRequest {
    VoteRequest {
        process_id: ProcessId([0xab; 31]),
        address: [0x11; 20],
        vote_id: 0x8000_0000_0000_1234,
        ballot: sample_ballot(),
        ballot_proof: sample_proof(),
        ballot_inputs_hash: Fr::from(999u64),
        signature: [7u8; 65],
        weight: 42,
        census_proof: census,
    }
}

fn merkle_wire() -> CensusProofWire {
    let mut t = LeanImt::new();
    for i in 0..5u8 {
        t.insert(census_leaf(&[i; 20], 1).unwrap());
    }
    CensusProofWire::Merkle(MerkleProof::from(&t.proof(3).unwrap()))
}

fn csp_wire() -> CensusProofWire {
    CensusProofWire::Csp(CspWire {
        r: [1; 32],
        s: [2; 32],
        recid: 1,
        index: 9,
    })
}

fn view(m: BallotMode) -> ProcessView {
    ProcessView {
        id: ProcessId([3; 31]),
        status: ProcessStatus::Ready,
        is_accepting_votes: true,
        organization_id: [9; 20],
        encryption_key: pk(),
        ballot_mode: m,
        census: CensusView {
            census_origin: 1,
            census_root: Fr::from(5u64),
            census_uri: "file:///tmp/census.json".into(),
        },
        state_root: [4; 32],
        local_state_root: None,
        synced: false,
        voters_count: 2,
        overwritten_votes_count: 1,
        max_voters: 100,
        start_time: 1_700_000_000,
        duration: 7200,
        result: None,
        ignored: false,
        note: None,
    }
}

/// One edit of a JSON document; `path` walks object keys and array indexes.
#[derive(Clone)]
enum Op {
    Set(Vec<Value>, Value),
    Remove(Vec<Value>),
    Pop(Vec<Value>),
    Push(Vec<Value>, Value),
}

macro_rules! p {
    ($($k:expr),* $(,)?) => { vec![$(json!($k)),*] };
}

fn walk<'a>(j: &'a mut Value, path: &[Value]) -> &'a mut Value {
    path.iter().fold(j, |v, k| match k {
        Value::String(s) => &mut v[s.as_str()],
        Value::Number(n) => &mut v[n.as_u64().unwrap() as usize],
        _ => unreachable!(),
    })
}

fn apply(j: &mut Value, op: &Op) {
    match op {
        Op::Set(path, v) => *walk(j, path) = v.clone(),
        Op::Remove(path) => {
            let (last, parent) = path.split_last().unwrap();
            walk(j, parent)
                .as_object_mut()
                .unwrap()
                .remove(last.as_str().unwrap());
        }
        Op::Pop(path) => {
            walk(j, path).as_array_mut().unwrap().pop();
        }
        Op::Push(path, v) => walk(j, path).as_array_mut().unwrap().push(v.clone()),
    }
}

fn op_json(op: &Op) -> Value {
    match op {
        Op::Set(path, v) => json!({"op": "set", "path": path, "value": v}),
        Op::Remove(path) => json!({"op": "remove", "path": path}),
        Op::Pop(path) => json!({"op": "pop", "path": path}),
        Op::Push(path, v) => json!({"op": "push", "path": path, "value": v}),
    }
}

type Tamper = (&'static str, Vec<Op>);

fn set(label: &'static str, path: Vec<Value>, v: Value) -> Tamper {
    (label, vec![Op::Set(path, v)])
}

fn remove(label: &'static str, path: Vec<Value>) -> Tamper {
    (label, vec![Op::Remove(path)])
}

fn ok_json(label: &'static str) -> Tamper {
    (label, vec![])
}

// Strict decoding of each edited copy of `good`, then `check` on the value.
fn verdicts<T: DeserializeOwned>(
    good: &Value,
    tampers: Vec<Tamper>,
    check: impl Fn(T) -> bool,
) -> Value {
    Value::Array(
        tampers
            .into_iter()
            .map(|(label, ops)| {
                let mut j = good.clone();
                ops.iter().for_each(|op| apply(&mut j, op));
                let ok = serde_json::from_value::<T>(j).map(&check).unwrap_or(false);
                let ops: Vec<Value> = ops.iter().map(op_json).collect();
                json!({"label": label, "ops": ops, "ok": ok})
            })
            .collect(),
    )
}

fn hexs(b: u8, n: usize) -> String {
    format!("0x{}", format!("{b:02x}").repeat(n))
}

fn vote_request_cases(good: &Value) -> Value {
    verdicts::<VoteRequest>(
        good,
        vec![
            ok_json("canonical"),
            set("Fr = p", p!["ballotInputsHash"], json!(P)),
            set("hex Fr", p!["ballotInputsHash"], json!("0x10")),
            set("negative Fr", p!["ballotInputsHash"], json!("-1")),
            set("number Fr", p!["ballotInputsHash"], json!(5)),
            set("empty Fr", p!["ballotInputsHash"], json!("")),
            set(
                "Fr with leading zeros",
                p!["ballotInputsHash"],
                json!("000999"),
            ),
            set(
                "Fr of 80 zeros",
                p!["ballotInputsHash"],
                json!("0".repeat(80)),
            ),
            set(
                "Fr of 81 digits",
                p!["ballotInputsHash"],
                json!("0".repeat(81)),
            ),
            set("Fr with a sign", p!["ballotInputsHash"], json!("+999")),
            set("off curve", p!["ballot", 0, "c1", "x"], json!("5")),
            set("coord = p", p!["ballot", 3, "c2", "y"], json!(P)),
            ("15 ciphertexts", vec![Op::Pop(p!["ballot"])]),
            (
                "17 ciphertexts",
                vec![Op::Push(p!["ballot"], good["ballot"][0].clone())],
            ),
            set(
                "extra field in a point",
                p!["ballot", 0, "c1", "z"],
                json!("1"),
            ),
            set(
                "extra field in a ciphertext",
                p!["ballot", 0, "c3"],
                json!({"x": "0", "y": "1"}),
            ),
            set(
                "point as an array",
                p!["ballot", 2, "c1"],
                json!(["0", "1"]),
            ),
            set("7-byte vote id", p!["voteId"], json!("0x80000000000012")),
            set(
                "vote id 2^63 - 1",
                p!["voteId"],
                json!("0x7fffffffffffffff"),
            ),
            set("small vote id", p!["voteId"], json!("0x0000000000001234")),
            set("vote id 2^63", p!["voteId"], json!("0x8000000000000000")),
            set(
                "vote id 2^64 - 1",
                p!["voteId"],
                json!("0xffffffffffffffff"),
            ),
            set(
                "numeric vote id",
                p!["voteId"],
                json!(9223372036854780468u64),
            ),
            set(
                "vote id without 0x",
                p!["voteId"],
                json!("8000000000001234"),
            ),
            set("vote id with 0X", p!["voteId"], json!("0X8000000000001234")),
            set(
                "vote id upper hex",
                p!["voteId"],
                json!("0x80000000000012AB"),
            ),
            set("32-byte process id", p!["processId"], json!(hexs(0xab, 32))),
            set(
                "process id without 0x",
                p!["processId"],
                json!("ab".repeat(31)),
            ),
            set(
                "process id upper hex",
                p!["processId"],
                json!(format!("0x{}", "AB".repeat(31))),
            ),
            set("19-byte address", p!["address"], json!(hexs(0x11, 19))),
            set(
                "non-hex address",
                p!["address"],
                json!(format!("0x{}", "zz".repeat(20))),
            ),
            set(
                "checksummed address",
                p!["address"],
                json!("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"),
            ),
            set("64-byte signature", p!["signature"], json!(hexs(7, 64))),
            set(
                "weight 2^128",
                p!["weight"],
                json!("340282366920938463463374607431768211456"),
            ),
            set(
                "weight 2^128 - 1",
                p!["weight"],
                json!("340282366920938463463374607431768211455"),
            ),
            set("number weight", p!["weight"], json!(42)),
            set(
                "weight of 40 digits",
                p!["weight"],
                json!(format!("{}42", "0".repeat(38))),
            ),
            set(
                "weight of 39 digits",
                p!["weight"],
                json!(format!("{}42", "0".repeat(37))),
            ),
            set(
                "census proof type dynamic",
                p!["censusProof", "type"],
                json!("dynamic"),
            ),
            set(
                "census proof type Merkle",
                p!["censusProof", "type"],
                json!("Merkle"),
            ),
            set("census proof root = p", p!["censusProof", "root"], json!(P)),
            set(
                "census proof extra field",
                p!["censusProof", "depth"],
                json!(3),
            ),
            set(
                "census proof path bits as a string",
                p!["censusProof", "pathBits"],
                json!("3"),
            ),
            remove("census proof without type", p!["censusProof", "type"]),
            set("census proof null", p!["censusProof"], Value::Null),
            remove("no census proof", p!["censusProof"]),
            set("unknown field", p!["extra"], json!(1)),
            remove("proof without curve", p!["ballotProof", "curve"]),
            remove("proof without protocol", p!["ballotProof", "protocol"]),
            set(
                "proof with an extra field",
                p!["ballotProof", "extra"],
                json!("x"),
            ),
            ("proof pi_a of 2", vec![Op::Pop(p!["ballotProof", "pi_a"])]),
            set("proof pi_a number", p!["ballotProof", "pi_a", 0], json!(1)),
            remove("no weight", p!["weight"]),
            remove("no signature", p!["signature"]),
        ],
        |_| true,
    )
}

fn csp_request_cases(good: &Value) -> Value {
    verdicts::<VoteRequest>(
        good,
        vec![
            ok_json("canonical"),
            set("31-byte r", p!["censusProof", "r"], json!(hexs(1, 31))),
            set(
                "s without 0x",
                p!["censusProof", "s"],
                json!("02".repeat(32)),
            ),
            set("recid 0", p!["censusProof", "recid"], json!(0)),
            set("recid 2", p!["censusProof", "recid"], json!(2)),
            set("recid 256", p!["censusProof", "recid"], json!(256)),
            set("index as a string", p!["censusProof", "index"], json!("9")),
            set("negative index", p!["censusProof", "index"], json!(-1)),
            set(
                "index 2^53 - 1",
                p!["censusProof", "index"],
                json!(9007199254740991u64),
            ),
            remove("no index", p!["censusProof", "index"]),
            set("extra field", p!["censusProof", "weight"], json!("42")),
        ],
        |_| true,
    )
}

fn process_view_cases(good: &Value) -> Value {
    verdicts::<ProcessView>(
        good,
        vec![
            ok_json("canonical"),
            set(
                "groupSize > numFields",
                p!["ballotMode", "groupSize"],
                json!(5),
            ),
            set(
                "maxValue 2^48",
                p!["ballotMode", "maxValue"],
                json!((1u64 << 48).to_string()),
            ),
            set(
                "maxValue 2^48 - 1",
                p!["ballotMode", "maxValue"],
                json!(((1u64 << 48) - 1).to_string()),
            ),
            set(
                "maxValueSum 2^63",
                p!["ballotMode", "maxValueSum"],
                json!((1u64 << 63).to_string()),
            ),
            set(
                "maxValue as a number",
                p!["ballotMode", "maxValue"],
                json!(5),
            ),
            set(
                "numFields as a string",
                p!["ballotMode", "numFields"],
                json!("4"),
            ),
            set("numFields 256", p!["ballotMode", "numFields"], json!(256)),
            (
                "numFields 0",
                vec![
                    Op::Set(p!["ballotMode", "numFields"], json!(0)),
                    Op::Set(p!["ballotMode", "groupSize"], json!(0)),
                ],
            ),
            set(
                "ballot mode extra field",
                p!["ballotMode", "extra"],
                json!(1),
            ),
            set("key off curve", p!["encryptionKey", "y"], json!("3")),
            set("key extra field", p!["encryptionKey", "z"], json!("1")),
            set("status finished", p!["status"], json!("finished")),
            set("status Ready", p!["status"], json!("Ready")),
            set("status unknown", p!["status"], json!("unknown")),
            set("status results", p!["status"], json!("results")),
            set("unknown field", p!["extra"], json!({"a": 1})),
            set("local root null", p!["localStateRoot"], Value::Null),
            set("local root", p!["localStateRoot"], json!(hexs(5, 32))),
            set(
                "local root 31 bytes",
                p!["localStateRoot"],
                json!(hexs(5, 31)),
            ),
            remove("no synced", p!["synced"]),
            (
                "ignored with a note",
                vec![
                    Op::Set(p!["ignored"], json!(true)),
                    Op::Set(p!["note"], json!("census: download failed")),
                ],
            ),
            set("31-byte state root", p!["stateRoot"], json!(hexs(4, 31))),
            set("census root = p", p!["census", "censusRoot"], json!(P)),
            set(
                "census extra field",
                p!["census", "contractAddress"],
                json!(hexs(0, 20)),
            ),
            (
                "census uri misnamed",
                vec![
                    Op::Set(
                        p!["census", "censusUri"],
                        good["census"]["censusURI"].clone(),
                    ),
                    Op::Remove(p!["census", "censusURI"]),
                ],
            ),
            set("negative votersCount", p!["votersCount"], json!(-1)),
            set("votersCount as a string", p!["votersCount"], json!("2")),
            set("fractional startTime", p!["startTime"], json!(1.5)),
            set("result null", p!["result"], Value::Null),
            set("result", p!["result"], json!([7, 0, 3])),
            set("result as strings", p!["result"], json!(["7"])),
            set(
                "19-byte organization",
                p!["organizationId"],
                json!(hexs(9, 19)),
            ),
            remove("no duration", p!["duration"]),
            remove("no ignored", p!["ignored"]),
            remove("no census", p!["census"]),
        ],
        |_| true,
    )
}

fn info_cases(good: &Value) -> Value {
    verdicts::<Info>(
        good,
        vec![
            ok_json("canonical"),
            (
                "observer",
                vec![
                    Op::Set(p!["sequencerAddress"], Value::Null),
                    Op::Set(p!["observer"], json!(true)),
                ],
            ),
            set(
                "19-byte sequencer address",
                p!["sequencerAddress"],
                json!(hexs(1, 19)),
            ),
            remove("no sequencerAddress", p!["sequencerAddress"]),
            remove("no lostRaces", p!["lostRaces"]),
            remove("no settledBySelf", p!["settledBySelf"]),
            set("chainId as a string", p!["chainId"], json!("100")),
            set("31-byte vk hash", p!["ballotVkHash"], json!(hexs(3, 31))),
            set("unknown field", p!["version"], json!("1.0")),
        ],
        |_| true,
    )
}

fn key_cases(good: &Value) -> Value {
    // `point()` is what `SequencerClient::new_key` decodes with.
    verdicts::<EncryptionKeyResponse>(
        good,
        vec![
            ok_json("canonical"),
            set("off curve", p![], json!({"x": "1", "y": "2"})),
            set("x = p", p![], json!({"x": P, "y": "1"})),
            set("identity", p![], json!({"x": "0", "y": "1"})),
            set("hex coordinates", p![], json!({"x": "0x01", "y": "0x02"})),
            set("extra field", p!["z"], json!("0")),
        ],
        |r| r.point().is_ok(),
    )
}

// What `SequencerClient::new_key` accepts after decoding: a prime-order,
// non-identity point.
fn new_key_cases() -> Value {
    use davinci_zkvm_sdk::crypto::field::{fr_from_dec, fr_to_dec};
    let dec = |p: &Point| json!({"x": fr_to_dec(&p.x), "y": fr_to_dec(&p.y)});
    let order2 = json!({"x": "0", "y": fr_to_dec(&(Fr::from(0u64) - Fr::from(1u64)))});
    let low = |label: &str, j: Value| {
        let ok = serde_json::from_value::<EncryptionKeyResponse>(j.clone())
            .ok()
            .and_then(|r| r.point().ok())
            .is_some_and(|p| p != Point::IDENTITY && p.in_subgroup());
        json!({"label": label, "json": j, "ok": ok})
    };
    let g = Point::generator();
    // circomlib's order-8l generator: on the curve, outside the subgroup.
    let full = Point {
        x: fr_from_dec(
            "995203441582195749578291179787384436505546430278305826713579947235728471134",
        )
        .unwrap(),
        y: fr_from_dec(
            "5472060717959818805561601436314318772137091100104008585924551046643952123905",
        )
        .unwrap(),
    };
    assert!(full.is_on_curve() && !full.in_subgroup());
    json!([
        low(
            "12345 * B8",
            serde_json::to_value(EncryptionKeyResponse::from_point(&pk())).unwrap()
        ),
        low("B8", dec(&g)),
        low("identity", json!({"x": "0", "y": "1"})),
        low("order 2", order2),
        low("full-group generator", dec(&full)),
    ])
}

fn status_cases() -> Value {
    let cases = [
        json!({"status": "pending"}),
        json!({"status": "aggregated"}),
        json!({"status": "processed"}),
        json!({"status": "settled"}),
        json!({"status": "error", "error": "process closed"}),
        json!({"status": "settled", "error": null}),
        json!({"status": "done"}),
        json!({"status": "verified"}),
        json!({"status": "Settled"}),
        json!({"status": "error", "error": 3}),
        json!({"error": "x"}),
    ];
    Value::Array(
        cases
            .into_iter()
            .map(|j| {
                let ok = serde_json::from_value::<VoteStatusResponse>(j.clone()).is_ok();
                json!({"json": j, "ok": ok})
            })
            .collect(),
    )
}

fn tracker() -> TrackerProof {
    TrackerProof {
        process_id: ProcessId([0x5a; 31]),
        vote_id: 0x8000_0000_0000_4321,
        root: [0x0c; 32],
        siblings: vec![[1; 32], [0; 32], [0xfe; 32]],
    }
}

fn tracker_cases(good: &Value) -> Value {
    verdicts::<TrackerProof>(
        good,
        vec![
            ok_json("canonical"),
            set(
                "vote id below 2^63",
                p!["voteId"],
                json!("0x0000000000004321"),
            ),
            set("31-byte root", p!["root"], json!(hexs(0x0c, 31))),
            set("33-byte sibling", p!["siblings", 1], json!(hexs(0, 33))),
            set("bad process id", p!["processId"], json!("0x5a")),
            set("no siblings", p!["siblings"], json!([])),
            set("unknown field", p!["extra"], json!(true)),
        ],
        |_| true,
    )
}

fn participant() -> ParticipantResponse {
    let mut t = LeanImt::new();
    for i in 0..7u8 {
        t.insert(census_leaf(&[i; 20], i as u128 + 1).unwrap());
    }
    ParticipantResponse {
        address: [6; 20],
        weight: 7,
        census_proof: MerkleProof::from(&t.proof(6).unwrap()),
    }
}

fn participant_cases(good: &Value) -> Value {
    verdicts::<ParticipantResponse>(
        good,
        vec![
            ok_json("canonical"),
            set("weight as a number", p!["weight"], json!(7)),
            set(
                "proof extra field",
                p!["censusProof", "type"],
                json!("merkle"),
            ),
            set("proof leaf = p", p!["censusProof", "leaf"], json!(P)),
            set("bad address", p!["address"], json!("0x06")),
            set("unknown field", p!["slot"], json!(1)),
        ],
        |_| true,
    )
}

fn ballot_cases(good: &Value) -> Value {
    verdicts::<BallotResponse>(
        good,
        vec![
            ok_json("canonical"),
            ("15 ciphertexts", vec![Op::Pop(p!["ballot"])]),
            set("off curve", p!["ballot", 1, "c2", "x"], json!("7")),
        ],
        |_| true,
    )
}

fn transitions() -> TransitionList {
    TransitionList {
        transitions: vec![
            TransitionView {
                index: 0,
                old_root: [1; 32],
                new_root: [2; 32],
                tx_hash: [0xaa; 32],
                block_number: 48_600_000,
                sender: [0x33; 20],
                voters: 3,
                overwrites: 0,
                n_blobs: 1,
            },
            TransitionView {
                index: 1,
                old_root: [2; 32],
                new_root: [3; 32],
                tx_hash: [0xbb; 32],
                block_number: 48_600_120,
                sender: [0x44; 20],
                voters: 5,
                overwrites: 2,
                n_blobs: 2,
            },
        ],
    }
}

fn transition_cases(good: &Value) -> Value {
    verdicts::<TransitionList>(
        good,
        vec![
            ok_json("canonical"),
            set(
                "31-byte tx hash",
                p!["transitions", 0, "txHash"],
                json!(hexs(0xaa, 31)),
            ),
            set(
                "block as a string",
                p!["transitions", 1, "blockNumber"],
                json!("48600120"),
            ),
            set("empty", p!["transitions"], json!([])),
        ],
        |_| true,
    )
}

fn blob_cases(good: &Value) -> Value {
    verdicts::<BlobsResponse>(
        good,
        vec![
            ok_json("canonical"),
            set("odd hex", p!["blobs", 0], json!("0x123")),
            set("no 0x", p!["blobs", 1], json!("abcdef")),
            set("upper hex", p!["blobs", 1], json!("0xABCDEF")),
            set("empty blob", p!["blobs", 0], json!("0x")),
            set("not hex", p!["blobs", 0], json!("0xzz")),
        ],
        |_| true,
    )
}

fn census_file_cases(good: &Value) -> Value {
    verdicts::<CensusFile>(
        good,
        vec![
            ok_json("canonical"),
            set(
                "weight as a number",
                p!["participants", 0, "weight"],
                json!(3),
            ),
            set(
                "19-byte key",
                p!["participants", 0, "key"],
                json!(hexs(0xaa, 19)),
            ),
        ],
        |_| true,
    )
}

fn pick_node_cases() -> Value {
    let sets: Vec<Vec<&str>> = vec![
        vec!["http://a:8080", "http://b:8080", "http://c:8080"],
        vec![
            "https://seq1.example.org",
            "https://seq2.example.org/",
            "https://seq3.example.org",
            "https://seq4.example.org",
        ],
        vec!["http://nodo-ñ.example", "http://node-n.example"],
        vec!["http://x:1", "http://x:1", "http://y:1"],
        vec!["http://only:8080"],
    ];
    let voters: Vec<[u8; 20]> = vec![[1; 20], [0x11; 20], [0xfe; 20], {
        let mut v = [0u8; 20];
        for (i, b) in v.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(37).wrapping_add(5);
        }
        v
    }];
    let pids: Vec<[u8; 31]> = vec![[7; 31], [0xab; 31]];
    let mut out = Vec::new();
    for nodes in &sets {
        for voter in &voters {
            for pid in &pids {
                let order: Vec<&str> = pick_node(voter, pid, nodes).into_iter().copied().collect();
                out.push(json!({
                    "voter": format!("0x{}", hex::encode(voter)),
                    "processId": format!("0x{}", hex::encode(pid)),
                    "nodes": nodes,
                    "order": order,
                }));
            }
        }
    }
    Value::Array(out)
}

fn main() {
    let merkle = serde_json::to_value(sample_vote(Some(merkle_wire()))).unwrap();
    let csp = serde_json::to_value(sample_vote(Some(csp_wire()))).unwrap();
    let bare = serde_json::to_value(sample_vote(None)).unwrap();

    let ready = serde_json::to_value(view(mode(4))).unwrap();
    let mut r = view(mode(2));
    r.status = ProcessStatus::Results;
    r.result = Some(vec![3, 0]);
    r.local_state_root = Some([6; 32]);
    r.synced = true;
    let results = serde_json::to_value(r).unwrap();

    let info = Info {
        sequencer_address: Some([1; 20]),
        chain_id: 31337,
        process_registry: [2; 20],
        ballot_vk_hash: [3; 32],
        batch_program_vk: [4; 32],
        results_program_vk: [5; 32],
        observer: false,
        settled_by_self: 7,
        synced_from_others: 8,
        lost_races: 3,
    };
    let info_json = serde_json::to_value(&info).unwrap();
    let observer = serde_json::to_value(Info {
        sequencer_address: None,
        observer: true,
        ..info
    })
    .unwrap();

    let key = serde_json::to_value(EncryptionKeyResponse::from_point(&pk())).unwrap();
    let tracker_json = serde_json::to_value(tracker()).unwrap();
    let participant_json = serde_json::to_value(participant()).unwrap();
    let ballot_json = serde_json::to_value(BallotResponse {
        address: [0x22; 20],
        ballot: sample_ballot(),
    })
    .unwrap();
    let transitions_json = serde_json::to_value(transitions()).unwrap();
    let blobs_json = serde_json::to_value(BlobsResponse {
        blobs: vec![vec![1, 2], vec![0xab, 0xcd, 0xef]],
    })
    .unwrap();
    let census_json = serde_json::to_value(CensusFile {
        participants: vec![
            CensusParticipant {
                key: [0xaa; 20],
                weight: 3,
            },
            CensusParticipant {
                key: [0xbb; 20],
                weight: u128::MAX,
            },
        ],
    })
    .unwrap();

    let statuses: Vec<Value> = [
        VoteStatus::Pending,
        VoteStatus::Aggregated,
        VoteStatus::Processed,
        VoteStatus::Settled,
        VoteStatus::Error,
    ]
    .iter()
    .map(|s| serde_json::to_value(s).unwrap())
    .collect();

    let out = json!({
        "voteRequest": {"merkle": merkle, "csp": csp, "noCensusProof": bare},
        "voteRequestCases": vote_request_cases(&merkle),
        "cspRequestCases": csp_request_cases(&csp),
        "processView": {"ready": ready, "results": results},
        "processViewCases": process_view_cases(&ready),
        "info": {"sequencer": info_json, "observer": observer},
        "infoCases": info_cases(&info_json),
        "encryptionKey": key,
        "encryptionKeyCases": key_cases(&key),
        "newKeyCases": new_key_cases(),
        "voteStatuses": statuses,
        "voteStatusCases": status_cases(),
        "trackerProof": tracker_json,
        "trackerProofCases": tracker_cases(&tracker_json),
        "participant": participant_json,
        "participantCases": participant_cases(&participant_json),
        "ballot": ballot_json,
        "ballotCases": ballot_cases(&ballot_json),
        "transitions": transitions_json,
        "transitionCases": transition_cases(&transitions_json),
        "blobs": blobs_json,
        "blobCases": blob_cases(&blobs_json),
        "censusFile": census_json,
        "censusFileCases": census_file_cases(&census_json),
        "pickNode": pick_node_cases(),
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}

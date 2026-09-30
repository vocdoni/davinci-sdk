//! Known DAVINCI deployments. The node's `--network` presets and the
//! organizer and voter defaults come from this table.

use alloy::primitives::{Address, address};

/// A deployment known by name: the chain, its `ProcessRegistry` and what a
/// node needs to follow it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Network {
    pub name: &'static str,
    pub chain_id: u64,
    pub registry: Address,
    /// The registry's deployment block: where a fresh node starts scanning.
    pub start_block: u64,
    /// Execution-layer JSON-RPCs, in order of preference.
    pub rpc_urls: &'static [&'static str],
    /// Blob source in the node's `--blob-source` form.
    pub blob_source: &'static str,
    /// Blocks behind head a node treats as final.
    pub confirmations: u64,
}

impl Network {
    /// The beacon APIs of a `beacon:` blob source.
    pub fn beacon_urls(&self) -> Vec<&'static str> {
        self.blob_source
            .strip_prefix("beacon:")
            .map(|s| s.split(',').collect())
            .unwrap_or_default()
    }
}

/// Gnosis Chain.
pub const GNOSIS: Network = Network {
    name: "gnosis",
    chain_id: 100,
    registry: address!("6702e0141B6b72bCF8C1bdff20A82A35C5502E7D"),
    start_block: 48_504_090,
    rpc_urls: &[
        "https://gnosis-rpc.publicnode.com",
        "https://gnosis-rpc.blockreq.com/v1/rpc/public",
        "https://rpc.gnosischain.com",
    ],
    blob_source: "beacon:https://rpc-gbc.gnosischain.com",
    confirmations: 3,
};

/// Every known deployment.
pub const NETWORKS: &[Network] = &[GNOSIS];

/// The deployment a node and the tooling use unless told otherwise.
pub const DEFAULT: &Network = &GNOSIS;

/// The known deployment called `name` (case-insensitive).
pub fn by_name(name: &str) -> Option<&'static Network> {
    let name = name.trim();
    NETWORKS.iter().find(|n| n.name.eq_ignore_ascii_case(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup() {
        assert_eq!(by_name(" Gnosis "), Some(&GNOSIS));
        assert_eq!(by_name("custom"), None);
        assert_eq!(by_name(DEFAULT.name), Some(DEFAULT));
        assert_eq!(
            GNOSIS.beacon_urls(),
            ["https://rpc-gbc.gnosischain.com"].to_vec()
        );
    }

    #[test]
    fn names_are_unique_and_lowercase() {
        for (i, n) in NETWORKS.iter().enumerate() {
            assert_eq!(n.name, n.name.to_ascii_lowercase());
            assert!(!n.rpc_urls.is_empty());
            assert!(NETWORKS[i + 1..].iter().all(|m| m.name != n.name));
        }
    }
}

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
    /// Where the deployment publishes transition data.
    pub da: NetworkDa,
}

/// How a deployment publishes transition data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NetworkDa {
    /// Blob transactions on the registry's own chain.
    Blobs,
    /// Ethereum blob transactions, proven on an OP Stack chain through the
    /// registry's `L1BlobVerifier`. `blob_source` then names Ethereum beacon APIs.
    L1Blobs {
        /// Ethereum's chain id.
        l1_chain_id: u64,
        /// The `L1Block` predeploy the verifier reads OP's origin from.
        l1_block: Address,
        /// Ethereum execution JSON-RPCs, in order of preference.
        l1_rpc_urls: &'static [&'static str],
    },
}

/// OP Stack's `L1Block` predeploy.
pub const OP_L1_BLOCK: Address = address!("4200000000000000000000000000000000000015");

impl Network {
    /// The beacon APIs of a `beacon:` blob source.
    pub fn beacon_urls(&self) -> Vec<&'static str> {
        self.blob_source
            .strip_prefix("beacon:")
            .map(|s| s.split(',').collect())
            .unwrap_or_default()
    }
}

/// OP Mainnet in L1-blob mode: transitions settle on OP, their blobs live on
/// Ethereum (ZisK 1.3.2 registry deployed 2026-10-13, see docs/deployments.md). Blob sends need an
/// Ethereum RPC that takes 1.5 MB bodies: publicnode refuses them, dRPC takes
/// them, and the node sends to every L1 endpoint at once.
pub const OPTIMISM: Network = Network {
    name: "optimism",
    chain_id: 10,
    registry: address!("6F500A3e3A161EcB3C19A034bFB6a6Ac3b71abE6"),
    start_block: 158_414_417,
    rpc_urls: &[
        "https://optimism-rpc.publicnode.com",
        "https://mainnet.optimism.io",
    ],
    // Ethereum beacon APIs: they must keep full blobs (supernodes, archives).
    blob_source: "beacon:https://ethereum-beacon-api.publicnode.com",
    confirmations: 1,
    da: NetworkDa::L1Blobs {
        l1_chain_id: 1,
        l1_block: OP_L1_BLOCK,
        l1_rpc_urls: &[
            "https://ethereum-rpc.publicnode.com",
            "https://eth.drpc.org",
        ],
    },
};

/// Every known deployment. The Gnosis registries are retired (their
/// program vks are v0.1's): see docs/deployments.md.
pub const NETWORKS: &[Network] = &[OPTIMISM];

/// The deployment a node and the tooling use unless told otherwise.
pub const DEFAULT: &Network = &OPTIMISM;

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
        assert_eq!(by_name(" Optimism "), Some(&OPTIMISM));
        assert_eq!(by_name("custom"), None);
        // Gnosis is retired.
        assert_eq!(by_name("gnosis"), None);
        assert_eq!(DEFAULT, &OPTIMISM);
        assert_eq!(by_name(DEFAULT.name), Some(DEFAULT));
        assert_eq!(
            OPTIMISM.beacon_urls(),
            ["https://ethereum-beacon-api.publicnode.com"].to_vec()
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

    // The preset's registry verifies the ZisK 1.3.2 programs: a build
    // against another davinci-zkvm release would settle nothing there.
    #[test]
    fn optimism_pins_equal_the_zkvm_release() {
        use alloy::primitives::hex;
        use davinci_zkvm_sdk::release;
        assert_eq!(
            release::BATCH_PROGRAM_VK,
            hex!("e39e460085ecddecf365649a61183a71c0fe778aa9c06fd2aa1a6c43cddb988b"),
            "batch program vk"
        );
        assert_eq!(
            release::RESULTS_PROGRAM_VK,
            hex!("394694558f39d0b2da0bbb09322333a0f567ee8d16bea2f354543a086587d167"),
            "results program vk"
        );
        assert_eq!(
            release::ROOT_C_VADCOP_FINAL,
            hex!("6b2490fba336fb00f0c8719a961de309a8db6f43a9bfb7575ca5f014d609b265"),
            "rootC"
        );
    }

    #[test]
    fn optimism_preset_is_deployed() {
        assert_ne!(OPTIMISM.registry, Address::ZERO, "optimism registry unset");
        assert_ne!(OPTIMISM.start_block, 0, "optimism start block unset");
    }

    #[test]
    fn optimism_posts_its_blobs_on_ethereum() {
        assert_eq!(by_name(" Optimism "), Some(&OPTIMISM));
        assert_eq!(OPTIMISM.chain_id, 10);
        assert_eq!(OPTIMISM.confirmations, 1);
        let NetworkDa::L1Blobs {
            l1_chain_id,
            l1_block,
            l1_rpc_urls,
        } = OPTIMISM.da
        else {
            panic!("optimism must be an L1-blob preset");
        };
        assert_eq!((l1_chain_id, l1_block), (1, OP_L1_BLOCK));
        assert!(!l1_rpc_urls.is_empty());
        // Followers read the blobs from Ethereum beacon APIs.
        assert!(!OPTIMISM.beacon_urls().is_empty());
    }
}

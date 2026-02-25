// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.28;

/// @title ICensusValidator
/// @notice Interface for validating census Merkle roots
/// @dev Implement this interface to enable external contracts to verify census roots
///      Useful for voting systems, governance contracts, and other on-chain mechanisms
///      that need to validate voting power at specific block numbers
interface ICensusValidator {
    /// @notice Emitted when an account's weight changes in the census
    /// @param account The address of the account whose weight changed
    /// @param previousWeight The previous weight of the account
    /// @param newWeight The new weight of the account
    event WeightChanged(address indexed account, uint88 previousWeight, uint88 newWeight);

    /// @notice Validates a census root and returns the last block where it is/was valid
    /// @dev Returns the last block where the root is/was valid.
    ///      For the current root, returns block.number (still valid).
    ///      For historical roots, returns the block number when it was replaced (last valid block).
    ///      Returns 0 if the root has never been set or has been evicted from history.
    ///      The root history is maintained in a circular buffer (last 100 roots)
    /// @param root The census Merkle root to validate
    /// @return blockNumber The last block where this root is/was valid (0 if invalid/evicted)
    function getRootBlockNumber(uint256 root) external view returns (uint256 blockNumber);

    /// @notice Current census Merkle root (Lean-IMT).
    /// @return root The latest census root
    function getCensusRoot() external view returns (uint256 root);

    /// @notice Returns total voting power associated with a recorded census root.
    /// @dev Returns 0 if the root has not been recorded, or if its total power is zero.
    ///      Pair with getRootBlockNumber(root) to disambiguate unknown roots.
    /// @param root The census root to query.
    /// @return totalVotingPower Total voting power at that root snapshot.
    function getTotalVotingPowerAtRoot(uint256 root) external view returns (uint256 totalVotingPower);
}

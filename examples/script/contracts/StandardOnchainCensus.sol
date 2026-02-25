// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ICensusValidator} from "./ICensusValidator.sol";

contract StandardOnchainCensus is ICensusValidator {
    address public owner;
    mapping(address => uint88) public weightOf;

    uint256 private _currentRoot;
    uint256 private _totalVotingPower;
    mapping(uint256 => uint256) private _rootLastValidBlock;
    mapping(uint256 => uint256) private _rootTotalVotingPower;

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        _currentRoot = 0;
        _rootTotalVotingPower[_currentRoot] = 0;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        owner = newOwner;
    }

    function setWeight(address account, uint88 newWeight) external onlyOwner {
        uint88 previous = weightOf[account];
        weightOf[account] = newWeight;

        if (newWeight >= previous) {
            _totalVotingPower += (newWeight - previous);
        } else {
            _totalVotingPower -= (previous - newWeight);
        }

        emit WeightChanged(account, previous, newWeight);
        _rotateRoot(account, newWeight);
    }

    function setWeights(address[] calldata accounts, uint88[] calldata weights) external onlyOwner {
        require(accounts.length == weights.length, "length mismatch");
        for (uint256 i = 0; i < accounts.length; i++) {
            uint88 previous = weightOf[accounts[i]];
            weightOf[accounts[i]] = weights[i];

            if (weights[i] >= previous) {
                _totalVotingPower += (weights[i] - previous);
            } else {
                _totalVotingPower -= (previous - weights[i]);
            }

            emit WeightChanged(accounts[i], previous, weights[i]);
            _rotateRoot(accounts[i], weights[i]);
        }
    }

    function getCensusRoot() external view returns (uint256 root) {
        return _currentRoot;
    }

    function getRootBlockNumber(uint256 root) external view returns (uint256 blockNumber) {
        if (root == _currentRoot) {
            return block.number;
        }
        return _rootLastValidBlock[root];
    }

    function getTotalVotingPowerAtRoot(uint256 root) external view returns (uint256 totalVotingPower) {
        if (root == _currentRoot) {
            return _totalVotingPower;
        }
        return _rootTotalVotingPower[root];
    }

    function _rotateRoot(address account, uint88 newWeight) internal {
        uint256 oldRoot = _currentRoot;
        uint256 newRoot = uint256(
            keccak256(abi.encodePacked(oldRoot, account, newWeight, block.number))
        );

        if (oldRoot != newRoot) {
            _rootLastValidBlock[oldRoot] = block.number;
        }

        _currentRoot = newRoot;
        _rootTotalVotingPower[newRoot] = _totalVotingPower;
    }
}

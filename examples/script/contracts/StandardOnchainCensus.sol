// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract StandardOnchainCensus {
    event WeightChanged(address indexed account, uint88 previousWeight, uint88 newWeight);

    address public owner;
    mapping(address => uint88) public weightOf;

    uint256 private _censusRoot;
    mapping(uint256 => uint256) private _rootBlockNumber;

    modifier onlyOwner() {
        require(msg.sender == owner, "only owner");
        _;
    }

    constructor() {
        owner = msg.sender;
        _rootBlockNumber[_censusRoot] = block.number;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        owner = newOwner;
    }

    function setWeight(address account, uint88 newWeight) external onlyOwner {
        uint88 previous = weightOf[account];
        weightOf[account] = newWeight;
        emit WeightChanged(account, previous, newWeight);
        _rotateRoot(account, newWeight);
    }

    function setWeights(address[] calldata accounts, uint88[] calldata weights) external onlyOwner {
        require(accounts.length == weights.length, "length mismatch");
        for (uint256 i = 0; i < accounts.length; i++) {
            uint88 previous = weightOf[accounts[i]];
            weightOf[accounts[i]] = weights[i];
            emit WeightChanged(accounts[i], previous, weights[i]);
            _rotateRoot(accounts[i], weights[i]);
        }
    }

    function getCensusRoot() external view returns (uint256 root) {
        return _censusRoot;
    }

    function getRootBlockNumber(uint256 root) external view returns (uint256 blockNumber) {
        return _rootBlockNumber[root];
    }

    function _rotateRoot(address account, uint88 newWeight) internal {
        _censusRoot = uint256(keccak256(abi.encodePacked(_censusRoot, account, newWeight, block.number)));
        _rootBlockNumber[_censusRoot] = block.number;
    }
}

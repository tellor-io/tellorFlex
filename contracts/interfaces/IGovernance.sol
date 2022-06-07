// SPDX-License-Identifier: MIT
pragma solidity 0.8.3;

interface IGovernance {
    function getVoteCount() external view returns (uint256);
    function getVoteTallyByAddress(address _voter) external view returns (uint256);
}
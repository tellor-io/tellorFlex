// SPDX-License-Identifier: MIT
pragma solidity 0.8.3;

import "../TellorFlex.sol";

contract TestFlex is TellorFlex {
    constructor(
        address _token,
        uint256 _reportingLock,
        uint256 _stakeAmountDollarTarget,
        uint256 _stakingTokenPrice,
        uint256 _stakingTokenPriceDecimals,
        bytes32 _stakingTokenPriceQueryId,
        uint256 _baseTokenPrice,
        uint256 _baseTokenPriceDecimals,
        bytes32 _baseTokenPriceQueryId
    ) TellorFlex(_token, _reportingLock, _stakeAmountDollarTarget, _stakingTokenPrice, _stakingTokenPriceDecimals, _stakingTokenPriceQueryId, _baseTokenPrice, _baseTokenPriceDecimals, _baseTokenPriceQueryId) {}

    function updateRewards() external {
        _updateRewards();
    }

    function updateStakeAndPayRewards(
        address _stakerAddress,
        uint256 _newStakedBalance
    ) external {
        _updateStakeAndPayRewards(_stakerAddress, _newStakedBalance);
    }

    function getUpdatedAccumulatedRewardPerShare()
        external
        view
        returns (uint256)
    {
        return _getUpdatedAccumulatedRewardPerShare();
    }
}
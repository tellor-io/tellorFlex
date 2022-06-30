// SPDX-License-Identifier: MIT
pragma solidity 0.8.3;

import "../TellorFlex.sol";

contract TestFlex is TellorFlex {
    constructor(
        address _token,
        uint256 _reportingLock,
        uint256 _stakeAmountDollarTarget,
        uint256 _priceTRB
    ) TellorFlex(_token, _reportingLock, _stakeAmountDollarTarget, _priceTRB) {}

    function updateStakeAmount() external {
        _updateStakeAmount();
    }

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
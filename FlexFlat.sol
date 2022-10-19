// Sources flattened with hardhat v2.10.2 https://hardhat.org

// File contracts/interfaces/IERC20.sol

// SPDX-License-Identifier: MIT
pragma solidity 0.8.3;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);

    function transfer(address recipient, uint256 amount)
        external
        returns (bool);

    function transferFrom(
        address sender,
        address recipient,
        uint256 amount
    ) external returns (bool);
}


// File contracts/TellorFlex.sol

// SPDX-License-Identifier: MIT
pragma solidity 0.8.3;

/**
 @author Tellor Inc.
 @title TellorFlex
 @dev This is a streamlined Tellor oracle system which handles staking, reporting,
 * slashing, and user data getters in one contract. This contract is controlled
 * by a single address known as 'governance', which could be an externally owned
 * account or a contract, allowing for a flexible, modular design.
*/
contract TellorFlex {
    // Storage
    IERC20 public token; // token used for staking and rewards
    address public governance; // address with ability to remove values and slash reporters
    address public owner; // contract deployer, can call init function once
    uint256 public accumulatedRewardPerShare; // accumulated staking reward per staked token
    uint256 public minimumStakeAmount; // minimum amount of tokens required to stake
    uint256 public reportingLock; // base amount of time before a reporter is able to submit a value again
    uint256 public rewardRate; // total staking rewards released per second
    uint256 public stakeAmount; // minimum amount required to be a staker
    uint256 public stakeAmountDollarTarget; // amount of US dollars required to be a staker
    uint256 public stakingRewardsBalance; // total amount of staking rewards
    bytes32 public stakingTokenPriceQueryId; // staking token SpotPrice queryId, used for updating stakeAmount
    uint256 public timeBasedReward = 5e17; // amount of TB rewards released per 5 minutes
    uint256 public timeOfLastAllocation; // time of last update to accumulatedRewardPerShare
    uint256 public timeOfLastNewValue = block.timestamp; // time of the last new submitted value, originally set to the block timestamp
    uint256 public totalRewardDebt; // staking reward debt, used to calculate real staking rewards balance
    uint256 public totalStakeAmount; // total amount of tokens locked in contract (via stake)
    uint256 public totalStakers; // total number of stakers with at least stakeAmount staked, not exact

    mapping(bytes32 => Report) private reports; // mapping of query IDs to a report
    mapping(address => StakeInfo) private stakerDetails; // mapping from a persons address to their staking info

    // Structs
    struct Report {
        uint256[] timestamps; // array of all newValueTimestamps reported
        mapping(uint256 => uint256) timestampIndex; // mapping of timestamps to respective indices
        mapping(uint256 => uint256) timestampToBlockNum; // mapping of timestamp to block number
        mapping(uint256 => bytes) valueByTimestamp; // mapping of timestamps to values
        mapping(uint256 => address) reporterByTimestamp; // mapping of timestamps to reporters
        mapping(uint256 => bool) isDisputed;
    }

    struct StakeInfo {
        uint256 startDate; // stake or withdrawal request start date
        uint256 stakedBalance; // staked token balance
        uint256 lockedBalance; // amount locked for withdrawal
        uint256 rewardDebt; // used for staking reward calculation
        uint256 reporterLastTimestamp; // timestamp of reporter's last reported value
        uint256 reportsSubmitted; // total number of reports submitted by reporter
        uint256 startVoteCount; // total number of governance votes when stake deposited
        uint256 startVoteTally; // staker vote tally when stake deposited
        bool staked; // used to keep track of total stakers
        mapping(bytes32 => uint256) reportsSubmittedByQueryId; // mapping of queryId to number of reports submitted by reporter
    }

    // Events
    event NewReport(
        bytes32 indexed _queryId,
        uint256 _time,
        bytes _value,
        uint256 _nonce,
        bytes indexed _queryData,
        address indexed _reporter
    );
    event NewStakeAmount(uint256 _newStakeAmount);
    event NewStaker(address indexed _staker, uint256 indexed _amount);
    event ReporterSlashed(
        address indexed _reporter,
        address _recipient,
        uint256 _slashAmount
    );
    event StakeWithdrawn(address _staker);
    event StakeWithdrawRequested(address _staker, uint256 _amount);
    event ValueRemoved(bytes32 _queryId, uint256 _timestamp);

    // Functions
    /**
     * @dev Initializes system parameters
     * @param _token address of token used for staking and rewards
     * @param _reportingLock base amount of time (seconds) before reporter is able to report again
     * @param _stakeAmountDollarTarget fixed USD amount that stakeAmount targets on updateStakeAmount
     * @param _stakingTokenPrice current price of staking token in USD (18 decimals)
     * @param _stakingTokenPriceQueryId queryId where staking token price is reported
     */
    constructor(
        address _token,
        uint256 _reportingLock,
        uint256 _stakeAmountDollarTarget,
        uint256 _stakingTokenPrice,
        uint256 _minimumStakeAmount,
        bytes32 _stakingTokenPriceQueryId
    ) {
        require(_token != address(0), "must set token address");
        require(_stakingTokenPrice > 0, "must set staking token price");
        require(_reportingLock > 0, "must set reporting lock");
        require(_stakingTokenPriceQueryId != bytes32(0), "must set staking token price queryId");
        token = IERC20(_token);
        owner = msg.sender;
        reportingLock = _reportingLock;
        stakeAmountDollarTarget = _stakeAmountDollarTarget;
        minimumStakeAmount = _minimumStakeAmount;
        uint256 _potentialStakeAmount = (_stakeAmountDollarTarget * 1e18) / _stakingTokenPrice;
        if(_potentialStakeAmount < _minimumStakeAmount) {
            stakeAmount = _minimumStakeAmount;
        } else {
            stakeAmount = _potentialStakeAmount;
        }
        stakingTokenPriceQueryId = _stakingTokenPriceQueryId;
    }

    /**
     * @dev Allows the owner to initialize the governance (flex addy needed for governance deployment)
     * @param _governanceAddress address of governance contract (github.com/tellor-io/governance)
     */
    function init(address _governanceAddress) external {
        require(msg.sender == owner, "only owner can set governance address");
        require(governance == address(0), "governance address already set");
        require(
            _governanceAddress != address(0),
            "governance address can't be zero address"
        );
        governance = _governanceAddress;
    }

    /**
     * @dev Funds the Flex contract with staking rewards (paid by autopay and minting)
     * @param _amount amount of tokens to fund contract with
     */
    function addStakingRewards(uint256 _amount) external {
        require(token.transferFrom(msg.sender, address(this), _amount));
        _updateRewards();
        stakingRewardsBalance += _amount;
        // update reward rate = real staking rewards balance / 30 days
        rewardRate =
            (stakingRewardsBalance -
                ((accumulatedRewardPerShare * totalStakeAmount) /
                    1e18 -
                    totalRewardDebt)) /
            30 days;
    }

    /**
     * @dev Allows a reporter to submit stake
     * @param _amount amount of tokens to stake
     */
    function depositStake(uint256 _amount) external {
        require(governance != address(0), "governance address not set");
        StakeInfo storage _staker = stakerDetails[msg.sender];
        uint256 _stakedBalance = _staker.stakedBalance;
        uint256 _lockedBalance = _staker.lockedBalance;
        if (_lockedBalance > 0) {
            if (_lockedBalance >= _amount) {
                // if staker's locked balance covers full _amount, use that
                _staker.lockedBalance -= _amount;
            } else {
                // otherwise, stake the whole locked balance and transfer the
                // remaining amount from the staker's address
                require(
                    token.transferFrom(
                        msg.sender,
                        address(this),
                        _amount - _lockedBalance
                    )
                );
                _staker.lockedBalance = 0;
            }
        } else {
            if (_stakedBalance == 0) {
                // if staked balance and locked balance equal 0, save current vote tally.
                // voting participation used for calculating rewards
                (bool _success, bytes memory _returnData) = governance.call(
                    abi.encodeWithSignature("getVoteCount()")
                );
                if (_success) {
                    _staker.startVoteCount = uint256(abi.decode(_returnData, (uint256)));
                }
                (_success,_returnData) = governance.call(
                    abi.encodeWithSignature("getVoteTallyByAddress(address)",msg.sender)
                );
                if(_success){
                    _staker.startVoteTally =  abi.decode(_returnData,(uint256));
                }
            }
            require(token.transferFrom(msg.sender, address(this), _amount));
        }
        _updateStakeAndPayRewards(msg.sender, _stakedBalance + _amount);
        _staker.startDate = block.timestamp; // This resets the staker start date to now
        emit NewStaker(msg.sender, _amount);
    }

    /**
     * @dev Removes a value from the oracle.
     * Note: this function is only callable by the Governance contract.
     * @param _queryId is ID of the specific data feed
     * @param _timestamp is the timestamp of the data value to remove
     */
    function removeValue(bytes32 _queryId, uint256 _timestamp) external {
        require(msg.sender == governance, "caller must be governance address");
        Report storage _report = reports[_queryId];
        require(!_report.isDisputed[_timestamp], "value already disputed");
        uint256 _index = _report.timestampIndex[_timestamp];
        require(_timestamp == _report.timestamps[_index], "invalid timestamp");
        _report.valueByTimestamp[_timestamp] = "";
        _report.isDisputed[_timestamp] = true;
        emit ValueRemoved(_queryId, _timestamp);
    }

    /**
     * @dev Allows a reporter to request to withdraw their stake
     * @param _amount amount of staked tokens requesting to withdraw
     */
    function requestStakingWithdraw(uint256 _amount) external {
        StakeInfo storage _staker = stakerDetails[msg.sender];
        require(
            _staker.stakedBalance >= _amount,
            "insufficient staked balance"
        );
        _updateStakeAndPayRewards(msg.sender, _staker.stakedBalance - _amount);
        _staker.startDate = block.timestamp;
        _staker.lockedBalance += _amount;
        emit StakeWithdrawRequested(msg.sender, _amount);
    }

    /**
     * @dev Slashes a reporter and transfers their stake amount to the given recipient
     * Note: this function is only callable by the governance address.
     * @param _reporter is the address of the reporter being slashed
     * @param _recipient is the address receiving the reporter's stake
     * @return _slashAmount uint256 amount of token slashed and sent to recipient address
     */
    function slashReporter(address _reporter, address _recipient)
        external
        returns (uint256 _slashAmount)
    {
        require(msg.sender == governance, "only governance can slash reporter");
        StakeInfo storage _staker = stakerDetails[_reporter];
        uint256 _stakedBalance = _staker.stakedBalance;
        uint256 _lockedBalance = _staker.lockedBalance;
        require(_stakedBalance + _lockedBalance > 0, "zero staker balance");
        if (_lockedBalance >= stakeAmount) {
            // if locked balance is at least stakeAmount, slash from locked balance
            _slashAmount = stakeAmount;
            _staker.lockedBalance -= stakeAmount;
        } else if (_lockedBalance + _stakedBalance >= stakeAmount) {
            // if locked balance + staked balance is at least stakeAmount,
            // slash from locked balance and slash remainder from staked balance
            _slashAmount = stakeAmount;
            _updateStakeAndPayRewards(
                _reporter,
                _stakedBalance - (stakeAmount - _lockedBalance)
            );
            _staker.lockedBalance = 0;
        } else {
            // if sum(locked balance + staked balance) is less than stakeAmount,
            // slash sum
            _slashAmount = _stakedBalance + _lockedBalance;
            _updateStakeAndPayRewards(_reporter, 0);
            _staker.lockedBalance = 0;
        }
        require(token.transfer(_recipient, _slashAmount));
        emit ReporterSlashed(_reporter, _recipient, _slashAmount);
    }

    /**
     * @dev Allows a reporter to submit a value to the oracle
     * @param _queryId is ID of the specific data feed. Equals keccak256(_queryData) for non-legacy IDs
     * @param _value is the value the user submits to the oracle
     * @param _nonce is the current value count for the query id
     * @param _queryData is the data used to fulfill the data query
     */
    function submitValue(
        bytes32 _queryId,
        bytes calldata _value,
        uint256 _nonce,
        bytes calldata _queryData
    ) external {
        require(keccak256(_value) != keccak256(""), "value must be submitted");
        Report storage _report = reports[_queryId];
        require(
            _nonce == _report.timestamps.length || _nonce == 0,
            "nonce must match timestamp index"
        );
        StakeInfo storage _staker = stakerDetails[msg.sender];
        require(
            _staker.stakedBalance >= stakeAmount,
            "balance must be greater than stake amount"
        );
        // Require reporter to abide by given reporting lock
        require(
            (block.timestamp - _staker.reporterLastTimestamp) * 1000 >
                (reportingLock * 1000) / (_staker.stakedBalance / stakeAmount),
            "still in reporter time lock, please wait!"
        );
        require(
            _queryId == keccak256(_queryData),
            "query id must be hash of query data"
        );
        _staker.reporterLastTimestamp = block.timestamp;
        // Checks for no double reporting of timestamps
        require(
            _report.reporterByTimestamp[block.timestamp] == address(0),
            "timestamp already reported for"
        );
        // Update number of timestamps, value for given timestamp, and reporter for timestamp
        _report.timestampIndex[block.timestamp] = _report.timestamps.length;
        _report.timestamps.push(block.timestamp);
        _report.timestampToBlockNum[block.timestamp] = block.number;
        _report.valueByTimestamp[block.timestamp] = _value;
        _report.reporterByTimestamp[block.timestamp] = msg.sender;
        // Disperse Time Based Reward
        uint256 _reward = ((block.timestamp - timeOfLastNewValue) * timeBasedReward) / 300; //.5 TRB per 5 minutes
        uint256 _totalTimeBasedRewardsBalance =
            token.balanceOf(address(this)) -
            (totalStakeAmount + stakingRewardsBalance);
        if (_totalTimeBasedRewardsBalance > 0 && _reward > 0) {
            if (_totalTimeBasedRewardsBalance < _reward) {
                token.transfer(msg.sender, _totalTimeBasedRewardsBalance);
            } else {
                token.transfer(msg.sender, _reward);
            }
        }
        // Update last oracle value and number of values submitted by a reporter
        timeOfLastNewValue = block.timestamp;
        _staker.reportsSubmitted++;
        _staker.reportsSubmittedByQueryId[_queryId]++;
        emit NewReport(
            _queryId,
            block.timestamp,
            _value,
            _nonce,
            _queryData,
            msg.sender
        );
    }

    /**
     * @dev Updates the stake amount after retrieving the latest
     * 12+-hour-old staking token price from the oracle
     */
    function updateStakeAmount() external {
        // get staking token price
        (bool _valFound, bytes memory _val, ) = getDataBefore(
            stakingTokenPriceQueryId,
            block.timestamp - 12 hours
        );
        if (_valFound) {
            uint256 _stakingTokenPrice = abi.decode(_val, (uint256));
            require(
                _stakingTokenPrice >= 0.01 ether && _stakingTokenPrice < 1000000 ether,
                "invalid staking token price"
            );

            uint256 _adjustedStakeAmount = (stakeAmountDollarTarget * 1e18) / _stakingTokenPrice;
            if(_adjustedStakeAmount < minimumStakeAmount) {
                stakeAmount = minimumStakeAmount;
            } else {
                stakeAmount = _adjustedStakeAmount;
            }
            emit NewStakeAmount(stakeAmount);
        }
    }

    /**
     * @dev Withdraws a reporter's stake after the lock period expires
     */
    function withdrawStake() external {
        StakeInfo storage _staker = stakerDetails[msg.sender];
        // Ensure reporter is locked and that enough time has passed
        require(
            block.timestamp - _staker.startDate >= 7 days,
            "7 days didn't pass"
        );
        require(
            _staker.lockedBalance > 0,
            "reporter not locked for withdrawal"
        );
        require(token.transfer(msg.sender, _staker.lockedBalance));
        _staker.lockedBalance = 0;
        emit StakeWithdrawn(msg.sender);
    }

    // *****************************************************************************
    // *                                                                           *
    // *                               Getters                                     *
    // *                                                                           *
    // *****************************************************************************

    /**
     * @dev Returns the block number at a given timestamp
     * @param _queryId is ID of the specific data feed
     * @param _timestamp is the timestamp to find the corresponding block number for
     * @return uint256 block number of the timestamp for the given data ID
     */
    function getBlockNumberByTimestamp(bytes32 _queryId, uint256 _timestamp)
        external
        view
        returns (uint256)
    {
        return reports[_queryId].timestampToBlockNum[_timestamp];
    }

    /**
     * @dev Returns the current value of a data feed given a specific ID
     * @param _queryId is the ID of the specific data feed
     * @return _value the latest submitted value for the given queryId
     */
    function getCurrentValue(bytes32 _queryId)
        external
        view
        returns (bytes memory _value)
    {
        bool _didGet;
        (_didGet, _value, ) = getDataBefore(_queryId, block.timestamp + 1);
        if(!_didGet){revert();}
    }

    /**
     * @dev Retrieves the latest value for the queryId before the specified timestamp
     * @param _queryId is the queryId to look up the value for
     * @param _timestamp before which to search for latest value
     * @return _ifRetrieve bool true if able to retrieve a non-zero value
     * @return _value the value retrieved
     * @return _timestampRetrieved the value's timestamp
     */
    function getDataBefore(bytes32 _queryId, uint256 _timestamp)
        public
        view
        returns (
            bool _ifRetrieve,
            bytes memory _value,
            uint256 _timestampRetrieved
        )
    {
        (bool _found, uint256 _index) = getIndexForDataBefore(
            _queryId,
            _timestamp
        );
        if (!_found) return (false, bytes(""), 0);
        _timestampRetrieved = getTimestampbyQueryIdandIndex(_queryId, _index);
        _value = retrieveData(_queryId, _timestampRetrieved);
        return (true, _value, _timestampRetrieved);
    }

    /**
     * @dev Returns governance address
     * @return address governance
     */
    function getGovernanceAddress() external view returns (address) {
        return governance;
    }

    /**
     * @dev Counts the number of values that have been submitted for the request.
     * @param _queryId the id to look up
     * @return uint256 count of the number of values received for the id
     */
    function getNewValueCountbyQueryId(bytes32 _queryId)
        public
        view
        returns (uint256)
    {
        return reports[_queryId].timestamps.length;
    }

    /**
     * @dev Returns the pending staking reward for a given address
     * @param _stakerAddress staker address to look up
     * @return _pendingReward - pending reward for given staker
     */
    function getPendingRewardByStaker(address _stakerAddress)
        external
        returns (uint256 _pendingReward)
    {
        StakeInfo storage _staker = stakerDetails[_stakerAddress];
        _pendingReward = (_staker.stakedBalance *
            _getUpdatedAccumulatedRewardPerShare()) /
            1e18 -
            _staker.rewardDebt;
        (bool _success, bytes memory _returnData) = governance.call(
            abi.encodeWithSignature("getVoteCount()")
        );
        uint256 _numberOfVotes;
        if (_success) {
                _numberOfVotes = uint256(abi.decode(_returnData, (uint256))) - _staker.startVoteCount;
        }
        if (_numberOfVotes > 0) {
                (_success,_returnData) = governance.call(
                    abi.encodeWithSignature("getVoteTallyByAddress(address)",_stakerAddress)
                );
                if(_success){
                    _pendingReward =
                        (_pendingReward * (abi.decode(_returnData,(uint256)) - _staker.startVoteTally)) 
                        / _numberOfVotes;
                }
        }
    }

    /**
     * @dev Returns the real staking rewards balance after accounting for unclaimed rewards
     * @return uint256 real staking rewards balance
     */
    function getRealStakingRewardsBalance() external view returns (uint256) {
        uint256 _pendingRewards = (_getUpdatedAccumulatedRewardPerShare() *
            totalStakeAmount) /
            1e18 -
            totalRewardDebt;
        return (stakingRewardsBalance - _pendingRewards);
    }

    /**
     * @dev Returns reporter address and whether a value was removed for a given queryId and timestamp
     * @param _queryId the id to look up
     * @param _timestamp is the timestamp of the value to look up
     * @return address reporter who submitted the value
     * @return bool true if the value was removed
     */
    function getReportDetails(bytes32 _queryId, uint256 _timestamp)
        external
        view
        returns (address, bool)
    {
        return (reports[_queryId].reporterByTimestamp[_timestamp], reports[_queryId].isDisputed[_timestamp]);
    }

    /**
     * @dev Returns the address of the reporter who submitted a value for a data ID at a specific time
     * @param _queryId is ID of the specific data feed
     * @param _timestamp is the timestamp to find a corresponding reporter for
     * @return address of the reporter who reported the value for the data ID at the given timestamp
     */
    function getReporterByTimestamp(bytes32 _queryId, uint256 _timestamp)
        external
        view
        returns (address)
    {
        return reports[_queryId].reporterByTimestamp[_timestamp];
    }

    /**
     * @dev Returns the timestamp of the reporter's last submission
     * @param _reporter is address of the reporter
     * @return uint256 timestamp of the reporter's last submission
     */
    function getReporterLastTimestamp(address _reporter)
        external
        view
        returns (uint256)
    {
        return stakerDetails[_reporter].reporterLastTimestamp;
    }

    /**
     * @dev Returns the reporting lock time, the amount of time a reporter must wait to submit again
     * @return uint256 reporting lock time
     */
    function getReportingLock() external view returns (uint256) {
        return reportingLock;
    }

    /**
     * @dev Returns the number of values submitted by a specific reporter address
     * @param _reporter is the address of a reporter
     * @return uint256 the number of values submitted by the given reporter
     */
    function getReportsSubmittedByAddress(address _reporter)
        external
        view
        returns (uint256)
    {
        return stakerDetails[_reporter].reportsSubmitted;
    }

    /**
     * @dev Returns the number of values submitted to a specific queryId by a specific reporter address
     * @param _reporter is the address of a reporter
     * @param _queryId is the ID of the specific data feed
     * @return uint256 the number of values submitted by the given reporter to the given queryId
     */
    function getReportsSubmittedByAddressAndQueryId(
        address _reporter,
        bytes32 _queryId
    ) external view returns (uint256) {
        return stakerDetails[_reporter].reportsSubmittedByQueryId[_queryId];
    }

    /**
     * @dev Returns amount required to report oracle values
     * @return uint256 stake amount
     */
    function getStakeAmount() external view returns (uint256) {
        return stakeAmount;
    }

    /**
     * @dev Returns all information about a staker
     * @param _stakerAddress address of staker inquiring about
     * @return uint startDate of staking
     * @return uint current amount staked
     * @return uint current amount locked for withdrawal
     * @return uint reward debt used to calculate staking rewards
     * @return uint reporter's last reported timestamp
     * @return uint total number of reports submitted by reporter
     * @return uint governance vote count when first staked
     * @return uint number of votes cast by staker when first staked
     * @return bool whether staker is counted in totalStakers
     */
    function getStakerInfo(address _stakerAddress)
        external
        view
        returns (
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            uint256,
            bool
        )
    {
        StakeInfo storage _staker = stakerDetails[_stakerAddress];
        return (
            _staker.startDate,
            _staker.stakedBalance,
            _staker.lockedBalance,
            _staker.rewardDebt,
            _staker.reporterLastTimestamp,
            _staker.reportsSubmitted,
            _staker.startVoteCount,
            _staker.startVoteTally,
            _staker.staked
        );
    }

    /**
     * @dev Returns the timestamp for the last value of any ID from the oracle
     * @return uint256 timestamp of the last oracle value
     */
    function getTimeOfLastNewValue() external view returns (uint256) {
        return timeOfLastNewValue;
    }

    /**
     * @dev Gets the timestamp for the value based on their index
     * @param _queryId is the id to look up
     * @param _index is the value index to look up
     * @return uint256 timestamp
     */
    function getTimestampbyQueryIdandIndex(bytes32 _queryId, uint256 _index)
        public
        view
        returns (uint256)
    {
        return reports[_queryId].timestamps[_index];
    }

    /**
     * @dev Retrieves latest array index of data before the specified timestamp for the queryId
     * @param _queryId is the queryId to look up the index for
     * @param _timestamp is the timestamp before which to search for the latest index
     * @return _found whether the index was found
     * @return _index the latest index found before the specified timestamp
     */
    // slither-disable-next-line calls-loop
    function getIndexForDataBefore(bytes32 _queryId, uint256 _timestamp)
        public
        view
        returns (bool _found, uint256 _index)
    {
        uint256 _count = getNewValueCountbyQueryId(_queryId);
        if (_count > 0) {
            uint256 _middle;
            uint256 _start = 0;
            uint256 _end = _count - 1;
            uint256 _time;
            //Checking Boundaries to short-circuit the algorithm
            _time = getTimestampbyQueryIdandIndex(_queryId, _start);
            if (_time >= _timestamp) return (false, 0);
            _time = getTimestampbyQueryIdandIndex(_queryId, _end);
            if (_time < _timestamp) {
                while(isInDispute(_queryId, _time) && _end > 0) {
                    _end--;
                    _time = getTimestampbyQueryIdandIndex(_queryId, _end);
                }
                if(_end == 0 && isInDispute(_queryId, _time)) {
                    return (false, 0);
                }
                return (true, _end);
            }
            //Since the value is within our boundaries, do a binary search
            while (true) {
                _middle = (_end - _start) / 2 + 1 + _start;
                _time = getTimestampbyQueryIdandIndex(_queryId, _middle);
                if (_time < _timestamp) {
                    //get immediate next value
                    uint256 _nextTime = getTimestampbyQueryIdandIndex(
                        _queryId,
                        _middle + 1
                    );
                    if (_nextTime >= _timestamp) {
                        if(!isInDispute(_queryId, _time)) {
                            // _time is correct
                            return (true, _middle);
                        } else {
                            // iterate backwards until we find a non-disputed value
                            while(isInDispute(_queryId, _time) && _middle > 0) {
                                _middle--;
                                _time = getTimestampbyQueryIdandIndex(_queryId, _middle);
                            }
                            if(_middle == 0 && isInDispute(_queryId, _time)) {
                                return (false, 0);
                            }
                            // _time is correct
                            return (true, _middle);
                        }
                    } else {
                        //look from middle + 1(next value) to end
                        _start = _middle + 1;
                    }
                } else {
                    uint256 _prevTime = getTimestampbyQueryIdandIndex(
                        _queryId,
                        _middle - 1
                    );
                    if (_prevTime < _timestamp) {
                        if(!isInDispute(_queryId, _prevTime)) {
                            // _prevTime is correct
                            return (true, _middle - 1);
                        } else {
                            // iterate backwards until we find a non-disputed value
                            _middle--;
                            while(isInDispute(_queryId, _prevTime) && _middle > 0) {
                                _middle--;
                                _prevTime = getTimestampbyQueryIdandIndex(
                                    _queryId,
                                    _middle
                                );
                            }
                            if(_middle == 0 && isInDispute(_queryId, _prevTime)) {
                                return (false, 0);
                            }
                            // _prevtime is correct
                            return (true, _middle);
                        }
                    } else {
                        //look from start to middle -1(prev value)
                        _end = _middle - 1;
                    }
                }
            }
        }
        return (false, 0);
    }

    /**
     * @dev Returns the index of a reporter timestamp in the timestamp array for a specific data ID
     * @param _queryId is ID of the specific data feed
     * @param _timestamp is the timestamp to find in the timestamps array
     * @return uint256 of the index of the reporter timestamp in the array for specific ID
     */
    function getTimestampIndexByTimestamp(bytes32 _queryId, uint256 _timestamp)
        external
        view
        returns (uint256)
    {
        return reports[_queryId].timestampIndex[_timestamp];
    }

    /**
     * @dev Returns the address of the token used for staking
     * @return address of the token used for staking
     */
    function getTokenAddress() external view returns (address) {
        return address(token);
    }

    /**
     * @dev Returns total amount of token staked for reporting
     * @return uint256 total amount of token staked
     */
    function getTotalStakeAmount() external view returns (uint256) {
        return totalStakeAmount;
    }

    /**
     * @dev Returns total number of current stakers. Reporters with stakedBalance less than stakeAmount are excluded from this total
     * @return uint256 total stakers
     */
    function getTotalStakers() external view returns (uint256) {
        return totalStakers;
    }

    /**
     * @dev Returns total balance of time based rewards in contract
     * @return uint256 amount of trb
     */
    function getTotalTimeBasedRewardsBalance() external view returns (uint256) {
        return token.balanceOf(address(this)) - (totalStakeAmount + stakingRewardsBalance);
    }

    /**
     * @dev Returns whether a given value is disputed
     * @param _queryId unique ID of the data feed
     * @param _timestamp timestamp of the value
     * @return bool whether the value is disputed
     */
    function isInDispute(bytes32 _queryId, uint256 _timestamp)
        public
        view
        returns (bool)
    {
        return reports[_queryId].isDisputed[_timestamp];
    }

    /**
     * @dev Retrieve value from oracle based on timestamp
     * @param _queryId being requested
     * @param _timestamp to retrieve data/value from
     * @return bytes value for timestamp submitted
     */
    function retrieveData(bytes32 _queryId, uint256 _timestamp)
        public
        view
        returns (bytes memory)
    {
        return reports[_queryId].valueByTimestamp[_timestamp];
    }

    /**
     * @dev Used during the upgrade process to verify valid Tellor contracts
     * @return bool value used to verify valid Tellor contracts
     */
    function verify() external pure returns (uint256) {
        return 9999;
    }

    // *****************************************************************************
    // *                                                                           *
    // *                          Internal functions                               *
    // *                                                                           *
    // *****************************************************************************

    /**
     * @dev Updates accumulated staking rewards per staked token
     */
    function _updateRewards() internal {
        if (timeOfLastAllocation == block.timestamp) {
            return;
        }
        if (totalStakeAmount == 0 || rewardRate == 0) {
            timeOfLastAllocation = block.timestamp;
            return;
        }
        // calculate accumulated reward per token staked
        uint256 _newAccumulatedRewardPerShare = accumulatedRewardPerShare +
            ((block.timestamp - timeOfLastAllocation) * rewardRate * 1e18) /
            totalStakeAmount;
        // calculate accumulated reward with _newAccumulatedRewardPerShare
        uint256 _accumulatedReward = (_newAccumulatedRewardPerShare *
            totalStakeAmount) /
            1e18 -
            totalRewardDebt;
        if (_accumulatedReward >= stakingRewardsBalance) {
            // if staking rewards run out, calculate remaining reward per staked
            // token and set rewardRate to 0
            uint256 _newPendingRewards = stakingRewardsBalance -
                ((accumulatedRewardPerShare * totalStakeAmount) /
                    1e18 -
                    totalRewardDebt);
            accumulatedRewardPerShare +=
                (_newPendingRewards * 1e18) /
                totalStakeAmount;
            rewardRate = 0;
        } else {
            accumulatedRewardPerShare = _newAccumulatedRewardPerShare;
        }
        timeOfLastAllocation = block.timestamp;
    }

    /**
     * @dev Called whenever a user's stake amount changes. First updates staking rewards,
     * transfers pending rewards to user's address, and finally updates user's stake amount
     * and other relevant variables.
     * @param _stakerAddress address of user whose stake is being updated
     * @param _newStakedBalance new staked balance of user
     */
    function _updateStakeAndPayRewards(
        address _stakerAddress,
        uint256 _newStakedBalance
    ) internal {
        _updateRewards();
        StakeInfo storage _staker = stakerDetails[_stakerAddress];
        if (_staker.stakedBalance > 0) {
            // if address already has a staked balance, calculate and transfer pending rewards
            uint256 _pendingReward = (_staker.stakedBalance *
                accumulatedRewardPerShare) /
                1e18 -
                _staker.rewardDebt;
            // get staker voting participation rate
            uint256 _numberOfVotes;
            (bool _success, bytes memory _returnData) = governance.call(
                abi.encodeWithSignature("getVoteCount()")
            );
            if (_success) {
                _numberOfVotes =
                    uint256(abi.decode(_returnData, (uint256))) -
                    _staker.startVoteCount;
            }
            if (_numberOfVotes > 0) {
                // staking reward = pending reward * voting participation rate
                (_success, _returnData) = governance.call(
                    abi.encodeWithSignature("getVoteTallyByAddress(address)",_stakerAddress)
                );
                if(_success){
                    uint256 _voteTally = abi.decode(_returnData,(uint256));
                    uint256 _tempPendingReward =
                        (_pendingReward *
                            (_voteTally - _staker.startVoteTally)) /
                        _numberOfVotes;
                    if (_tempPendingReward < _pendingReward) {
                        _pendingReward = _tempPendingReward;
                    }
                }
            }
            stakingRewardsBalance -= _pendingReward;
            require(token.transfer(msg.sender, _pendingReward));
            totalRewardDebt -= _staker.rewardDebt;
            totalStakeAmount -= _staker.stakedBalance;
        }
        _staker.stakedBalance = _newStakedBalance;
        // Update total stakers
        if (_staker.stakedBalance >= stakeAmount) {
            if (_staker.staked == false) {
                totalStakers++;
            }
            _staker.staked = true;
        } else {
            if (_staker.staked == true && totalStakers > 0) {
                totalStakers--;
            }
            _staker.staked = false;
        }
        // tracks rewards accumulated before stake amount updated
        _staker.rewardDebt =
            (_staker.stakedBalance * accumulatedRewardPerShare) /
            1e18;
        totalRewardDebt += _staker.rewardDebt;
        totalStakeAmount += _staker.stakedBalance;
        // update reward rate if staking rewards are available 
        // given staker's updated parameters
        if(rewardRate == 0) {
            rewardRate =
            (stakingRewardsBalance -
                ((accumulatedRewardPerShare * totalStakeAmount) /
                    1e18 -
                    totalRewardDebt)) /
            30 days;
        }
    }

    /**
     * @dev Internal function retrieves updated accumulatedRewardPerShare
     * @return uint256 up-to-date accumulated reward per share
     */
    function _getUpdatedAccumulatedRewardPerShare()
        internal
        view
        returns (uint256)
    {
        if (totalStakeAmount == 0) {
            return accumulatedRewardPerShare;
        }
        uint256 _newAccumulatedRewardPerShare = accumulatedRewardPerShare +
            ((block.timestamp - timeOfLastAllocation) * rewardRate * 1e18) /
            totalStakeAmount;
        uint256 _accumulatedReward = (_newAccumulatedRewardPerShare *
            totalStakeAmount) /
            1e18 -
            totalRewardDebt;
        if (_accumulatedReward >= stakingRewardsBalance) {
            uint256 _newPendingRewards = stakingRewardsBalance -
                ((accumulatedRewardPerShare * totalStakeAmount) /
                    1e18 -
                    totalRewardDebt);
            _newAccumulatedRewardPerShare =
                accumulatedRewardPerShare +
                (_newPendingRewards * 1e18) /
                totalStakeAmount;
        }
        return _newAccumulatedRewardPerShare;
    }
}


// File contracts/testing/GovernanceMock.sol

// SPDX-License-Identifier: MIT
pragma solidity 0.8.3;

contract GovernanceMock {
    TellorFlex public tellor;
    uint256 public voteCount; // total number of votes initiated
    mapping(address => uint256) private voteTallyByAddress; // mapping of addresses to the number of votes they have cast
    mapping(address => mapping(uint256 => bool)) private voted; // mapping of addresses to mapping of voteIds to whether they have voted

    function setTellorAddress(address _tellor) public {
        tellor = TellorFlex(_tellor);
    }

    function beginDisputeMock() public {
        voteCount++;
    }

    function voteMock(uint256 _disputeId) public {
        require(_disputeId > 0, "Dispute ID must be greater than 0");
        require(_disputeId <= voteCount, "Vote does not exist");
        require(!voted[msg.sender][_disputeId], "Address already voted");
        voteTallyByAddress[msg.sender]++;
        voted[msg.sender][_disputeId] = true;
    }

    function getVoteTallyByAddress(address _voter) public view returns (uint256) {
        return voteTallyByAddress[_voter];
    }

    function getVoteCount() public view returns (uint256) {
        return voteCount;
    }

    fallback() external payable {}
    receive() external payable {}

}


// File @openzeppelin/contracts/token/ERC20/IERC20.sol@v4.7.3

// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v4.6.0) (token/ERC20/IERC20.sol)

pragma solidity ^0.8.0;

/**
 * @dev Interface of the ERC20 standard as defined in the EIP.
 */
interface IERC20 {
    /**
     * @dev Emitted when `value` tokens are moved from one account (`from`) to
     * another (`to`).
     *
     * Note that `value` may be zero.
     */
    event Transfer(address indexed from, address indexed to, uint256 value);

    /**
     * @dev Emitted when the allowance of a `spender` for an `owner` is set by
     * a call to {approve}. `value` is the new allowance.
     */
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /**
     * @dev Returns the amount of tokens in existence.
     */
    function totalSupply() external view returns (uint256);

    /**
     * @dev Returns the amount of tokens owned by `account`.
     */
    function balanceOf(address account) external view returns (uint256);

    /**
     * @dev Moves `amount` tokens from the caller's account to `to`.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * Emits a {Transfer} event.
     */
    function transfer(address to, uint256 amount) external returns (bool);

    /**
     * @dev Returns the remaining number of tokens that `spender` will be
     * allowed to spend on behalf of `owner` through {transferFrom}. This is
     * zero by default.
     *
     * This value changes when {approve} or {transferFrom} are called.
     */
    function allowance(address owner, address spender) external view returns (uint256);

    /**
     * @dev Sets `amount` as the allowance of `spender` over the caller's tokens.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * IMPORTANT: Beware that changing an allowance with this method brings the risk
     * that someone may use both the old and the new allowance by unfortunate
     * transaction ordering. One possible solution to mitigate this race
     * condition is to first reduce the spender's allowance to 0 and set the
     * desired value afterwards:
     * https://github.com/ethereum/EIPs/issues/20#issuecomment-263524729
     *
     * Emits an {Approval} event.
     */
    function approve(address spender, uint256 amount) external returns (bool);

    /**
     * @dev Moves `amount` tokens from `from` to `to` using the
     * allowance mechanism. `amount` is then deducted from the caller's
     * allowance.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * Emits a {Transfer} event.
     */
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
}


// File @openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol@v4.7.3

// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts v4.4.1 (token/ERC20/extensions/IERC20Metadata.sol)

pragma solidity ^0.8.0;

/**
 * @dev Interface for the optional metadata functions from the ERC20 standard.
 *
 * _Available since v4.1._
 */
interface IERC20Metadata is IERC20 {
    /**
     * @dev Returns the name of the token.
     */
    function name() external view returns (string memory);

    /**
     * @dev Returns the symbol of the token.
     */
    function symbol() external view returns (string memory);

    /**
     * @dev Returns the decimals places of the token.
     */
    function decimals() external view returns (uint8);
}


// File @openzeppelin/contracts/utils/Context.sol@v4.7.3

// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts v4.4.1 (utils/Context.sol)

pragma solidity ^0.8.0;

/**
 * @dev Provides information about the current execution context, including the
 * sender of the transaction and its data. While these are generally available
 * via msg.sender and msg.data, they should not be accessed in such a direct
 * manner, since when dealing with meta-transactions the account sending and
 * paying for execution may not be the actual sender (as far as an application
 * is concerned).
 *
 * This contract is only required for intermediate, library-like contracts.
 */
abstract contract Context {
    function _msgSender() internal view virtual returns (address) {
        return msg.sender;
    }

    function _msgData() internal view virtual returns (bytes calldata) {
        return msg.data;
    }
}


// File @openzeppelin/contracts/token/ERC20/ERC20.sol@v4.7.3

// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v4.7.0) (token/ERC20/ERC20.sol)

pragma solidity ^0.8.0;



/**
 * @dev Implementation of the {IERC20} interface.
 *
 * This implementation is agnostic to the way tokens are created. This means
 * that a supply mechanism has to be added in a derived contract using {_mint}.
 * For a generic mechanism see {ERC20PresetMinterPauser}.
 *
 * TIP: For a detailed writeup see our guide
 * https://forum.zeppelin.solutions/t/how-to-implement-erc20-supply-mechanisms/226[How
 * to implement supply mechanisms].
 *
 * We have followed general OpenZeppelin Contracts guidelines: functions revert
 * instead returning `false` on failure. This behavior is nonetheless
 * conventional and does not conflict with the expectations of ERC20
 * applications.
 *
 * Additionally, an {Approval} event is emitted on calls to {transferFrom}.
 * This allows applications to reconstruct the allowance for all accounts just
 * by listening to said events. Other implementations of the EIP may not emit
 * these events, as it isn't required by the specification.
 *
 * Finally, the non-standard {decreaseAllowance} and {increaseAllowance}
 * functions have been added to mitigate the well-known issues around setting
 * allowances. See {IERC20-approve}.
 */
contract ERC20 is Context, IERC20, IERC20Metadata {
    mapping(address => uint256) private _balances;

    mapping(address => mapping(address => uint256)) private _allowances;

    uint256 private _totalSupply;

    string private _name;
    string private _symbol;

    /**
     * @dev Sets the values for {name} and {symbol}.
     *
     * The default value of {decimals} is 18. To select a different value for
     * {decimals} you should overload it.
     *
     * All two of these values are immutable: they can only be set once during
     * construction.
     */
    constructor(string memory name_, string memory symbol_) {
        _name = name_;
        _symbol = symbol_;
    }

    /**
     * @dev Returns the name of the token.
     */
    function name() public view virtual override returns (string memory) {
        return _name;
    }

    /**
     * @dev Returns the symbol of the token, usually a shorter version of the
     * name.
     */
    function symbol() public view virtual override returns (string memory) {
        return _symbol;
    }

    /**
     * @dev Returns the number of decimals used to get its user representation.
     * For example, if `decimals` equals `2`, a balance of `505` tokens should
     * be displayed to a user as `5.05` (`505 / 10 ** 2`).
     *
     * Tokens usually opt for a value of 18, imitating the relationship between
     * Ether and Wei. This is the value {ERC20} uses, unless this function is
     * overridden;
     *
     * NOTE: This information is only used for _display_ purposes: it in
     * no way affects any of the arithmetic of the contract, including
     * {IERC20-balanceOf} and {IERC20-transfer}.
     */
    function decimals() public view virtual override returns (uint8) {
        return 18;
    }

    /**
     * @dev See {IERC20-totalSupply}.
     */
    function totalSupply() public view virtual override returns (uint256) {
        return _totalSupply;
    }

    /**
     * @dev See {IERC20-balanceOf}.
     */
    function balanceOf(address account) public view virtual override returns (uint256) {
        return _balances[account];
    }

    /**
     * @dev See {IERC20-transfer}.
     *
     * Requirements:
     *
     * - `to` cannot be the zero address.
     * - the caller must have a balance of at least `amount`.
     */
    function transfer(address to, uint256 amount) public virtual override returns (bool) {
        address owner = _msgSender();
        _transfer(owner, to, amount);
        return true;
    }

    /**
     * @dev See {IERC20-allowance}.
     */
    function allowance(address owner, address spender) public view virtual override returns (uint256) {
        return _allowances[owner][spender];
    }

    /**
     * @dev See {IERC20-approve}.
     *
     * NOTE: If `amount` is the maximum `uint256`, the allowance is not updated on
     * `transferFrom`. This is semantically equivalent to an infinite approval.
     *
     * Requirements:
     *
     * - `spender` cannot be the zero address.
     */
    function approve(address spender, uint256 amount) public virtual override returns (bool) {
        address owner = _msgSender();
        _approve(owner, spender, amount);
        return true;
    }

    /**
     * @dev See {IERC20-transferFrom}.
     *
     * Emits an {Approval} event indicating the updated allowance. This is not
     * required by the EIP. See the note at the beginning of {ERC20}.
     *
     * NOTE: Does not update the allowance if the current allowance
     * is the maximum `uint256`.
     *
     * Requirements:
     *
     * - `from` and `to` cannot be the zero address.
     * - `from` must have a balance of at least `amount`.
     * - the caller must have allowance for ``from``'s tokens of at least
     * `amount`.
     */
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) public virtual override returns (bool) {
        address spender = _msgSender();
        _spendAllowance(from, spender, amount);
        _transfer(from, to, amount);
        return true;
    }

    /**
     * @dev Atomically increases the allowance granted to `spender` by the caller.
     *
     * This is an alternative to {approve} that can be used as a mitigation for
     * problems described in {IERC20-approve}.
     *
     * Emits an {Approval} event indicating the updated allowance.
     *
     * Requirements:
     *
     * - `spender` cannot be the zero address.
     */
    function increaseAllowance(address spender, uint256 addedValue) public virtual returns (bool) {
        address owner = _msgSender();
        _approve(owner, spender, allowance(owner, spender) + addedValue);
        return true;
    }

    /**
     * @dev Atomically decreases the allowance granted to `spender` by the caller.
     *
     * This is an alternative to {approve} that can be used as a mitigation for
     * problems described in {IERC20-approve}.
     *
     * Emits an {Approval} event indicating the updated allowance.
     *
     * Requirements:
     *
     * - `spender` cannot be the zero address.
     * - `spender` must have allowance for the caller of at least
     * `subtractedValue`.
     */
    function decreaseAllowance(address spender, uint256 subtractedValue) public virtual returns (bool) {
        address owner = _msgSender();
        uint256 currentAllowance = allowance(owner, spender);
        require(currentAllowance >= subtractedValue, "ERC20: decreased allowance below zero");
        unchecked {
            _approve(owner, spender, currentAllowance - subtractedValue);
        }

        return true;
    }

    /**
     * @dev Moves `amount` of tokens from `from` to `to`.
     *
     * This internal function is equivalent to {transfer}, and can be used to
     * e.g. implement automatic token fees, slashing mechanisms, etc.
     *
     * Emits a {Transfer} event.
     *
     * Requirements:
     *
     * - `from` cannot be the zero address.
     * - `to` cannot be the zero address.
     * - `from` must have a balance of at least `amount`.
     */
    function _transfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual {
        require(from != address(0), "ERC20: transfer from the zero address");
        require(to != address(0), "ERC20: transfer to the zero address");

        _beforeTokenTransfer(from, to, amount);

        uint256 fromBalance = _balances[from];
        require(fromBalance >= amount, "ERC20: transfer amount exceeds balance");
        unchecked {
            _balances[from] = fromBalance - amount;
        }
        _balances[to] += amount;

        emit Transfer(from, to, amount);

        _afterTokenTransfer(from, to, amount);
    }

    /** @dev Creates `amount` tokens and assigns them to `account`, increasing
     * the total supply.
     *
     * Emits a {Transfer} event with `from` set to the zero address.
     *
     * Requirements:
     *
     * - `account` cannot be the zero address.
     */
    function _mint(address account, uint256 amount) internal virtual {
        require(account != address(0), "ERC20: mint to the zero address");

        _beforeTokenTransfer(address(0), account, amount);

        _totalSupply += amount;
        _balances[account] += amount;
        emit Transfer(address(0), account, amount);

        _afterTokenTransfer(address(0), account, amount);
    }

    /**
     * @dev Destroys `amount` tokens from `account`, reducing the
     * total supply.
     *
     * Emits a {Transfer} event with `to` set to the zero address.
     *
     * Requirements:
     *
     * - `account` cannot be the zero address.
     * - `account` must have at least `amount` tokens.
     */
    function _burn(address account, uint256 amount) internal virtual {
        require(account != address(0), "ERC20: burn from the zero address");

        _beforeTokenTransfer(account, address(0), amount);

        uint256 accountBalance = _balances[account];
        require(accountBalance >= amount, "ERC20: burn amount exceeds balance");
        unchecked {
            _balances[account] = accountBalance - amount;
        }
        _totalSupply -= amount;

        emit Transfer(account, address(0), amount);

        _afterTokenTransfer(account, address(0), amount);
    }

    /**
     * @dev Sets `amount` as the allowance of `spender` over the `owner` s tokens.
     *
     * This internal function is equivalent to `approve`, and can be used to
     * e.g. set automatic allowances for certain subsystems, etc.
     *
     * Emits an {Approval} event.
     *
     * Requirements:
     *
     * - `owner` cannot be the zero address.
     * - `spender` cannot be the zero address.
     */
    function _approve(
        address owner,
        address spender,
        uint256 amount
    ) internal virtual {
        require(owner != address(0), "ERC20: approve from the zero address");
        require(spender != address(0), "ERC20: approve to the zero address");

        _allowances[owner][spender] = amount;
        emit Approval(owner, spender, amount);
    }

    /**
     * @dev Updates `owner` s allowance for `spender` based on spent `amount`.
     *
     * Does not update the allowance amount in case of infinite allowance.
     * Revert if not enough allowance is available.
     *
     * Might emit an {Approval} event.
     */
    function _spendAllowance(
        address owner,
        address spender,
        uint256 amount
    ) internal virtual {
        uint256 currentAllowance = allowance(owner, spender);
        if (currentAllowance != type(uint256).max) {
            require(currentAllowance >= amount, "ERC20: insufficient allowance");
            unchecked {
                _approve(owner, spender, currentAllowance - amount);
            }
        }
    }

    /**
     * @dev Hook that is called before any transfer of tokens. This includes
     * minting and burning.
     *
     * Calling conditions:
     *
     * - when `from` and `to` are both non-zero, `amount` of ``from``'s tokens
     * will be transferred to `to`.
     * - when `from` is zero, `amount` tokens will be minted for `to`.
     * - when `to` is zero, `amount` of ``from``'s tokens will be burned.
     * - `from` and `to` are never both zero.
     *
     * To learn more about hooks, head to xref:ROOT:extending-contracts.adoc#using-hooks[Using Hooks].
     */
    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual {}

    /**
     * @dev Hook that is called after any transfer of tokens. This includes
     * minting and burning.
     *
     * Calling conditions:
     *
     * - when `from` and `to` are both non-zero, `amount` of ``from``'s tokens
     * has been transferred to `to`.
     * - when `from` is zero, `amount` tokens have been minted for `to`.
     * - when `to` is zero, `amount` of ``from``'s tokens have been burned.
     * - `from` and `to` are never both zero.
     *
     * To learn more about hooks, head to xref:ROOT:extending-contracts.adoc#using-hooks[Using Hooks].
     */
    function _afterTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal virtual {}
}


// File contracts/testing/StakingToken.sol

// SPDX-License-Identifier: MIT
pragma solidity 0.8.3;

contract StakingToken is ERC20 {

  constructor() ERC20("Test Tellor Tribute", "TTRB") {}

  function mint(address _to, uint256 _amount) public {
    _mint(_to, _amount);
  }

}


// File contracts/testing/TestFlex.sol

// SPDX-License-Identifier: MIT
pragma solidity 0.8.3;

contract TestFlex is TellorFlex {
    constructor(
        address _token,
        uint256 _reportingLock,
        uint256 _stakeAmountDollarTarget,
        uint256 _stakingTokenPrice,
        uint256 _minimumStakeAmount,
        bytes32 _stakingTokenPriceQueryId
    ) TellorFlex(_token, _reportingLock, _stakeAmountDollarTarget, _stakingTokenPrice, _minimumStakeAmount, _stakingTokenPriceQueryId) {}

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

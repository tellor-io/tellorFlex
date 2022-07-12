// SPDX-License-Identifier: MIT
pragma solidity 0.8.3;

import "./interfaces/IERC20.sol";
import "./interfaces/IGovernance.sol";

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
    IERC20  public token;
    address public owner;
    address public governance;
    uint256 public timeBasedReward = 5e17; // amount of tokens to be issued every 5 minutes
    uint256 public stakeAmount; //amount required to be a staker
    uint256 public stakeAmountDollarTarget; // amount of US dollars required to be a staker
    bytes32 public stakingTokenPriceQueryId; // staking token SpotPrice queryId
    uint256 public totalStakeAmount; //total amount of tokens locked in contract (via stake)
    uint256 public reportingLock; // base amount of time before a reporter is able to submit a value again
    uint256 public timeOfLastNewValue = block.timestamp; // time of the last new submitted value, originally set to the block timestamp
    uint256 public rewardRate; // reward per staked token
    uint256 public accumulatedRewardPerShare; // accumulated reward per staked token
    uint256 public timeOfLastAllocation;
    uint256 public totalRewardDebt;
    uint256 public stakingRewardsBalance; //amount eligible to be paid out as stakingRewards
    uint256 public totalStakers;

    mapping(bytes32 => Report) private reports; // mapping of query IDs to a report
    mapping(address => StakeInfo) private stakerDetails; //mapping from a persons address to their staking info
    mapping(bytes32 => uint256) private lockedTokenPartitions;

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
        uint256 startDate; //stake start date
        uint256 stakedBalance; // staked balance
        uint256 lockedBalance; // amount locked for withdrawal
        uint256 rewardDebt; // used for reward calculation
        uint256 reporterLastTimestamp; // timestamp of reporter's last reported value
        uint256 reportsSubmitted; // total number of reports submitted by reporter
        uint256 startVoteCount; // total number of governance votes when stake deposited
        uint256 startVoteTally; // staker vote tally when stake deposited
        mapping(bytes32 => uint256) reportsSubmittedByQueryId;
        bool staked; // used to keep track of total stakers
    }

    // Events
    event NewGovernanceAddress(address _newGovernanceAddress);
    event NewReport(
        bytes32 _queryId,
        uint256 _time,
        bytes _value,
        uint256 _nonce,
        bytes _queryData,
        address _reporter
    );
    event NewReportingLock(uint256 _newReportingLock);
    event NewStakeAmount(uint256 _newStakeAmount);
    event NewStaker(address _staker, uint256 _amount);
    event ReporterSlashed(
        address _reporter,
        address _recipient,
        uint256 _slashAmount
    );
    event StakeWithdrawRequested(address _staker, uint256 _amount);
    event StakeWithdrawn(address _staker);
    event ValueRemoved(bytes32 _queryId, uint256 _timestamp);

    // Functions
    /**
     * @dev Initializes system parameters
     * @param _token address of token used for staking
     * @param _reportingLock base amount of time (seconds) before reporter is able to report again
     * @param _stakeAmountDollarTarget fixed amount of dollars that TRB stake amount is worth
     * @param _priceTRB price of TRB in USD
     * @param _stakingTokenPriceQueryId queryId where staking token price is reported
     */
    constructor(
        address _token,
        uint256 _reportingLock,
        uint256 _stakeAmountDollarTarget,
        uint256 _priceTRB,
        bytes32 _stakingTokenPriceQueryId
    ) {
        require(_token != address(0), "must set token address");
        token = IERC20(_token);
        owner = msg.sender;
        reportingLock = _reportingLock;
        stakeAmountDollarTarget = _stakeAmountDollarTarget;
        stakeAmount = (_stakeAmountDollarTarget * 1e18) / _priceTRB;
        stakingTokenPriceQueryId = _stakingTokenPriceQueryId;
    }

    /**
     * @dev Allows the owner to initiaze the governance (flex addy needed for governance deployment)
     * @param _governanceAddress address of governance contract (github.com/tellor-io/governance)
     */
    function init(address _governanceAddress) external {
        require(msg.sender == owner);
        require(governance == address(0));
        require(
            _governanceAddress != address(0),
            "governance address can't be zero address"
        );
        governance = _governanceAddress;
    }

    /**
     * @dev Funds the Flex contract with staking rewards (paid by autopay and minting)
     * @param _amount amount of to fund contract with
     */
    function addStakingRewards(uint256 _amount) external {
        require(token.transferFrom(msg.sender, address(this), _amount));
        _updateRewards();
        stakingRewardsBalance += _amount;
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
        StakeInfo storage _staker = stakerDetails[msg.sender];
        if (_staker.lockedBalance > 0) {
            if (_staker.lockedBalance >= _amount) {
                // if staker's locked balance covers full _amount, use that
                _staker.lockedBalance -= _amount;
            } else {
                require(
                    token.transferFrom(
                        msg.sender,
                        address(this),
                        _amount - _staker.lockedBalance
                    )
                );
                _staker.lockedBalance = 0;
            }
        } else {
            if (_staker.stakedBalance == 0) {
                _staker.startVoteCount = IGovernance(governance).getVoteCount();
                _staker.startVoteTally = IGovernance(governance)
                    .getVoteTallyByAddress(msg.sender);
            }
            require(token.transferFrom(msg.sender, address(this), _amount));
        }
        _updateStakeAndPayRewards(msg.sender, _staker.stakedBalance + _amount);
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
        require(
            _staker.stakedBalance + _staker.lockedBalance > 0,
            "zero staker balance"
        );
        if (_staker.lockedBalance >= stakeAmount) {
            _slashAmount = stakeAmount;
            _staker.lockedBalance -= stakeAmount;
        } else if (
            _staker.lockedBalance + _staker.stakedBalance >= stakeAmount
        ) {
            _slashAmount = stakeAmount;
            _updateStakeAndPayRewards(
                _reporter,
                _staker.stakedBalance - (stakeAmount - _staker.lockedBalance)
            );
            _staker.lockedBalance = 0;
        } else {
            _slashAmount = _staker.stakedBalance + _staker.lockedBalance;
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
            _queryId == keccak256(_queryData) || uint256(_queryId) <= 100,
            "id must be hash of bytes data"
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
        uint256 _timeDiff = block.timestamp - timeOfLastNewValue;
        uint256 _reward = (_timeDiff * timeBasedReward) / 300; //.5 TRB per 5 minutes
        uint256 _totalTimeBasedRewardsBalance =
            token.balanceOf(address(this)) -
            (totalStakeAmount + stakingRewardsBalance);
        if (_reward > 0 && _totalTimeBasedRewardsBalance > 0) {
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

    function updateStakeAmount() external {
        (bool _valFound, bytes memory _val, ) = getDataBefore(
            stakingTokenPriceQueryId,
            block.timestamp - 12 hours
        );
        if (_valFound) {
            uint256 _priceTRB = abi.decode(_val, (uint256));
            require(
                _priceTRB >= 0.01 ether && _priceTRB < 1000000 ether,
                "invalid trb price"
            );
            stakeAmount = (stakeAmountDollarTarget * 1e18) / _priceTRB;
            emit NewStakeAmount(stakeAmount);
        }
    }

    /**
     * @dev Withdraws a reporter's stake
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
     * @return _value bytes memory of the current value of data
     */
    function getCurrentValue(bytes32 _queryId)
        external
        view
        returns (bytes memory _value)
    {
        (,_value,) = getDataBefore(_queryId, block.timestamp);
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
        uint256 _time = getTimestampbyQueryIdandIndex(_queryId, _index);
        _value = retrieveData(_queryId, _time);
        if (_report.isDisputed[_time]){
            for(uint256 _i = _index - 1; _i > 0; _i-- ){
                _time = getTimestampbyQueryIdandIndex(_queryId, _index - _i);
                _value = retrieveData(_queryId, _time);
                if(!_report.isDisputed[_time])){
                    return (true, _value, _time);
                }
            }
            return (false, bytes(""), 0);
        }
        return (true, _value, _time);
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
     * @return uint256 pending reward for given staker
     */
    function getPendingRewardByStaker(address _stakerAddress)
        external
        view
        returns (uint256)
    {
        StakeInfo storage _staker = stakerDetails[_stakerAddress];
        uint256 _pendingReward = (_staker.stakedBalance *
            _getUpdatedAccumulatedRewardPerShare()) /
            1e18 -
            _staker.rewardDebt;
        uint256 _numberOfVotes = IGovernance(governance).getVoteCount() -
            _staker.startVoteCount;
        if (_numberOfVotes > 0) {
            _pendingReward =
                (_pendingReward *
                    (IGovernance(governance).getVoteTallyByAddress(
                        _stakerAddress
                    ) - _staker.startVoteTally)) /
                _numberOfVotes;
        }
        return _pendingReward;
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
        bool _wasRemoved = reports[_queryId].timestampIndex[_timestamp] == 0 &&
            keccak256(reports[_queryId].valueByTimestamp[_timestamp]) ==
            keccak256(bytes("")) &&
            reports[_queryId].reporterByTimestamp[_timestamp] != address(0);
        return (reports[_queryId].reporterByTimestamp[_timestamp], _wasRemoved);
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
     * @return uint256 of the number of values submitted by the given reporter
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
     * @return uint256 of the number of values submitted by the given reporter to the given queryId
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
     * @dev Allows users to retrieve all information about a staker
     * @param _stakerAddress address of staker inquiring about
     * @return uint startDate of staking
     * @return uint current amount staked
     * @return uint current amount locked for withdrawal
     * @return uint reward debt used to calculate staking rewards
     * @return uint reporter's last reported timestamp
     * @return uint total number of reports submitted by reporter
     * @return uint governance vote count when first staked
     * @return uint number of votes cast by staker when first staked
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
            uint256
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
            _staker.startVoteTally
        );
    }

    /**
     * @dev Returns the timestamp for the last value of any ID from the oracle
     * @return uint256 of timestamp of the last oracle value
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
            if (_time < _timestamp) return (true, _end);
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
                        //_time is correct
                        return (true, _middle);
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
                        // _prevtime is correct
                        return (true, _middle - 1);
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
     * @dev Used during the upgrade process to verify valid Tellor Contracts
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
        uint256 _accumulatedReward = (_newAccumulatedRewardPerShare *
            totalStakeAmount) /
            1e18 -
            totalRewardDebt;
        // if staking rewards run out, calculate remaining reward per staked
        // token and set rewardRate to 0
        if (_accumulatedReward >= stakingRewardsBalance) {
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
     */
    function _updateStakeAndPayRewards(
        address _stakerAddress,
        uint256 _newStakedBalance
    ) internal {
        _updateRewards();
        StakeInfo storage _staker = stakerDetails[_stakerAddress];
        if (_staker.stakedBalance > 0) {
            uint256 _pendingReward = (_staker.stakedBalance *
                accumulatedRewardPerShare) /
                1e18 -
                _staker.rewardDebt;
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
                _pendingReward =
                    (_pendingReward *
                        (IGovernance(governance).getVoteTallyByAddress(
                            _stakerAddress
                        ) - _staker.startVoteTally)) /
                    _numberOfVotes;
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

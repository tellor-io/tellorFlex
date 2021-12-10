// SPDX-License-Identifier: MIT
pragma solidity 0.8.3;

import "./interfaces/IERC20.sol";

/**
 @author Tellor Inc.
 @title TellorFlex
 @dev This is a streamlined Tellor oracle system which handles staking, reporting,
 * slashing, and user data getters in one contract. This contract is controlled
 * by a single address known as 'governance', which could be an externally owned
 * account or a contract, allowing for a flexible, modular design.
*/
contract TellorFlex {
    IERC20 public token;
    address public governance;
    uint256 public stakeAmount;
    uint256 public totalStakeAmount;
    uint256 public reportingLock; // base amount of time before a reporter is able to submit a value again
    uint256 public timeOfLastNewValue = block.timestamp; // time of the last new submitted value, originally set to the block timestamp
    mapping(bytes32 => Report) private reports; // mapping of query IDs to a report
    mapping(address => uint256) private reportsSubmittedByAddress; // mapping of reporter addresses to the number of reports they've submitted
    mapping(bytes32 => uint256[]) public timestamps;
    mapping(bytes32 => mapping(uint256 => bytes)) public values; //queryId -> timestamp -> value
    mapping(address => StakeInfo) stakerDetails; //mapping from a persons address to their staking info
    mapping(address => uint256) private reporterLastTimestamp; // mapping of reporter addresses to the timestamp of their last reported value
    mapping(address => mapping(bytes32 => uint256))
        public reportsSubmittedByAddressAndQueryId;

    // Structs
    struct Report {
        uint256[] timestamps; // array of all newValueTimestamps reported
        mapping(uint256 => uint256) timestampIndex; // mapping of timestamps to respective indices
        mapping(uint256 => uint256) timestampToBlockNum; // mapping of timestamp to block number
        mapping(uint256 => bytes) valueByTimestamp; // mapping of timestamps to values
        mapping(uint256 => address) reporterByTimestamp; // mapping of timestamps to reporters
    }

    struct StakeInfo {
        uint256 startDate; //stake start date
        uint256 balance; // staked balance
        uint256 lockedAmount; // amount locked for withdrawal
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
    event NewStaker(address _staker);
    event ReporterSlashed(
        address _reporter,
        address _recipient,
        uint256 _slashAmount
    );
    event StakeWithdrawRequested(address _staker, uint256 _amount);
    event StakeWithdrawn(address _staker);
    event ValueRemoved(bytes32 _queryId, uint256 _timestamp);

    /**
     * @dev Initializes system parameters
     * @param _token address of token used for staking
     * @param _governance address which controls system
     * @param _stakeAmount amount of token needed to report oracle values
     * @param _reportingLock base amount of time (seconds) before reporter is able to report again
     */
    constructor(
        address _token,
        address _governance,
        uint256 _stakeAmount,
        uint256 _reportingLock
    ) {
        token = IERC20(_token);
        governance = _governance;
        stakeAmount = _stakeAmount;
        reportingLock = _reportingLock;
    }

    /**
     * @dev Changes governance address
     * @param _newGovernanceAddress new governance address
     */
    function changeGovernanceAddress(address _newGovernanceAddress) external {
        require(msg.sender == governance, "caller must be governance address");
        governance = _newGovernanceAddress;
        emit NewGovernanceAddress(_newGovernanceAddress);
    }

    /**
     * @dev Changes base amount of time (seconds) before reporter is allowed to report again
     * @param _newReportingLock new reporter lock time in seconds
     */
    function changeReportingLock(uint256 _newReportingLock) external {
        require(msg.sender == governance, "caller must be governance address");
        reportingLock = _newReportingLock;
        emit NewReportingLock(_newReportingLock);
    }

    /**
     * @dev Changes amount of token stake required to report values
     * @param _newStakeAmount new reporter stake amount
     */
    function changeStakeAmount(uint256 _newStakeAmount) external {
        require(msg.sender == governance, "caller must be governance address");
        stakeAmount = _newStakeAmount;
        emit NewStakeAmount(_newStakeAmount);
    }

    /**
     * @dev Allows a reporter to submit stake
     */
    function depositStake() external {
        // transfer stakeAmount from staker to here?

        StakeInfo storage _staker = stakerDetails[msg.sender];
        if (_staker.lockedAmount >= stakeAmount) {
            _staker.lockedAmount -= stakeAmount;
        } else {
            require(token.transfer(address(this), stakeAmount));
        }
        stakerDetails[msg.sender] = StakeInfo({
            startDate: block.timestamp, // This resets their stake start date to now
            balance: _staker.balance + stakeAmount,
            lockedAmount: _staker.lockedAmount
        });
        totalStakeAmount += stakeAmount;
        emit NewStaker(msg.sender);
    }

    /**
     * @dev Removes a value from the oracle.
     * Note: this function is only callable by the Governance contract.
     * @param _queryId is ID of the specific data feed
     * @param _timestamp is the timestamp of the data value to remove
     */
    function removeValue(bytes32 _queryId, uint256 _timestamp) external {
        require(msg.sender == governance, "caller must be governance address");
        Report storage rep = reports[_queryId];
        uint256 _index = rep.timestampIndex[_timestamp];
        // Shift all timestamps back to reflect deletion of value
        for (uint256 i = _index; i < rep.timestamps.length - 1; i++) {
            rep.timestamps[i] = rep.timestamps[i + 1];
            rep.timestampIndex[rep.timestamps[i]] -= 1;
        }
        // Delete and reset timestamp and value
        delete rep.timestamps[rep.timestamps.length - 1];
        rep.timestamps.pop();
        rep.valueByTimestamp[_timestamp] = "";
        rep.timestampIndex[_timestamp] = 0;
        emit ValueRemoved(_queryId, _timestamp);
    }

    /**
     * @dev Allows a reporter to request to withdraw their stake
     */
    function requestStakingWithdraw(uint256 _amount) external {
        StakeInfo storage _staker = stakerDetails[msg.sender];
        require(_staker.balance >= _amount, "Insufficient staked balance");
        _staker.startDate = block.timestamp;
        _staker.lockedAmount += _amount;
        _staker.balance -= _amount;
        totalStakeAmount -= _amount;
        emit StakeWithdrawRequested(msg.sender, _amount);
    }

    /**
     * @dev Slashes a reporter and transfers their stake amount to the given recipient
     * Note: this function is only callable by the governance address.
     * @param _reporter is the address of the reporter being slashed
     * @param _recipient is the address receiving the reporter's stake
     */
    function slashReporter(address _reporter, address _recipient)
        external
        returns (uint256)
    {
        require(msg.sender == governance, "Only governance can slash reporter");
        StakeInfo storage _staker = stakerDetails[_reporter];
        require(
            _staker.balance + _staker.lockedAmount > 0,
            "Zero staker balance"
        );
        uint256 _slashAmount;
        if (_staker.lockedAmount >= stakeAmount) {
            _slashAmount = stakeAmount;
            _staker.lockedAmount -= stakeAmount;
        } else if (_staker.lockedAmount + _staker.balance >= stakeAmount) {
            _slashAmount = stakeAmount;
            _staker.balance -= stakeAmount - _staker.lockedAmount;
            _staker.lockedAmount = 0;
        } else {
            _slashAmount = _staker.balance + _staker.lockedAmount;
            _staker.balance = 0;
            _staker.lockedAmount = 0;
        }
        token.transfer(_recipient, _slashAmount);
        totalStakeAmount -= _slashAmount;
        emit ReporterSlashed(_reporter, _recipient, _slashAmount);
        return (_slashAmount);
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
        bytes memory _queryData
    ) external {
        Report storage rep = reports[_queryId];
        require(
            _nonce == rep.timestamps.length,
            "nonce must match timestamp index"
        );
        StakeInfo storage _staker = stakerDetails[msg.sender];
        // Require reporter to abide by given reporting lock
        require(
            block.timestamp - reporterLastTimestamp[msg.sender] >
                reportingLock / (_staker.balance / stakeAmount),
            "still in reporter time lock, please wait!"
        );

        require(
            _queryId == keccak256(_queryData) || uint256(_queryId) <= 100,
            "id must be hash of bytes data"
        );
        // Check is in case the stake amount increases
        require(
            _staker.balance >= stakeAmount,
            "balance must be greater than stake amount"
        );
        reporterLastTimestamp[msg.sender] = block.timestamp;
        // Checks for no double reporting of timestamps
        require(
            rep.reporterByTimestamp[block.timestamp] == address(0),
            "timestamp already reported for"
        );
        // Update number of timestamps, value for given timestamp, and reporter for timestamp
        rep.timestampIndex[block.timestamp] = rep.timestamps.length;
        rep.timestamps.push(block.timestamp);
        rep.timestampToBlockNum[block.timestamp] = block.number;
        rep.valueByTimestamp[block.timestamp] = _value;
        rep.reporterByTimestamp[block.timestamp] = msg.sender;
        // Update last oracle value and number of values submitted by a reporter
        timeOfLastNewValue = block.timestamp;
        reportsSubmittedByAddress[msg.sender]++;
        reportsSubmittedByAddressAndQueryId[msg.sender][_queryId]++;
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
     * @dev Withdraws a reporter's stake
     */
    function withdrawStake() external {
        StakeInfo storage _s = stakerDetails[msg.sender];
        // Ensure reporter is locked and that enough time has passed
        require(block.timestamp - _s.startDate >= 7 days, "7 days didn't pass");
        require(_s.lockedAmount > 0, "Reporter not locked for withdrawal");
        token.transfer(msg.sender, _s.lockedAmount);
        _s.lockedAmount = 0;
        emit StakeWithdrawn(msg.sender);
    }

    //Getters
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
     * @return bytes memory of the current value of data
     */
    function getCurrentValue(bytes32 _queryId)
        external
        view
        returns (bytes memory)
    {
        return
            reports[_queryId].valueByTimestamp[
                reports[_queryId].timestamps[
                    reports[_queryId].timestamps.length - 1
                ]
            ];
    }

    /**
     * @dev Returns the reporting lock time, the amount of time a reporter must wait to submit again
     * @return uint256 reporting lock time
     */
    function getReportingLock() external view returns (uint256) {
        return reportingLock;
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
        return reporterLastTimestamp[_reporter];
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
        return reportsSubmittedByAddress[_reporter];
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
        return reportsSubmittedByAddressAndQueryId[_reporter][_queryId];
    }

    /**
     * @dev Returns the timestamp of a reported value given a data ID and timestamp index
     * @param _queryId is ID of the specific data feed
     * @param _index is the index of the timestamp
     * @return uint256 timestamp of the given queryId and index
     */
    function getReportTimestampByIndex(bytes32 _queryId, uint256 _index)
        external
        view
        returns (uint256)
    {
        return reports[_queryId].timestamps[_index];
    }

    /**
     * @dev Returns the number of timestamps/reports for a specific data ID
     * @param _queryId is ID of the specific data feed
     * @return uint256 of the number of timestamps/reports for the given data ID
     */
    function getTimestampCountById(bytes32 _queryId)
        external
        view
        returns (uint256)
    {
        return reports[_queryId].timestamps.length;
    }

    /**
     * @dev Returns the timestamp for the last value of any ID from the oracle
     * @return uint256 of timestamp of the last oracle value
     */
    function getTimeOfLastNewValue() external view returns (uint256) {
        return timeOfLastNewValue;
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
     * @dev Returns the value of a data feed given a specific ID and timestamp
     * @param _queryId is the ID of the specific data feed
     * @param _timestamp is the timestamp to look for data
     * @return bytes memory of the value of data at the associated timestamp
     */
    function getValueByTimestamp(bytes32 _queryId, uint256 _timestamp)
        external
        view
        returns (bytes memory)
    {
        return reports[_queryId].valueByTimestamp[_timestamp];
    }
}

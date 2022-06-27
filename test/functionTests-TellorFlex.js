const { expect } = require("chai");
const { network, ethers } = require("hardhat");
const h = require("./helpers/helpers");
const web3 = require('web3');
const BN = ethers.BigNumber.from

describe("TellorFlex Function Tests", function () {

	let tellor;
	let token;
	let governance;
	let govSigner;
	let accounts;
	let owner;
	const STAKE_AMOUNT_USD_TARGET = web3.utils.toWei("500");
	const PRICE_TRB = web3.utils.toWei("50");
	const REQUIRED_STAKE = web3.utils.toWei((parseInt(web3.utils.fromWei(STAKE_AMOUNT_USD_TARGET)) / parseInt(web3.utils.fromWei(PRICE_TRB))).toString());
	const REPORTING_LOCK = 43200; // 12 hours
	const QUERYID1 = h.uintTob32(1)
	const REWARD_RATE_TARGET = 60 * 60 * 24 * 30; // 30 days
	const smap = {
		startDate: 0,
		stakedBalance: 1,
		lockedBalance: 2,
		rewardDebt: 3,
		reporterLastTimestamp: 4,
		reportsSubmitted: 5,
		startVoteCount: 6,
		startVoteTally: 7
	} // getStakerInfo() indices


	beforeEach(async function () {
		accounts = await ethers.getSigners();
		owner = accounts[0]
		const ERC20 = await ethers.getContractFactory("StakingToken");
		token = await ERC20.deploy();
		await token.deployed();
		const Governance = await ethers.getContractFactory("GovernanceMock");
		governance = await Governance.deploy();
		await governance.deployed();
		const TellorFlex = await ethers.getContractFactory("TellorFlex");
		tellor = await TellorFlex.deploy(token.address, REPORTING_LOCK, STAKE_AMOUNT_USD_TARGET, PRICE_TRB);
		owner = await ethers.getSigner(await tellor.owner())
		await tellor.deployed();
		await governance.setTellorAddress(tellor.address);
		await token.mint(accounts[1].address, web3.utils.toWei("1000"));
		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await hre.network.provider.request({
			method: "hardhat_impersonateAccount",
			params: [governance.address]
		}
		)

		govSigner = await ethers.getSigner(governance.address);
		await accounts[10].sendTransaction({ to: governance.address, value: ethers.utils.parseEther("1.0") });

		await tellor.connect(owner).init(governance.address)
	});

	it("constructor", async function () {
		let stakeAmount = await tellor.getStakeAmount()
		expect(stakeAmount).to.equal(REQUIRED_STAKE);
		let governanceAddress = await tellor.getGovernanceAddress()
		expect(governanceAddress).to.equal(governance.address)
		let tokenAddress = await tellor.getTokenAddress()
		expect(tokenAddress).to.equal(token.address)
		let reportingLock = await tellor.getReportingLock()
		expect(reportingLock).to.equal(REPORTING_LOCK)
	});

	it("depositStake", async function () {
		expect(await token.balanceOf(accounts[1].address)).to.equal(web3.utils.toWei("1000"))
		expect(await token.balanceOf(accounts[2].address)).to.equal(0)
		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await token.connect(accounts[2]).approve(tellor.address, web3.utils.toWei("1000"))
		await h.expectThrow(tellor.connect(accounts[2]).depositStake(web3.utils.toWei("10")))
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
		let blocky = await h.getBlock()
		expect(await token.balanceOf(accounts[1].address)).to.equal(web3.utils.toWei("990"))
		expect(await tellor.getTotalStakers()).to.equal(1)
		let stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.startDate]).to.equal(blocky.timestamp) // startDate
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("10")) // stakedBalance
		expect(stakerDetails[smap.lockedBalance]).to.equal(0) // lockedBalance
		expect(stakerDetails[smap.rewardDebt]).to.equal(0) // rewardDebt
		expect(stakerDetails[smap.reporterLastTimestamp]).to.equal(0) // reporterLastTimestamp
		expect(stakerDetails[smap.reportsSubmitted]).to.equal(0) // reportsSubmitted
		expect(stakerDetails[smap.startVoteCount]).to.equal(0) // startVoteCount
		expect(stakerDetails[smap.startVoteTally]).to.equal(0) // startVoteTally
		expect(await tellor.totalRewardDebt()).to.equal(0)
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("10"))
		await tellor.connect(accounts[1]).requestStakingWithdraw(h.toWei("5"))
		await tellor.connect(accounts[1]).depositStake(h.toWei("10"))
		expect(await token.balanceOf(accounts[1].address)).to.equal(web3.utils.toWei("985"))
		expect(await tellor.getTotalStakers()).to.equal(1) // Ensure only unique addresses count add to total
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("15"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(0)
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("15"))
	})

	it("removeValue", async function () {
		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await tellor.connect(accounts[1]).depositStake(REQUIRED_STAKE)
		await tellor.connect(accounts[1]).submitValue(QUERYID1, h.bytes(100), 0, '0x')
		let blocky = await h.getBlock()
		expect(await tellor.getNewValueCountbyQueryId(QUERYID1)).to.equal(1)
		await h.expectThrow(tellor.connect(govSigner).removeValue(QUERYID1, 500)) // invalid value
		expect(await tellor.retrieveData(QUERYID1, blocky.timestamp)).to.equal(h.bytes(100))
		await h.expectThrow(tellor.connect(accounts[1]).removeValue(QUERYID1, blocky.timestamp)) // only gov can removeValue
		await tellor.connect(govSigner).removeValue(QUERYID1, blocky.timestamp)
		expect(await tellor.getNewValueCountbyQueryId(QUERYID1)).to.equal(0)
		expect(await tellor.retrieveData(QUERYID1, blocky.timestamp)).to.equal("0x")
		await h.expectThrow(tellor.connect(govSigner).removeValue(QUERYID1, blocky.timestamp)) //
	})

	it("requestStakingWithdraw", async function () {
		await h.expectThrow(tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("10"))) // can't request staking withdraw when not staked
		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("100"))
		let blocky = await h.getBlock()
		let stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.startDate]).to.equal(blocky.timestamp)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("100"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(0)
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("100"))
		expect(await tellor.totalRewardDebt()).to.equal(0)
		await h.expectThrow(tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("101"))) // insufficient staked balance
		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("10"))
		blocky = await h.getBlock()
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.startDate]).to.equal(blocky.timestamp)
		expect(stakerDetails[smap.rewardDebt]).to.equal(0)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("90"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(web3.utils.toWei("10"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("90"))
		expect(await tellor.totalRewardDebt()).to.equal(0)
	})

	it("slashReporter", async function () {
		await h.expectThrow(tellor.connect(accounts[2]).slashReporter(accounts[1].address, accounts[2].address)) // only gov can slash reporter
		await h.expectThrow(tellor.connect(govSigner).slashReporter(accounts[1].address, accounts[2].address)) // can't slash non-staked address
		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("100"))
		await h.expectThrow(tellor.connect(accounts[2]).slashReporter(accounts[1].address, accounts[2].address)) // only gov can slash reporter
		// Slash when lockedBalance = 0
		let stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("100"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(0)
		expect(await token.balanceOf(accounts[2].address)).to.equal(0)
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("100"))
		await tellor.connect(govSigner).slashReporter(accounts[1].address, accounts[2].address)
		blocky0 = await h.getBlock()
		expect(await tellor.timeOfLastAllocation()).to.equal(blocky0.timestamp)
		expect(await tellor.accumulatedRewardPerShare()).to.equal(0)
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("90"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(0)
		expect(await tellor.totalStakers()).to.equal(1) // Still one staker bc account#1 has 90 staked & stake amount is 10
		expect(await token.balanceOf(accounts[2].address)).to.equal(web3.utils.toWei("10"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("90"))
		// Slash when lockedBalance >= stakeAmount
		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("10"))
		blocky1 = await h.getBlock()
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("80"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(web3.utils.toWei("10"))
		await tellor.connect(govSigner).slashReporter(accounts[1].address, accounts[2].address)
		expect(await tellor.timeOfLastAllocation()).to.equal(blocky1.timestamp)
		expect(await tellor.accumulatedRewardPerShare()).to.equal(0)
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("80"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(0)
		expect(await token.balanceOf(accounts[2].address)).to.equal(web3.utils.toWei("20"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("80"))
		// Slash when 0 < lockedBalance < stakeAmount
		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("5"))
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("75"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(web3.utils.toWei("5"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("75"))
		await tellor.connect(govSigner).slashReporter(accounts[1].address, accounts[2].address)
		blocky2 = await h.getBlock()
		expect(await tellor.timeOfLastAllocation()).to.equal(blocky2.timestamp)
		expect(await tellor.accumulatedRewardPerShare()).to.equal(0)
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("70"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(0)
		expect(await token.balanceOf(accounts[2].address)).to.equal(web3.utils.toWei("30"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("70"))
		// Slash when lockedBalance + stakedBalance < stakeAmount
		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("65"))
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("5"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(web3.utils.toWei("65"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("5"))
		await h.advanceTime(604800)
		await tellor.connect(accounts[1]).withdrawStake()
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(web3.utils.toWei("5"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(web3.utils.toWei("0"))
		await tellor.connect(govSigner).slashReporter(accounts[1].address, accounts[2].address)
		blocky = await h.getBlock()
		expect(await tellor.timeOfLastAllocation()).to.equal(blocky.timestamp)
		expect(await tellor.accumulatedRewardPerShare()).to.equal(0)
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(0)
		expect(stakerDetails[smap.lockedBalance]).to.equal(0)
		expect(await tellor.totalStakers()).to.equal(0)
		expect(await token.balanceOf(accounts[2].address)).to.equal(web3.utils.toWei("35"))
		expect(await tellor.totalStakeAmount()).to.equal(0)
	})

	it("submitValue", async function () {
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("120"))
		await h.expectThrow(tellor.connect(accounts[1]).submitValue(QUERYID1, h.uintTob32(4000), 1, '0x')) // wrong nonce
		await h.expectThrow(tellor.connect(accounts[2]).submitValue(QUERYID1, h.uintTob32(4000), 1, '0x')) // insufficient staked balance
		await h.expectThrow(tellor.connect(accounts[1]).submitValue(h.uintTob32(101), h.uintTob32(4000), 0, '0x')) // non-legacy queryId must equal hash(queryData)
		await tellor.connect(accounts[1]).submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.expectThrow(tellor.connect(accounts[1]).submitValue(QUERYID1, h.uintTob32(4000), 1, '0x')) // still in reporting lock
		await h.advanceTime(3600) // 1 hour
		await tellor.connect(accounts[1]).submitValue(QUERYID1, h.uintTob32(4001), 1, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getTimestampIndexByTimestamp(QUERYID1, blocky.timestamp)).to.equal(1)
		expect(await tellor.getTimestampbyQueryIdandIndex(QUERYID1, 1)).to.equal(blocky.timestamp)
		expect(await tellor.getBlockNumberByTimestamp(QUERYID1, blocky.timestamp)).to.equal(blocky.number)
		expect(await tellor.retrieveData(QUERYID1, blocky.timestamp)).to.equal(h.uintTob32(4001))
		expect(await tellor.getReporterByTimestamp(QUERYID1, blocky.timestamp)).to.equal(accounts[1].address)
		expect(await tellor.timeOfLastNewValue()).to.equal(blocky.timestamp)
		expect(await tellor.getReportsSubmittedByAddress(accounts[1].address)).to.equal(2)
		expect(await tellor.getReportsSubmittedByAddressAndQueryId(accounts[1].address, QUERYID1)).to.equal(2)
	})

	it("withdrawStake", async function () {
		await token.connect(accounts[1]).transfer(tellor.address, web3.utils.toWei("100"))
		await h.expectThrow(tellor.connect(accounts[1]).withdrawStake()) // reporter not locked for withdrawal
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("100"))
		expect(await tellor.getTotalStakers()).to.equal(1)
		await h.expectThrow(tellor.connect(accounts[1]).withdrawStake()) // reporter not locked for withdrawal
		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("10"))
		await h.expectThrow(tellor.connect(accounts[1]).withdrawStake()) // 7 days didn't pass
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(h.toWei("90"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(h.toWei("10"))
		await h.advanceTime(60 * 60 * 24 * 7)
		expect(await token.balanceOf(accounts[1].address)).to.equal(h.toWei("800"))
		await tellor.connect(accounts[1]).withdrawStake()
		expect(await token.balanceOf(accounts[1].address)).to.equal(h.toWei("810"))
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.stakedBalance]).to.equal(h.toWei("90"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(0)
		expect(await tellor.getTotalStakers()).to.equal(0)
		await h.expectThrow(tellor.connect(accounts[1]).withdrawStake()) // reporter not locked for withdrawal
	})

	it("getBlockNumberByTimestamp", async function () {
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("100"))
		await tellor.connect(accounts[1]).submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getBlockNumberByTimestamp(QUERYID1, blocky.timestamp)).to.equal(blocky.number)
	})

	it("getCurrentValue", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		expect(await tellor.getCurrentValue(QUERYID1)).to.equal(h.uintTob32(4000))
	})

	it("getGovernanceAddress", async function () {
		expect(await tellor.getGovernanceAddress()).to.equal(governance.address)
	})

	it("getNewValueCountbyQueryId", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		expect(await tellor.getNewValueCountbyQueryId(QUERYID1)).to.equal(2)
	})

	it("getReportDetails", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky1 = await h.getBlock()
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4001), 0, '0x')
		blocky2 = await h.getBlock()
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4002), 0, '0x')
		blocky3 = await h.getBlock()
		await tellor.connect(govSigner).removeValue(QUERYID1, blocky3.timestamp)
		reportDetails = await tellor.getReportDetails(QUERYID1, blocky1.timestamp)
		expect(reportDetails[0]).to.equal(accounts[1].address)
		expect(reportDetails[1]).to.equal(false)
		reportDetails = await tellor.getReportDetails(QUERYID1, blocky2.timestamp)
		expect(reportDetails[0]).to.equal(accounts[1].address)
		expect(reportDetails[1]).to.equal(false)
		reportDetails = await tellor.getReportDetails(QUERYID1, blocky3.timestamp)
		expect(reportDetails[0]).to.equal(accounts[1].address)
		expect(reportDetails[1]).to.equal(true)
		reportDetails = await tellor.getReportDetails(h.uintTob32(2), blocky1.timestamp)
		expect(reportDetails[0]).to.equal(h.zeroAddress)
		expect(reportDetails[1]).to.equal(false)
	})

	it("getReportingLock", async function () {
		expect(await tellor.getReportingLock()).to.equal(REPORTING_LOCK)
	})

	it("getReporterByTimestamp", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		expect(await tellor.getNewValueCountbyQueryId(QUERYID1)).to.equal(1)
	})

	it("getReporterLastTimestamp", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getReporterLastTimestamp(accounts[1].address)).to.equal(blocky.timestamp)
	})

	it("getReportsSubmittedByAddress", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getReportsSubmittedByAddress(accounts[1].address)).to.equal(2)
	})

	it("getReportsSubmittedByAddressAndQueryId", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getReportsSubmittedByAddressAndQueryId(accounts[1].address, QUERYID1)).to.equal(2)
	})

	it("getStakeAmount", async function () {
		expect(await tellor.getStakeAmount()).to.equal(REQUIRED_STAKE)
	})

	it("getStakerInfo", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(h.toWei("100"))
		await tellor.requestStakingWithdraw(h.toWei("10"))
		blocky = await h.getBlock()
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky2 = await h.getBlock()
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[smap.startDate]).to.equal(blocky.timestamp)
		expect(stakerDetails[smap.stakedBalance]).to.equal(h.toWei("90"))
		expect(stakerDetails[smap.lockedBalance]).to.equal(h.toWei("10"))
		expect(stakerDetails[smap.rewardDebt]).to.equal(0)
		expect(stakerDetails[smap.reporterLastTimestamp]).to.equal(blocky2.timestamp)
		expect(stakerDetails[smap.reportsSubmitted]).to.equal(1)
		expect(stakerDetails[smap.startVoteCount]).to.equal(0)
		expect(stakerDetails[smap.startVoteTally]).to.equal(0)
	})

	it("getTimeOfLastNewValue", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getTimeOfLastNewValue()).to.equal(blocky.timestamp)
	})

	it("getTimestampbyQueryIdandIndex", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getTimestampbyQueryIdandIndex(QUERYID1, 1)).to.equal(blocky.timestamp)
	})

	it("getTimestampIndexByTimestamp", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getTimestampIndexByTimestamp(QUERYID1, blocky.timestamp)).to.equal(1)
	})

	it("getTotalStakeAmount", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(h.toWei("100"))
		await tellor.requestStakingWithdraw(h.toWei("10"))
		expect(await tellor.getTotalStakeAmount()).to.equal(h.toWei("90"))
	})

	it("getTokenAddress", async function () {
		expect(await tellor.getTokenAddress()).to.equal(token.address)
	})

	it("retrieveData", async function () {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60 * 60 * 12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4001), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.retrieveData(QUERYID1, blocky.timestamp)).to.equal(h.uintTob32(4001))
	})

	it("addStakingRewards", async function () {
		await token.mint(accounts[2].address, h.toWei("1000"))
		await h.expectThrow(tellor.connect(accounts[2]).addStakingRewards(h.toWei("1000"))) // require token.transferFrom...
		await token.connect(accounts[2]).approve(tellor.address, h.toWei("1000"))
		expect(await token.balanceOf(accounts[2].address)).to.equal(h.toWei("1000"))
		await tellor.connect(accounts[2]).addStakingRewards(h.toWei("1000"))
		expect(await tellor.stakingRewardsBalance()).to.equal(h.toWei("1000"))
		expect(await token.balanceOf(accounts[2].address)).to.equal(0)
		expect(await token.balanceOf(tellor.address)).to.equal(h.toWei("1000"))
		expectedRewardRate = Math.floor(h.toWei("1000") / REWARD_RATE_TARGET)
		expect(await tellor.rewardRate()).to.equal(expectedRewardRate)
	})

	it("getPendingRewardByStaker", async function () {
		expect(await tellor.getPendingRewardByStaker(accounts[1].address)).to.equal(0)
		await token.mint(accounts[0].address, web3.utils.toWei("1000"))
		await token.approve(tellor.address, web3.utils.toWei("1000"))
		// add staking rewards
		await tellor.addStakingRewards(web3.utils.toWei("1000"))
		expectedRewardRate = Math.floor(h.toWei("1000") / REWARD_RATE_TARGET)
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
		blocky0 = await h.getBlock()
		// advance time
		await h.advanceTime(86400 * 10)
		pendingReward = await tellor.getPendingRewardByStaker(accounts[1].address)
		blocky1 = await h.getBlock()
		expectedAccumulatedRewardPerShare = BN(blocky1.timestamp - blocky0.timestamp).mul(expectedRewardRate).div(10)
		expectedPendingReward = BN(h.toWei("10")).mul(expectedAccumulatedRewardPerShare).div(h.toWei("1"))
		expect(pendingReward).to.equal(expectedPendingReward)
		// create 2 disputes, vote on 1
		await governance.beginDisputeMock()
		await governance.beginDisputeMock()
		await governance.connect(accounts[1]).voteMock(1)
		pendingReward = await tellor.getPendingRewardByStaker(accounts[1].address)
		blocky2 = await h.getBlock()
		expectedAccumulatedRewardPerShare = BN(blocky2.timestamp - blocky0.timestamp).mul(expectedRewardRate).div(10)
		expectedPendingReward = BN(h.toWei("10")).mul(expectedAccumulatedRewardPerShare).div(h.toWei("1")).div(2)
		expect(pendingReward).to.equal(expectedPendingReward)
		expect(await tellor.getPendingRewardByStaker(accounts[2].address)).to.equal(0)
	})
});

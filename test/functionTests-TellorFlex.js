const { expect } = require("chai");
const { ethers } = require("hardhat");
const h = require("./helpers/helpers");
const web3 = require('web3');

describe("TellorFlex", function() {

	let tellor;
	let token;
	let accounts;
	const STAKE_AMOUNT = web3.utils.toWei("10");
	const REPORTING_LOCK = 43200; // 12 hours
	const QUERYID1 = h.uintTob32(1)

	beforeEach(async function () {
		accounts = await ethers.getSigners();
		const ERC20 = await ethers.getContractFactory("StakingToken");
		token = await ERC20.deploy();
		await token.deployed();
		const TellorFlex = await ethers.getContractFactory("TellorFlex");
		tellor = await TellorFlex.deploy(token.address, accounts[0].address, STAKE_AMOUNT, REPORTING_LOCK);
		await tellor.deployed();
		await token.mint(accounts[1].address, web3.utils.toWei("1000"));
		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
	});

	it("constructor", async function() {
		let stakeAmount = await tellor.getStakeAmount()
		expect(stakeAmount).to.equal(STAKE_AMOUNT)
		let governanceAddress = await tellor.getGovernanceAddress()
		expect(governanceAddress).to.equal(accounts[0].address)
		let tokenAddress = await tellor.getTokenAddress()
		expect(tokenAddress).to.equal(token.address)
		let reportingLock = await tellor.getReportingLock()
		expect(reportingLock).to.equal(REPORTING_LOCK)
	});

	it("changeGovernanceAddress", async function() {
		let governanceAddress = await tellor.getGovernanceAddress()
		expect(governanceAddress).to.equal(accounts[0].address)
		await h.expectThrow(tellor.connect(accounts[1]).changeGovernanceAddress(accounts[1].address)) // Only governance can change gov address
		await tellor.connect(accounts[0]).changeGovernanceAddress(accounts[1].address)
		governanceAddress = await tellor.getGovernanceAddress()
		expect(governanceAddress).to.equal(accounts[1].address)
		await h.expectThrow(tellor.connect(accounts[0]).changeGovernanceAddress(accounts[0].address)) // Only governance can change gov address
		await tellor.connect(accounts[1]).changeGovernanceAddress(accounts[0].address)
	});

	it("changeReportingLock", async function() {
		let reportingLock = await tellor.getReportingLock()
		expect(reportingLock).to.equal(REPORTING_LOCK)
		await h.expectThrow(tellor.connect(accounts[1]).changeReportingLock(60)) // Only governance can change reportingLock
		await tellor.changeReportingLock(60)
		reportingLock = await tellor.getReportingLock()
		expect(reportingLock).to.equal(60)
	})

	it("changeStakeAmount", async function() {
		let stakeAmount = await tellor.getStakeAmount()
		expect(stakeAmount).to.equal(STAKE_AMOUNT)
		await h.expectThrow(tellor.connect(accounts[1]).changeStakeAmount(web3.utils.toWei("1000"))) // Only governance can change reportingLock
		await tellor.changeStakeAmount(web3.utils.toWei("1000"))
		stakeAmount = await tellor.getStakeAmount()
		expect(stakeAmount).to.equal(web3.utils.toWei("1000"))
	})

	it("depositStake", async function() {
		expect(await token.balanceOf(accounts[1].address)).to.equal(web3.utils.toWei("1000"))
		expect(await token.balanceOf(accounts[2].address)).to.equal(0)
		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await token.connect(accounts[2]).approve(tellor.address, web3.utils.toWei("1000"))
		await h.expectThrow(tellor.connect(accounts[2]).depositStake(web3.utils.toWei("10")))
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
		let blocky = await h.getBlock()
		expect(await token.balanceOf(accounts[1].address)).to.equal(web3.utils.toWei("990"))
		let stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[0]).to.equal(blocky.timestamp)
		expect(stakerDetails[1]).to.equal(web3.utils.toWei("10"))
		expect(stakerDetails[2]).to.equal(0)
		expect(stakerDetails[3]).to.equal(0)
		expect(stakerDetails[4]).to.equal(0)
	})

	it("removeValue", async function() {
		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
		await tellor.connect(accounts[1]).submitValue(QUERYID1, h.bytes(100), 0, '0x')
		let blocky = await h.getBlock()
		expect(await tellor.getNewValueCountbyQueryId(QUERYID1)).to.equal(1)
		expect(await tellor.retrieveData(QUERYID1, blocky.timestamp)).to.equal(h.bytes(100))
		await h.expectThrow(tellor.connect(accounts[1]).removeValue(QUERYID1, blocky.timestamp)) // only gov can removeValue
		await tellor.removeValue(QUERYID1, blocky.timestamp)
		expect(await tellor.getNewValueCountbyQueryId(QUERYID1)).to.equal(0)
		expect(await tellor.retrieveData(QUERYID1, blocky.timestamp)).to.equal("0x")
		await h.expectThrow(tellor.removeValue(QUERYID1, blocky.timestamp)) //
	})

	it("requestStakingWithdraw", async function() {
		await h.expectThrow(tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("10"))) // can't request staking withdraw when not staked
		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("100"))
		let blocky = await h.getBlock()
		let stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[0]).to.equal(blocky.timestamp)
		expect(stakerDetails[1]).to.equal(web3.utils.toWei("100"))
		expect(stakerDetails[2]).to.equal(0)
		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("10"))
		blocky = await h.getBlock()
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[0]).to.equal(blocky.timestamp)
		expect(stakerDetails[1]).to.equal(web3.utils.toWei("90"))
		expect(stakerDetails[2]).to.equal(web3.utils.toWei("10"))
	})

	it("slashReporter", async function() {
		await h.expectThrow(tellor.connect(accounts[2]).slashReporter(accounts[1].address, accounts[2].address)) // only gov can slash reporter
		await h.expectThrow(tellor.connect(accounts[0]).slashReporter(accounts[1].address, accounts[2].address)) // can't slash non-staked address
		await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("100"))
		await h.expectThrow(tellor.connect(accounts[2]).slashReporter(accounts[1].address, accounts[2].address)) // only gov can slash reporter
		// Slash when lockedBalance = 0
		let stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[1]).to.equal(web3.utils.toWei("100"))
		expect(stakerDetails[2]).to.equal(0)
		expect(await token.balanceOf(accounts[2].address)).to.equal(0)
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("100"))
		await tellor.slashReporter(accounts[1].address, accounts[2].address)
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[1]).to.equal(web3.utils.toWei("90"))
		expect(stakerDetails[2]).to.equal(0)
		expect(await token.balanceOf(accounts[2].address)).to.equal(web3.utils.toWei("10"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("90"))
		// Slash when lockedBalance >= stakeAmount
		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("10"))
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[1]).to.equal(web3.utils.toWei("80"))
		expect(stakerDetails[2]).to.equal(web3.utils.toWei("10"))
		await tellor.slashReporter(accounts[1].address, accounts[2].address)
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[1]).to.equal(web3.utils.toWei("80"))
		expect(stakerDetails[2]).to.equal(0)
		expect(await token.balanceOf(accounts[2].address)).to.equal(web3.utils.toWei("20"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("80"))
		// Slash when 0 < lockedBalance < stakeAmount
		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("5"))
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[1]).to.equal(web3.utils.toWei("75"))
		expect(stakerDetails[2]).to.equal(web3.utils.toWei("5"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("75"))
		await tellor.slashReporter(accounts[1].address, accounts[2].address)
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[1]).to.equal(web3.utils.toWei("70"))
		expect(stakerDetails[2]).to.equal(0)
		expect(await token.balanceOf(accounts[2].address)).to.equal(web3.utils.toWei("30"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("70"))
		// Slash when lockedBalance + stakedBalance < stakeAmount
		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("65"))
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[1]).to.equal(web3.utils.toWei("5"))
		expect(stakerDetails[2]).to.equal(web3.utils.toWei("65"))
		expect(await tellor.totalStakeAmount()).to.equal(web3.utils.toWei("5"))
		await h.advanceTime(604800)
		await tellor.connect(accounts[1]).withdrawStake()
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[1]).to.equal(web3.utils.toWei("5"))
		expect(stakerDetails[2]).to.equal(web3.utils.toWei("0"))
		await tellor.slashReporter(accounts[1].address, accounts[2].address)
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[1]).to.equal(0)
		expect(stakerDetails[2]).to.equal(0)
		expect(await token.balanceOf(accounts[2].address)).to.equal(web3.utils.toWei("35"))
		expect(await tellor.totalStakeAmount()).to.equal(0)
	})

	it("submitValue", async function() {
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

	it("withdrawStake", async function() {
		await token.connect(accounts[1]).transfer(tellor.address, web3.utils.toWei("100"))
		await h.expectThrow(tellor.connect(accounts[1]).withdrawStake()) // reporter not locked for withdrawal
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("100"))
		await h.expectThrow(tellor.connect(accounts[1]).withdrawStake()) // reporter not locked for withdrawal
		await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("10"))
		await h.expectThrow(tellor.connect(accounts[1]).withdrawStake()) // 7 days didn't pass
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[1]).to.equal(h.toWei("90"))
		expect(stakerDetails[2]).to.equal(h.toWei("10"))
		await h.advanceTime(60*60*24*7)
		expect(await token.balanceOf(accounts[1].address)).to.equal(h.toWei("800"))
		await tellor.connect(accounts[1]).withdrawStake()
		expect(await token.balanceOf(accounts[1].address)).to.equal(h.toWei("810"))
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[1]).to.equal(h.toWei("90"))
		expect(stakerDetails[2]).to.equal(0)
		await h.expectThrow(tellor.connect(accounts[1]).withdrawStake()) // reporter not locked for withdrawal
	})

	it("getBlockNumberByTimestamp", async function() {
		await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("100"))
		await tellor.connect(accounts[1]).submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getBlockNumberByTimestamp(QUERYID1, blocky.timestamp)).to.equal(blocky.number)
	})

	it("getCurrentValue", async function() {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		expect(await tellor.getCurrentValue(QUERYID1)).to.equal(h.uintTob32(4000))
	})

	it("getGovernanceAddress", async function() {
		expect(await tellor.getGovernanceAddress()).to.equal(accounts[0].address)
	})

	it("getNewValueCountbyQueryId", async function() {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60*60*12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		expect(await tellor.getNewValueCountbyQueryId(QUERYID1)).to.equal(2)
	})

	it("getReportingLock", async function() {
		expect(await tellor.getReportingLock()).to.equal(REPORTING_LOCK)
	})

	it("getNewValueCountbyQueryId", async function() {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		expect(await tellor.getNewValueCountbyQueryId(QUERYID1)).to.equal(1)
	})

	it("getReporterLastTimestamp", async function() {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60*60*12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getReporterLastTimestamp(accounts[1].address)).to.equal(blocky.timestamp)
	})

	it("getReportsSubmittedByAddress", async function() {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60*60*12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getReportsSubmittedByAddress(accounts[1].address)).to.equal(2)
	})

	it("getReportsSubmittedByAddressAndQueryId", async function() {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60*60*12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getReportsSubmittedByAddressAndQueryId(accounts[1].address, QUERYID1)).to.equal(2)
	})

	it("getStakeAmount", async function() {
		expect(await tellor.getStakeAmount()).to.equal(STAKE_AMOUNT)
	})

	it("getStakerInfo", async function() {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(h.toWei("100"))
		await tellor.requestStakingWithdraw(h.toWei("10"))
		blocky = await h.getBlock()
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky2 = await h.getBlock()
		stakerDetails = await tellor.getStakerInfo(accounts[1].address)
		expect(stakerDetails[0]).to.equal(blocky.timestamp)
		expect(stakerDetails[1]).to.equal(h.toWei("90"))
		expect(stakerDetails[2]).to.equal(h.toWei("10"))
		expect(stakerDetails[3]).to.equal(blocky2.timestamp)
		expect(stakerDetails[4]).to.equal(1)
	})

	it("getTimeOfLastNewValue", async function() {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60*60*12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getTimeOfLastNewValue()).to.equal(blocky.timestamp)
	})

	it("getTimestampbyQueryIdandIndex", async function() {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60*60*12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getTimestampbyQueryIdandIndex(QUERYID1, 1)).to.equal(blocky.timestamp)
	})

	it("getTimestampIndexByTimestamp", async function() {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60*60*12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.getTimestampIndexByTimestamp(QUERYID1, blocky.timestamp)).to.equal(1)
	})

	it("getTotalStakeAmount", async function() {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(h.toWei("100"))
		await tellor.requestStakingWithdraw(h.toWei("10"))
		expect(await tellor.getTotalStakeAmount()).to.equal(h.toWei("90"))
	})

	it("getTokenAddress", async function() {
		expect(await tellor.getTokenAddress()).to.equal(token.address)
	})

	it("retrieveData", async function() {
		tellor = await tellor.connect(accounts[1])
		await tellor.depositStake(web3.utils.toWei("100"))
		await tellor.submitValue(QUERYID1, h.uintTob32(4000), 0, '0x')
		await h.advanceTime(60*60*12)
		await tellor.submitValue(QUERYID1, h.uintTob32(4001), 0, '0x')
		blocky = await h.getBlock()
		expect(await tellor.retrieveData(QUERYID1, blocky.timestamp)).to.equal(h.uintTob32(4001))
	})
});

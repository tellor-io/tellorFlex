const { expect } = require("chai");
const { ethers } = require("hardhat");
const h = require("./helpers/helpers");
const web3 = require('web3');
// const { time } = require("@openzeppelin/test-helpers");

describe("TellorFlex", function() {

	let tellor;
	let token;
	let accounts;
	const STAKE_AMOUNT = web3.utils.toWei("10");
	const REPORTING_LOCK = 43200; // 12 hours

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
		await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 0, '0x')
		let blocky = await h.getBlock()
		expect(await tellor.getNewValueCountbyQueryId(h.uintTob32(1))).to.equal(1)
		expect(await tellor.retrieveData(h.uintTob32(1), blocky.timestamp)).to.equal(h.bytes(100))
		await h.expectThrow(tellor.connect(accounts[1]).removeValue(h.uintTob32(1), blocky.timestamp)) // only gov can removeValue
		await tellor.removeValue(h.uintTob32(1), blocky.timestamp)
		expect(await tellor.getNewValueCountbyQueryId(h.uintTob32(1))).to.equal(0)
		expect(await tellor.retrieveData(h.uintTob32(1), blocky.timestamp)).to.equal("0x")
		await h.expectThrow(tellor.removeValue(h.uintTob32(1), blocky.timestamp)) //
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

	// it("submitValue", async function() {
	// 	await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("120"))
	// 	await h.expectThrow(tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(4000), 1, '0x')) // wrong nonce
	// 	await h.expectThrow(tellor.connect(accounts[2]).submitValue(h.uintTob32(1), h.bytes(4000), 1, '0x')) // insufficient staked balance
	// 	await h.expectThrow(tellor.connect(accounts[1]).submitValue(h.uintTob32(101), h.bytes(4000), 0, '0x')) // non-legacy queryId must equal hash(queryData)
	// 	await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(4000), 1, '0x')
	// })

// withdrawStake
});

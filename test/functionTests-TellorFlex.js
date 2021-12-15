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
		
	})

// slashReporter
// submitValue
// withdrawStake

	// it("constructor()", async function() {
	// 	let quorumFromContract = await dao.quorum();
	// 	expect(quorumFromContract).to.equal(QUORUM);
	// 	let proposalTimeWindowFromContract = await dao.proposalTimeWindow();
	// 	expect(proposalTimeWindowFromContract).to.equal(PROPOSAL_TIME_WINDOW);
	// 	let memberCountFromContract = await dao.memberCount();
	// 	expect(memberCountFromContract).to.equal(INITIAL_MEMBER_COUNT);
	// 	expect(await dao.isMember(accounts[0].address), "Account 0 should be member").to.be.true;
	// 	expect(await dao.isMember(accounts[1].address), "Account 1 should be member").to.be.true;
	// 	expect(await dao.isMember(accounts[2].address), "Account 2 should be member").to.be.true;
	// 	expect(await dao.isMember(accounts[3].address), "Account 3 should be member").to.be.true;
	// 	expect(await dao.isMember(accounts[4].address), "Account 4 should be member").to.be.true;
	// 	expect(await dao.isMember(accounts[5].address), "Account 5 should NOT be member").to.be.false;
	// });
});

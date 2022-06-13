const { expect } = require("chai");
const { ethers } = require("hardhat");
const h = require("./helpers/helpers");
var assert = require('assert');
const web3 = require('web3');
const { prependOnceListener } = require("process");
// const { time } = require("@openzeppelin/test-helpers");

describe("TellorFlex e2e Tests", function() {

	let tellor;
	let token;
	let accounts;
	const STAKE_AMOUNT = web3.utils.toWei("10");
	const REPORTING_LOCK = 43200; // 12 hours
    const DEV_WALLET = "0x39E419bA25196794B595B2a595Ea8E527ddC9856"

	beforeEach(async function () {
		accounts = await ethers.getSigners();
		const ERC20 = await ethers.getContractFactory("StakingToken");
		token = await ERC20.deploy();
		await token.deployed();
		const TellorFlex = await ethers.getContractFactory("TellorFlex");
		tellor = await TellorFlex.deploy(token.address, accounts[0].address, DEV_WALLET, STAKE_AMOUNT, REPORTING_LOCK);
		await tellor.deployed();
		await token.mint(accounts[1].address, web3.utils.toWei("1000"));
        await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
	});
    it("Staked multiple times, disputed but keeps reporting", async function() {
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("30"))
        await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 0, '0x')
		let blocky = await h.getBlock()
		expect(await tellor.getNewValueCountbyQueryId(h.uintTob32(1))).to.equal(1)
		expect(await tellor.retrieveData(h.uintTob32(1), blocky.timestamp)).to.equal(h.bytes(100))
		await h.expectThrow(tellor.connect(accounts[1]).removeValue(h.uintTob32(1), blocky.timestamp)) // only gov can removeValue
		await tellor.removeValue(h.uintTob32(1), blocky.timestamp)
        await tellor.slashReporter(accounts[1].address, accounts[2].address)
        await h.advanceTime(86400/2/3)
        await h.expectThrow(tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 0, '0x'))
        await h.advanceTime(86400/2/3)
        let vars = await tellor.getStakerInfo(accounts[1].address)
        assert(vars[1] == web3.utils.toWei("20"), "should still have money staked")
    })
    it("Staker stakes multiple times", async function() {
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
        await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 0, '0x')
        let vars = await tellor.getStakerInfo(accounts[1].address)
        assert(vars[1] == web3.utils.toWei("30"), "should still have money staked")
    })
    it("Upgrade Governance Contract", async function() {
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
        await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 0, '0x')
        let governanceAddress = await tellor.getGovernanceAddress()
		expect(governanceAddress).to.equal(accounts[0].address)
		await h.expectThrow(tellor.connect(accounts[1]).changeGovernanceAddress(accounts[1].address)) // Only governance can change gov address
		await tellor.connect(accounts[0]).changeGovernanceAddress(accounts[1].address)
		governanceAddress = await tellor.getGovernanceAddress()
		expect(governanceAddress).to.equal(accounts[1].address)
		await h.expectThrow(tellor.connect(accounts[0]).changeGovernanceAddress(accounts[0].address)) // Only governance can change gov address
		await tellor.connect(accounts[1]).changeGovernanceAddress(accounts[0].address)
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
        await h.advanceTime(86400/4)
        await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 0, '0x')
    })
    it("Check reducing stake amount in the future", async function() {
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
        await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 0, '0x')
        await h.advanceTime(86400/4 + 10)
        h.expectThrow(tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(102), 1, '0x'))
		await tellor.connect(accounts[0]).changeStakeAmount(web3.utils.toWei("5"))
        await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(102), 1, '0x')
    })
    it("Bad value placed, withdraw requested, dispute started", async function() {
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("120"))
        await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.uintTob32(4000), 0, '0x')
        let blocky = await h.getBlock()
        await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("10"))
        await tellor.removeValue(h.uintTob32(1), blocky.timestamp)
        await tellor.slashReporter(accounts[1].address, accounts[2].address)
		await h.expectThrow(tellor.connect(accounts[1]).withdrawStake()) // 7 days didn't pass
    })
    it("Increase reporter lock time", async function() {
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
        await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 0, '0x')
        let reportingLock = await tellor.getReportingLock()
		expect(reportingLock).to.equal(REPORTING_LOCK)
		await tellor.changeReportingLock(86400)
		reportingLock = await tellor.getReportingLock()
		expect(reportingLock).to.equal(86400)
        await h.advanceTime(86400/2)
        await h.expectThrow(tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 1, '0x'))
        await h.advanceTime(86420/2)
        await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 0, '0x')
    })
    it("Check increasing stake amount in future", async function() {
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
        await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 0, '0x')
        let stakeAmount = await tellor.getStakeAmount()
		expect(stakeAmount).to.equal(STAKE_AMOUNT)
    	await tellor.changeStakeAmount(web3.utils.toWei("1000"))
		stakeAmount = await tellor.getStakeAmount()
		expect(stakeAmount).to.equal(web3.utils.toWei("1000"))
        await h.advanceTime(86400/2)
        h.expectThrow(tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 1, '0x'))
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("990"))
        await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 1, '0x')
    })
    it("Mine 2 values on 50 different ID's", async function() {
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
        await token.mint(accounts[2].address, web3.utils.toWei("1000"));
        await token.connect(accounts[2]).approve(tellor.address, web3.utils.toWei("1000"))
        await tellor.connect(accounts[2]).depositStake(web3.utils.toWei("10"))
        let count
        for(i=0;i<50;i++){
            await tellor.connect(accounts[1]).submitValue(h.uintTob32(i+1), h.bytes(100), 0, i)
            await tellor.connect(accounts[2]).submitValue(h.uintTob32(i+1), h.bytes(100), 0, i)
            await h.advanceTime(86400/2)
        }
        for(i=0;i<50;i++){
            count = await tellor.getNewValueCountbyQueryId(h.uintTob32(i+1))
            assert(count == 2, "new value count should be correct")
        }
        let repC1 = await tellor.getReportsSubmittedByAddress(accounts[1].address)
        let repC2 = await tellor.getReportsSubmittedByAddress(accounts[2].address)
        assert(repC1 == 50, "reporter count 1 should be correct")
        assert(repC2 == 50, "reporter 2 count should be correct")
    })
    it("Decrease reporter lock time", async function() {
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
        await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 0, '0x')
        await h.advanceTime(86400/4)
        await h.expectThrow(tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 1, '0x'))
        let reportingLock = await tellor.getReportingLock()
		expect(reportingLock).to.equal(REPORTING_LOCK)
		await tellor.changeReportingLock(86400/4)
        await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 1, '0x')
    })
    it("Realistic test (actual variables we'll use)", async function() {
        for(i=0;i<20;i++){
            await token.mint(accounts[i].address, web3.utils.toWei("1000"));
            await token.connect(accounts[i]).approve(tellor.address, web3.utils.toWei("1000"))
            await tellor.connect(accounts[i]).depositStake(web3.utils.toWei("10"))
        }
        for(i=0;i<10;i++){
            await h.advanceTime(86400/2)
            await tellor.connect(accounts[i]).submitValue(h.uintTob32(1), h.bytes(100), 0, "0x")
            await tellor.connect(accounts[i+1]).submitValue(h.uintTob32(1), h.bytes(200), 0, "0x")
            await tellor.connect(accounts[i+2]).submitValue(h.uintTob32(1), h.bytes(100), 0, "0x")
            await tellor.connect(accounts[i+3]).submitValue(h.uintTob32(1), h.bytes(100), 0,"0x")
            await tellor.connect(accounts[i+4]).submitValue(h.uintTob32(1), h.bytes(100), 0, "0x")

        }
        let blocky = await h.getBlock()
        await tellor.removeValue(h.uintTob32(1), blocky.timestamp)
        await tellor.slashReporter(accounts[13].address, accounts[2].address)
        await tellor.connect(accounts[0]).changeGovernanceAddress(accounts[1].address)
        for(i=1;i<3;i++){
            await tellor.connect(accounts[i]).requestStakingWithdraw(web3.utils.toWei("10"))
            await h.advanceTime(60*60*24*7)
            await tellor.connect(accounts[i]).withdrawStake()
        }
        for(i=3;i<8;i++){
            await tellor.connect(accounts[i]).submitValue(h.uintTob32(1), h.bytes(100), 0, "0x")
            await tellor.connect(accounts[i+1]).submitValue(h.uintTob32(1), h.bytes(10000), 0, "0x")
            await h.advanceTime(86400/2)
        }
    })
})

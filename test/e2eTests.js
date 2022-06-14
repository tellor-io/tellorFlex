const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const h = require("./helpers/helpers");
var assert = require('assert');
const web3 = require('web3');
const { prependOnceListener } = require("process");
const BN = ethers.BigNumber.from

describe("TellorFlex e2e Tests", function() {

	let tellor;
    let governance;
    let govSigner;
	let token;
	let accounts;
	const STAKE_AMOUNT_USD = 10 ** 1e18; // 10 USD
    const PRICE_TRB = 100 ** 1e18; // 1 TRB = 100 USD
    let owner;
	const STAKE_AMOUNT = web3.utils.toWei("10");
	const REPORTING_LOCK = 43200; // 12 hours
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
<<<<<<< HEAD
		tellor = await TellorFlex.deploy(token.address, accounts[0].address, STAKE_AMOUNT_USD, PRICE_TRB, REPORTING_LOCK);
=======
		tellor = await TellorFlex.deploy(token.address, owner.address, STAKE_AMOUNT, REPORTING_LOCK);
>>>>>>> 81bd2bdce2d3ffa73fe30fd637adb0a7b0bcf149
		await tellor.deployed();
        await governance.setTellorAddress(tellor.address);
		await token.mint(accounts[1].address, web3.utils.toWei("1000"));
        await token.connect(accounts[1]).approve(tellor.address, web3.utils.toWei("1000"))
        await hre.network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [governance.address]}
        )
        govSigner = await ethers.getSigner(governance.address);
        await accounts[10].sendTransaction({to:governance.address,value:ethers.utils.parseEther("1.0")}); 

        await tellor.connect(owner).init(governance.address)
	});
    it("Staked multiple times, disputed but keeps reporting", async function() {
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("30"))
        await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 0, '0x')
		let blocky = await h.getBlock()
		expect(await tellor.getNewValueCountbyQueryId(h.uintTob32(1))).to.equal(1)
		expect(await tellor.retrieveData(h.uintTob32(1), blocky.timestamp)).to.equal(h.bytes(100))
		await h.expectThrow(tellor.connect(accounts[1]).removeValue(h.uintTob32(1), blocky.timestamp)) // only gov can removeValue
		await tellor.connect(govSigner).removeValue(h.uintTob32(1), blocky.timestamp)
        await tellor.connect(govSigner).slashReporter(accounts[1].address, accounts[2].address)
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
    it("Bad value placed, withdraw requested, dispute started", async function() {
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("120"))
        await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.uintTob32(4000), 0, '0x')
        let blocky = await h.getBlock()
        await tellor.connect(accounts[1]).requestStakingWithdraw(web3.utils.toWei("10"))
        await tellor.connect(govSigner).removeValue(h.uintTob32(1), blocky.timestamp)
        await tellor.connect(govSigner).slashReporter(accounts[1].address, accounts[2].address)
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
		expect(stakeAmount).to.equal(STAKE_AMOUNT_USD / PRICE_TRB)
    	await tellor.changeStakeAmount(web3.utils.toWei("1000"))
		stakeAmount = await tellor.getStakeAmount()
		expect(stakeAmount).to.equal(web3.utils.toWei("1000"))
        await h.advanceTime(86400/2)
        h.expectThrow(tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 1, '0x'))
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("990"))
        await tellor.connect(accounts[1]).submitValue(h.uintTob32(1), h.bytes(100), 1, '0x')

    })
    it("Check updating stake amount base on price of TRB in USD", async function() {
        // submit value for price of TRB using query id
        // change query id to be actual query id of TRB/USD spot price
        let newTrbPrice = web3.utils.toWei("70")
        let newStakeAmountDollars = 35
        let trbUsdSpotPriceQueryId = h.uintTob32(2)
        await tellor.connect(accounts[1]).depositStake(STAKE_AMOUNT_USD / PRICE_TRB)
        await tellor.connect(accounts[1]).submitValue(trbUsdSpotPriceQueryId, h.bytes(newTrbPrice), 0, '0x')
        
        // call changeStakeAmountDollars
        await tellor.changeStakeAmountDollars(newStakeAmountDollars, trbUsdSpotPriceQueryId)

        // check that stake amount is updated
        let stakeAmount = await tellor.getStakeAmount()
        expect(stakeAmount).to.equal(newStakeAmountDollars / newTrbPrice)
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
        await tellor.connect(govSigner).removeValue(h.uintTob32(1), blocky.timestamp)
        await tellor.connect(govSigner).slashReporter(accounts[13].address, accounts[2].address)
        // await tellor.connect(govSigner).changeGovernanceAddress(accounts[1].address)
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
    it("Realistic test with staking rewards and disputes", async function() {
        await token.mint(accounts[0].address, web3.utils.toWei("1000"))
        await token.approve(tellor.address, web3.utils.toWei("1000"))
        // check initial conditions
        expect(await tellor.stakingRewardsBalance()).to.equal(0)
        expect(await tellor.rewardRate()).to.equal(0)
        // add staking rewards
        await tellor.addStakingRewards(web3.utils.toWei("1000"))
        // check conditions after adding rewards
        expect(await tellor.stakingRewardsBalance()).to.equal(web3.utils.toWei("1000"))
        expect(await tellor.totalRewardDebt()).to.equal(0)
        expectedRewardRate = Math.floor(h.toWei("1000") / REWARD_RATE_TARGET)
        expect(await tellor.rewardRate()).to.equal(expectedRewardRate)
        // create 2 mock disputes, vote once
        await governance.beginDisputeMock()
        await governance.beginDisputeMock()
        await governance.connect(accounts[1]).voteMock(1)
        // deposit stake
        await tellor.connect(accounts[1]).depositStake(web3.utils.toWei("10"))
        blocky0 = await h.getBlock()
        // check conditions after depositing stake
        expect(await tellor.stakingRewardsBalance()).to.equal(web3.utils.toWei("1000"))
        expect(await tellor.getTotalStakeAmount()).to.equal(web3.utils.toWei("10"))
        expect(await tellor.totalRewardDebt()).to.equal(0)
        expect(await tellor.accumulatedRewardPerShare()).to.equal(0)
        expect(await tellor.timeOfLastAllocation()).to.equal(blocky0.timestamp)
        stakerInfo = await tellor.getStakerInfo(accounts[1].address)
        expect(stakerInfo[smap.stakedBalance]).to.equal(web3.utils.toWei("10")) // staked balance
        expect(stakerInfo[smap.rewardDebt]).to.equal(0) // rewardDebt
        expect(stakerInfo[smap.startVoteCount]).to.equal(2) // startVoteCount
        expect(stakerInfo[7]).to.equal(1) // startVoteTally
        // advance time
        await h.advanceTime(86400 * 10)
        expect(await token.balanceOf(accounts[1].address)).to.equal(h.toWei("990"))
        // deposit 0 stake, update rewards
        await tellor.connect(accounts[1]).depositStake(0)
        blocky1 = await h.getBlock()
        // check conditions after updating rewards
        expect(await tellor.timeOfLastAllocation()).to.equal(blocky1.timestamp)
        expect(await tellor.rewardRate()).to.equal(expectedRewardRate)
        expectedAccumulatedRewardPerShare = BN(blocky1.timestamp - blocky0.timestamp).mul(expectedRewardRate).div(10)
        expectedBalance = BN(h.toWei("10")).mul(expectedAccumulatedRewardPerShare).div(h.toWei("1")).add(h.toWei("990"))
        expect(await token.balanceOf(accounts[1].address)).to.equal(expectedBalance)
        expect(await tellor.accumulatedRewardPerShare()).to.equal(expectedAccumulatedRewardPerShare)
        expect(await tellor.totalRewardDebt()).to.equal(expectedBalance.sub(h.toWei("990")))
        stakerInfo = await tellor.getStakerInfo(accounts[1].address)
        expect(stakerInfo[smap.stakedBalance]).to.equal(h.toWei("10")) // staked balance
        expect(stakerInfo[smap.rewardDebt]).to.equal(expectedBalance.sub(h.toWei("990"))) // rewardDebt
        expect(stakerInfo[smap.startVoteCount]).to.equal(2) // startVoteCount
        expect(stakerInfo[7]).to.equal(1) // startVoteTally
        // start a dispute
        await governance.beginDisputeMock()
        // advance time
        await h.advanceTime(86400 * 10)
        // deposit 0 stake, update rewards
        await tellor.connect(accounts[1]).depositStake(0)
        blocky2 = await h.getBlock()
        // check conditions after updating rewards
        expect(await tellor.timeOfLastAllocation()).to.equal(blocky2.timestamp)
        expect(await tellor.rewardRate()).to.equal(expectedRewardRate)
        expectedAccumulatedRewardPerShare = BN(blocky2.timestamp - blocky1.timestamp).mul(expectedRewardRate).div(10).add(expectedAccumulatedRewardPerShare)
        expect(await token.balanceOf(accounts[1].address)).to.equal(expectedBalance)
        expect(await tellor.accumulatedRewardPerShare()).to.equal(expectedAccumulatedRewardPerShare)
        expectedRewardDebt = expectedAccumulatedRewardPerShare.mul(10)
        expect(await tellor.totalRewardDebt()).to.equal(expectedRewardDebt)
        stakerInfo = await tellor.getStakerInfo(accounts[1].address)
        expect(stakerInfo[smap.stakedBalance]).to.equal(h.toWei("10")) // staked balance
        expect(stakerInfo[smap.rewardDebt]).to.equal(expectedRewardDebt) // rewardDebt
        expect(stakerInfo[smap.startVoteCount]).to.equal(2) // startVoteCount
        expect(stakerInfo[7]).to.equal(1) // startVoteTally
        // start a dispute and vote
        await governance.beginDisputeMock()
        await governance.connect(accounts[1]).voteMock(4)
        // advance time
        await h.advanceTime(86400 * 5)
        // deposit 0 stake, update rewards
        await tellor.connect(accounts[1]).depositStake(0)
        blocky3 = await h.getBlock()
        // check conditions after updating rewards
        expect(await tellor.timeOfLastAllocation()).to.equal(blocky3.timestamp)
        expect(await tellor.rewardRate()).to.equal(expectedRewardRate)
        expectedAccumulatedRewardPerShare = BN(blocky3.timestamp - blocky2.timestamp).mul(expectedRewardRate).div(10).add(expectedAccumulatedRewardPerShare)
        expectedBalance = expectedBalance.add(expectedAccumulatedRewardPerShare.mul(10).sub(expectedRewardDebt).div(2)) 
        expect(await token.balanceOf(accounts[1].address)).to.equal(expectedBalance)
        expect(await tellor.accumulatedRewardPerShare()).to.equal(expectedAccumulatedRewardPerShare)
        expectedRewardDebt = expectedAccumulatedRewardPerShare.mul(10)
        expect(await tellor.totalRewardDebt()).to.equal(expectedRewardDebt)
        stakerInfo = await tellor.getStakerInfo(accounts[1].address)
        expect(stakerInfo[smap.stakedBalance]).to.equal(h.toWei("10")) // staked balance
        expect(stakerInfo[smap.rewardDebt]).to.equal(expectedRewardDebt) // rewardDebt
        expect(stakerInfo[smap.startVoteCount]).to.equal(2) // startVoteCount
        expect(stakerInfo[7]).to.equal(1) // startVoteTally
        expect(await tellor.stakingRewardsBalance()).to.equal(BN(h.toWei("1000")).sub(expectedBalance).add(h.toWei("990")))
    })
    it("Realistic test with multiple stakers", async function() {
        await token.mint(accounts[0].address, web3.utils.toWei("1000"))
        await token.approve(tellor.address, web3.utils.toWei("1000"))
        await tellor.addStakingRewards(h.toWei("1000"))
        for(i=1;i<20;i++){
            await token.mint(accounts[i].address, web3.utils.toWei("100"));
            await token.connect(accounts[i]).approve(tellor.address, web3.utils.toWei("100"))
            await tellor.connect(accounts[i]).depositStake(web3.utils.toWei("100"))
        }
        await h.advanceTime(86400 * 10)
        for(i=1;i<20;i++){
            await token.mint(accounts[0].address, web3.utils.toWei("1"))
            await token.approve(tellor.address, web3.utils.toWei("1"))
            await tellor.addStakingRewards(h.toWei("1"))
            await token.mint(accounts[i].address, web3.utils.toWei("100"));
            await token.connect(accounts[i]).approve(tellor.address, web3.utils.toWei("100"))
            await tellor.connect(accounts[i]).depositStake(web3.utils.toWei("100"))
        }
        await h.advanceTime(86400 * 10)
        for(i=1;i<20;i++){
            await token.mint(accounts[0].address, web3.utils.toWei("1"))
            await token.approve(tellor.address, web3.utils.toWei("1"))
            await tellor.addStakingRewards(h.toWei("1"))
            await token.mint(accounts[i].address, web3.utils.toWei("100"));
            await token.connect(accounts[i]).approve(tellor.address, web3.utils.toWei("100"))
            await tellor.connect(accounts[i]).depositStake(web3.utils.toWei("100"))
        }
        await h.advanceTime(86400 * 60)
        for(i=1;i<20;i++){
            stakerDetails = await tellor.getStakerInfo(accounts[i].address)
            await tellor.connect(accounts[i]).requestStakingWithdraw(stakerDetails[smap.stakedBalance])
        }
        await h.advanceTime(86400 * 8)
        for(i=1;i<20;i++){
            await tellor.connect(accounts[i]).withdrawStake()
        }
    })

    it("TBR should not borrow from staking rewards", async function() {

        //mint balance
        await token.mint(accounts[0].address, web3.utils.toWei("1000"))

        //stake reporter (add 10 TRB stake to contract balance)
        await token.connect(accounts[0]).approve(tellor.address, h.toWei("1000"))
        await tellor.connect(accounts[0]).depositStake(h.toWei("10"))

        //add staking rewards: 150 TRB
        await tellor.connect(accounts[0]).addStakingRewards(h.toWei("150"))

        //TRB balance of flex should be 160 TRB
        expect(
            await token.balanceOf(tellor.address)).to.equal(
            h.toWei("160"), //staking rewards + stake
            "unexpected TRB balance in flex"
        )

        //stakingRewardsBalance should be 150
        expect(
            await tellor.stakingRewardsBalance()).to.equal(
            h.toWei("150"),
            "stakingRewardsBalance does not equal balance deposited"
        )

        //skip deposit of Time based rewards

        //fast forward 1 day (this should be worth 144 tokens)
        await h.advanceTime(86400)

        //submit value should not disperse TBR because
        // 0 time based rewards tokens deposited
        await tellor.connect(accounts[0]).submitValue(h.uintTob32(1), h.bytes(100), 0, '0x')

        //TRB balance of flex should be 160 TRB
        expect(
            await token.balanceOf(tellor.address)).to.equal(
            h.toWei("160"),
            "time based rewards in flex borrowed from staking rewards"
        )


        //stakingRewardsBalance should still be 150

        //call claim staking rewards
    })
})

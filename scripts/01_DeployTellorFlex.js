require("hardhat-gas-reporter");
require('hardhat-contract-sizer');
require("solidity-coverage");
require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-etherscan");
require("@nomiclabs/hardhat-waffle");
require("dotenv").config();
const web3 = require('web3');

//const dotenv = require('dotenv').config()
//npx hardhat run scripts/01_DeployTellorFlex.js --network rinkeby

var stake_amt = web3.utils.toWei("10");
var rep_lock = 43200; // 12 hours
var stakerTokenAdd= '0x88dF592F8eb5D7Bd38bFeF7dEb0fBc02cf3778a0'
var governanceAddress = '0x20bEC8F31dea6C13A016DC7fCBdF74f61DC8Ec2c'


async function deployTellorFlex(_network, _pk, _nodeURL, stakerToken, govAdd, stakeAmount, reporterLock) {
    console.log("deploy tellorFlex")
    await run("compile")

    var net = _network

    ///////////////Connect to the network
    let privateKey = _pk;
    var provider = new ethers.providers.JsonRpcProvider(_nodeURL)
    let wallet = new ethers.Wallet(privateKey, provider)


    /////////// Deploy Tellor flex
    console.log("deploy tellor flex")


    /////////////TellorFlex
    console.log("Starting deployment for TellorFlex contract...")
    const tellorF = await ethers.getContractFactory("contracts/TellorFlex.sol:TellorFlex", wallet)
    const tellorFwithsigner = await tellorF.connect(wallet)
    const tellor = await tellorFwithsigner.deploy(stakerToken, govAdd, stakeAmount, reporterLock)
    await tellor.deployed();


    if (net == "mainnet") {
        console.log("TellorFlex contract deployed to:", "https://etherscan.io/address/" + tellor.address);
        console.log("    TellorFlex transaction hash:", "https://etherscan.io/tx/" + tellor.deployTransaction.hash);
    } else if (net == "rinkeby") {
        console.log("TellorFlex contract deployed to:", "https://rinkeby.etherscan.io/address/" + tellor.address);
        console.log("    TellorFlex transaction hash:", "https://rinkeby.etherscan.io/tx/" + tellor.deployTransaction.hash);
    } else {
        console.log("Please add network explorer details")
    }

    // Wait for few confirmed transactions.
    // Otherwise the etherscan api doesn't find the deployed contract.
    console.log('waiting for TellorFlex tx confirmation...');
    await tellor.deployTransaction.wait(7)

    console.log('submitting TellorFlex contract for verification...');

    await run("verify:verify",
        {
            address: tellor.address,
            constructorArguments: [stakerToken, govAdd, stakeAmount, reporterLock] 
        },
    )

    console.log("TellorFlex contract verified")

  



}


deployTellorFlex("rinkeby", process.env.TESTNET_PK, process.env.NODE_URL_RINKEBY,stakerTokenAdd,governanceAddress,stake_amt,rep_lock)
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error);
        process.exit(1);
    });


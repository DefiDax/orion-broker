import {BlockchainOrder, Dictionary, Liability, parseLiability, Side, Trade, Transaction} from './Model';
import {DbSubOrder} from './db/Db';
import BigNumber from 'bignumber.js';
import {log} from './log';
import fetch from 'node-fetch';

import Web3 from 'web3';
import Long from 'long';
import {signTypedMessage} from 'eth-sig-util';
import {privateToAddress} from 'ethereumjs-util';
import {ethers} from 'ethers';

import exchangeArtifact from './abi/Exchange.json';
import erc20Artifact from './abi/ERC20.json';
import {exchangeContractAddress, tokens, tokensDecimals} from './main';

const DOMAIN_TYPE = [
    {name: 'name', type: 'string'},
    {name: 'version', type: 'string'},
    {name: 'chainId', type: 'uint256'},
    {name: 'salt', type: 'bytes32'},
];

const ORDER_TYPE = [
    {name: 'senderAddress', type: 'address'},
    {name: 'matcherAddress', type: 'address'},
    {name: 'baseAsset', type: 'address'},
    {name: 'quoteAsset', type: 'address'},
    {name: 'matcherFeeAsset', type: 'address'},
    {name: 'amount', type: 'uint64'},
    {name: 'price', type: 'uint64'},
    {name: 'matcherFee', type: 'uint64'},
    {name: 'nonce', type: 'uint64'},
    {name: 'expiration', type: 'uint64'},
    {name: 'buySide', type: 'uint8'},
];

function longToHex(long: number): string {
    return Web3.utils.bytesToHex(Long.fromNumber(long).toBytesBE());
}

export function hashOrder(order: BlockchainOrder): string {
    return Web3.utils.soliditySha3(
        '0x03',
        order.senderAddress,
        order.matcherAddress,
        order.baseAsset,
        order.quoteAsset,
        order.matcherFeeAsset,
        longToHex(order.amount),
        longToHex(order.price),
        longToHex(order.matcherFee),
        longToHex(order.nonce),
        longToHex(order.expiration),
        order.buySide ? '0x01' : '0x00'
    );
}

export interface OrionBlockchainSettings {
    production: boolean;
    orionBlockchainUrl: string;
    matcherAddress: string;
    privateKey: string;
}

const DEFAULT_EXPIRATION = 29 * 24 * 60 * 60 * 1000;
const DEPOSIT_ETH_GAS_LIMIT = 70000;
const DEPOSIT_ERC20_GAS_LIMIT = 150000;
const APPROVE_ERC20_GAS_LIMIT = 70000;
const LOCK_STAKE_GAS_LIMIT = 70000;
const RELEASE_STAKE_GAS_LIMIT = 100000;

function toWei8(amount: BigNumber, decimals: number = 8): string {
    return amount.multipliedBy(10 ** decimals).toFixed(0);
}

export function fromWei(wei: BigNumber.Value, decimals: number): BigNumber {
    return new BigNumber(wei).dividedBy(10 ** decimals);
}

export function fromWei8(wei: BigNumber.Value): BigNumber {
    return fromWei(wei, 8);
}

export class OrionBlockchain {
    private readonly chainId: number;
    private readonly orionBlockchainUrl: string;
    private readonly matcherAddress: string;
    private readonly privateKey: string;
    private readonly bufferKey: Buffer;
    public readonly address: string;

    private exchangeContractAddress: string;
    private wallet: ethers.Wallet;
    private exchangeContract: ethers.Contract;

    constructor(settings: OrionBlockchainSettings) {
        this.chainId = settings.production ? 1 : 3;
        log.log('Chain ID: ' + this.chainId);
        this.orionBlockchainUrl = settings.orionBlockchainUrl;
        this.matcherAddress = settings.matcherAddress;
        this.privateKey = settings.privateKey;
        try {
            this.bufferKey = Buffer.from(settings.privateKey.substr(2), 'hex');
            this.address = '0x' + privateToAddress(this.bufferKey).toString('hex');
            log.log('Broker address: ' + this.address);
        } catch (e) {
            log.error('Orion blockchain init error:', e);
        }
    }

    public async initContracts(): Promise<void> {
        this.exchangeContractAddress = exchangeContractAddress;
        this.wallet = new ethers.Wallet(this.privateKey);
        this.exchangeContract = new ethers.Contract(
            this.exchangeContractAddress,
            exchangeArtifact.abi as any,
            this.wallet
        );
        log.log('Exchange Contract Address: ' + this.exchangeContractAddress);
    }

    private signOrder(order: BlockchainOrder): string {
        const DOMAIN_DATA = {
            name: 'Orion Exchange',
            version: '1',
            chainId: this.chainId,
            salt:
                '0xf2d857f4a3edcb9b78b4d503bfe733db1e3f6cdc2b7971ee739626c97e86a557',
        };

        const data = {
            types: {
                EIP712Domain: DOMAIN_TYPE,
                Order: ORDER_TYPE,
            },
            domain: DOMAIN_DATA,
            primaryType: 'Order',
            message: order,
        };

        const msgParams = {data};
        return signTypedMessage(this.bufferKey, msgParams as any, 'V4');
    }

    private toBaseUnit(amount: BigNumber, decimals: number = 8): number {
        return Math.round(amount.toNumber() * 10 ** decimals);
    }

    private counterSide(side: Side): number {
        return side === 'buy' ? 0 : 1;
    }

    private createBlockchainOrder(subOrder: DbSubOrder, trade: Trade): BlockchainOrder {
        const assets = tokens.symbolToAddresses(subOrder.symbol);
        const buySide = this.counterSide(subOrder.side);
        const matcherFeeAsset = tokens.nameToAddress['ORN'];

        // const matcherFeeAsset = buySide ? assets[0] : assets[1];
        // const MATCHER_FEE_PERCENT = new BigNumber(0.2).dividedBy(100); // 0.2%
        // const matcherFee: BigNumber = buySide ? trade.amount.multipliedBy(MATCHER_FEE_PERCENT) : trade.amount.multipliedBy(trade.price).multipliedBy(MATCHER_FEE_PERCENT);

        return {
            id: '',
            senderAddress: this.address,
            matcherAddress: this.matcherAddress,
            baseAsset: assets[0],
            quoteAsset: assets[1],
            matcherFeeAsset: matcherFeeAsset,
            amount: this.toBaseUnit(trade.amount),
            price: this.toBaseUnit(trade.price),
            matcherFee: 0,
            nonce: subOrder.timestamp,
            expiration: subOrder.timestamp + DEFAULT_EXPIRATION,
            buySide: buySide,
            signature: ''
        };
    }

    public async signTrade(subOrder: DbSubOrder, trade: Trade): Promise<BlockchainOrder> {
        const bo = this.createBlockchainOrder(subOrder, trade);
        bo.id = hashOrder(bo);
        bo.signature = this.signOrder(bo);
        return bo;
    }

    public async sign(payload: string): Promise<string> {
        return this.wallet.signMessage(payload);
    }

    private send(url: string, method: string = 'GET', data?: any): Promise<any> {
        const headers = {
            'Content-Type': 'application/json'
        };

        const body = JSON.stringify(data);

        return fetch(url, {
            method,
            cache: 'no-store',
            headers,
            body
        }).then(result => result.json());
    }

    public async getAllowance(assetName: string): Promise<BigNumber> {
        const assetAddress: string = tokens.nameToAddress[assetName];
        const data: any = await this.send(this.orionBlockchainUrl + '/broker/getAllowance/' + this.address + '/' + assetAddress);
        return new BigNumber(data.allowance);
    }

    public async getNonce(): Promise<number> {
        const data: any = await this.send(this.orionBlockchainUrl + '/broker/getNonce/' + this.address);
        return data.nonce;
    }

    public async getStakes(): Promise<string[]> {
        const data: any = await this.send(this.orionBlockchainUrl + '/stakes');
        return data;
    }

    public async getStake(): Promise<string> {
        const data: any = await this.send(this.orionBlockchainUrl + '/broker/getStake/' + this.address);
        return data.stake;
    }

    public async getTransactionStatus(transactionHash: string): Promise<'PENDING' | 'OK' | 'FAIL' | 'NONE'> {
        const data: any = await this.send(this.orionBlockchainUrl + '/broker/getTransactionStatus/' + transactionHash);
        return data.status;
    }

    private async getGasPrice(): Promise<ethers.BigNumber> { // in wei
        const data: any = await this.send('https://ethgasstation.info/api/ethgasAPI.json?' + Date.now());
        const gweiNumber = new BigNumber(data.fast).dividedBy(10);
        if (gweiNumber.gt(300)) throw new Error('gas price bigger then 300 gwei: ' + gweiNumber.toString());
        const gwei = gweiNumber.toFixed(0, BigNumber.ROUND_UP);
        return ethers.utils.parseUnits(gwei, 'gwei');
    }

    public async getLiabilities(): Promise<Liability[]> {
        const response: any[] = await this.send(this.orionBlockchainUrl + '/broker/getLiabilities/' + this.address);
        return response.map(parseLiability);
    }

    public async getContractBalance(): Promise<Dictionary<BigNumber>> {
        const data: Dictionary<string> = await this.send(this.orionBlockchainUrl + '/broker/getContractBalance/' + this.address);
        const result = {};
        for (const key in data) {
            result[key] = new BigNumber(data[key]);
        }
        return result;
    }

    public async getWalletBalance(): Promise<Dictionary<BigNumber>> {
        const data: Dictionary<string> = await this.send(this.orionBlockchainUrl + '/broker/getWalletBalance/' + this.address);
        const result = {};
        for (const key in data) {
            result[key] = new BigNumber(data[key]);
        }
        return result;
    }

    private async sendTransaction(unsignedTx: ethers.PopulatedTransaction, gasLimit: number): Promise<string> {
        unsignedTx.chainId = this.chainId;
        unsignedTx.from = this.address;
        if (!unsignedTx.to) throw new Error('no unsignedTx.to');
        unsignedTx.nonce = await this.getNonce();
        if (unsignedTx.nonce === undefined || unsignedTx.nonce === null || isNaN(Number(unsignedTx.nonce))) throw new Error('no nonce');
        unsignedTx.gasPrice = await this.getGasPrice();
        if (!unsignedTx.gasPrice.gt(0)) throw new Error('no gasPrice');
        unsignedTx.gasLimit = ethers.BigNumber.from(gasLimit);
        log.debug('tx', unsignedTx);
        const signedTxRaw: string = await this.wallet.signTransaction(unsignedTx);
        const resultRaw: any = await this.send(this.orionBlockchainUrl + '/broker/execute', 'POST', {signedTxRaw: signedTxRaw});
        return resultRaw.hash;
    }

    /**
     * @param amount    '0.123'
     */
    public async depositETH(amount: BigNumber): Promise<Transaction> {
        const value: string = Web3.utils.toWei(amount.toString());
        const unsignedTx: ethers.PopulatedTransaction = await this.exchangeContract.populateTransaction.deposit();
        unsignedTx.value = ethers.BigNumber.from(value);
        const transactionHash: string = await this.sendTransaction(unsignedTx, DEPOSIT_ETH_GAS_LIMIT);
        return {
            transactionHash,
            method: 'deposit',
            asset: 'ETH',
            amount: amount,
            createTime: Date.now(),
            status: 'PENDING'
        };
    }

    /**
     * @param amount    '0.123'
     * @param assetName "ETH"
     */
    public async depositERC20(amount: BigNumber, assetName: string): Promise<Transaction> {
        const value: string = this.numberToUnit(assetName, amount);
        const assetAddress: string = tokens.nameToAddress[assetName];
        if (assetAddress === undefined) throw new Error('no address for ' + assetName);
        const amountBN = ethers.BigNumber.from(value);
        const unsignedTx: ethers.PopulatedTransaction = await this.exchangeContract.populateTransaction.depositAsset(assetAddress, amountBN);
        const transactionHash: string = await this.sendTransaction(unsignedTx, DEPOSIT_ERC20_GAS_LIMIT);
        return {
            transactionHash,
            method: 'depositAsset',
            asset: assetName,
            amount: amount,
            createTime: Date.now(),
            status: 'PENDING'
        };
    }

    /**
     * @param amount    '0.123'
     * @param assetName "ETH"
     */
    public async withdraw(amount: BigNumber, assetName: string): Promise<Transaction> {
        const value: string = this.numberToUnit(assetName, amount);
        const assetAddress: string = tokens.nameToAddress[assetName];
        if (assetAddress === undefined) throw new Error('no address for ' + assetName);
        const amountBN = ethers.BigNumber.from(value);
        const unsignedTx: ethers.PopulatedTransaction = await this.exchangeContract.populateTransaction.withdraw(assetAddress, amountBN);
        const transactionHash: string = await this.sendTransaction(unsignedTx, DEPOSIT_ERC20_GAS_LIMIT);
        return {
            transactionHash,
            method: 'withdraw',
            asset: assetName,
            amount: amount,
            createTime: Date.now(),
            status: 'PENDING'
        };
    }

    /**
     * @param amount    '0.123'
     * @param assetName "ETH"
     */
    public async approveERC20(amount: BigNumber, assetName: string): Promise<Transaction> {
        const value: string = this.numberToUnit(assetName, amount);
        const assetAddress: string = tokens.nameToAddress[assetName];
        if (assetAddress === undefined) throw new Error('no address for ' + assetName);
        const tokenContract: ethers.Contract = new ethers.Contract(
            assetAddress,
            erc20Artifact.abi as any,
            this.wallet
        );
        const amountBN = ethers.BigNumber.from(value);
        const unsignedTx: ethers.PopulatedTransaction = await tokenContract.populateTransaction.approve(this.exchangeContractAddress, amountBN);
        const transactionHash: string = await this.sendTransaction(unsignedTx, APPROVE_ERC20_GAS_LIMIT);
        return {
            transactionHash,
            method: 'approve',
            asset: assetName,
            amount: amount,
            createTime: Date.now(),
            status: 'PENDING'
        };
    }

    /**
     * @param amount    '0.123'
     */
    public async lockStake(amount: BigNumber): Promise<Transaction> {
        const value: string = toWei8(amount);
        const amountBN = ethers.BigNumber.from(value);
        const unsignedTx: ethers.PopulatedTransaction = await this.exchangeContract.populateTransaction.lockStake(amountBN);
        const transactionHash: string = await this.sendTransaction(unsignedTx, LOCK_STAKE_GAS_LIMIT);
        return {
            transactionHash,
            method: 'lockStake',
            asset: 'ORN',
            amount: amount,
            createTime: Date.now(),
            status: 'PENDING'
        };
    }

    public async releaseStake(): Promise<Transaction> {
        const unsignedTx: ethers.PopulatedTransaction = await this.exchangeContract.populateTransaction.requestReleaseStake();
        const transactionHash: string = await this.sendTransaction(unsignedTx, RELEASE_STAKE_GAS_LIMIT);
        return {
            transactionHash,
            method: 'requestReleaseStake',
            asset: 'ORN',
            amount: new BigNumber(0),
            createTime: Date.now(),
            status: 'PENDING'
        };
    }

    private numberToUnit(currency: string, n: BigNumber): string {
        if (currency === 'ETH') {
            return Web3.utils.toWei(n.toString());
        } else {
            const decimals = tokensDecimals[currency];
            if (decimals === undefined) throw new Error('no decimals for ' + currency);
            return n.multipliedBy(Math.pow(10, decimals)).toFixed(0);
        }
    }
}
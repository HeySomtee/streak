import { ccc } from '@ckb-ccc/core';
import type { OrderOffer } from './order-wire';
export const ORDER_VERSION: 'queued-predictions-v1';
export const ORDER_PROTOCOL_HASH: string;
export const ORDER_RESERVE: bigint;
export const ORDER_MAX_FEE: bigint;
export const ORDER_STORAGE: bigint;
export interface OrderLine {marketHash:string;cutoffMs:number;outcome:0|1|2;principalShannons:string}
export function encodeOrder(owner:ccc.ScriptLike,lines:readonly OrderLine[],selectionDigest:string):{data:string;capacity:bigint;expiry:number};
export function decodeOrder(data:string):{data:string;capacity:bigint;expiry:number;owner:ccc.Script;lines:OrderLine[];selectionDigest:string};
export function orderLock(protocolHash:string,data:string):ccc.Script;
export function orderFee(tx:ccc.Transaction):bigint;
export function validateOrderOffer(value:unknown,protocolHash?:string):OrderOffer;

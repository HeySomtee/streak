import type { BatchOfferRequest } from './batch-wire';
export interface OrderScript {
  codeHash: string;
  hashType: 'data' | 'type' | 'data1' | 'data2';
  args: string;
}
export interface OrderPoint {
  txHash: string;
  index: number;
}
export interface OrderCell {
  outPoint: OrderPoint;
  cellOutput: { capacity: string; lock: OrderScript; type?: OrderScript };
  outputData: string;
}
export interface OrderMarket {
  id: string;
  fixtureId: string;
  label: string;
  cutoffMs: number;
  creationTxHash: string;
  type: { codeHash: string; hashType: 'data2'; args: string };
  termsHash: string;
  terms: {
    provider: 'football';
    providerFixtureId: string;
    source: 'api-football';
    rules: 'regulation-time-1x2-v1';
    deadlineMs: number;
  };
}
export interface OrderConfig {
  enabled: boolean;
  protocolHash: string;
  guardHash: string;
  codeDeps: { outPoint: OrderPoint; depType: 'code' }[];
  reserveShannons: string;
  maxExecutionFeeShannons: string;
  maxPendingPerWallet: number;
  markets: OrderMarket[];
  onDemandMarkets?: boolean;
  legacyFixtureIds?: string[];
  protectedLegacyFixtureIds?: string[];
  plannedFixtureIds?: string[];
  reservedFixtureIds?: string[];
}
export interface OrderRequest {
  requestId: string;
  ownerAddress: string;
  userInputs: OrderPoint[];
  picks: { fixtureId: string; termsHash: string; outcome: 0 | 1 | 2; principalShannons: string }[];
  competitionSelection?: BatchOfferRequest['competitionSelection'];
}
export interface OrderOffer {
  version: 'queued-predictions-v1';
  id: string;
  ownerAddress: string;
  ownerLock: OrderScript;
  createdAt: number;
  expiresAt: number;
  rawHash: string;
  unsignedBytes: string;
  inputs: OrderCell[];
  parents: string[];
  orderData: string;
  capacityShannons: string;
  networkFeeShannons: string;
  markets: OrderMarket[];
  competitionSelection?: BatchOfferRequest['competitionSelection'];
}
export type OrderState =
  | 'offered'
  | 'accepted'
  | 'funding'
  | 'waiting'
  | 'placing'
  | 'placed'
  | 'refunding'
  | 'refunded'
  | 'attention'
  | 'failed'
  | 'cancelled';
export interface OrderRecord {
  offer: OrderOffer;
  state: OrderState;
  signedBytes?: string;
  acceptedAt?: number;
  executionBytes?: string;
  executionKind?: 'admit' | 'refund';
  executionHistory?: { bytes: string; kind: 'admit' | 'refund' }[];
  conflictHash?: string;
  message?: string;
  observationRevision?: number;
  conflictSearch?: Record<string, { lock: number; cursor?: string }>;
}
export interface OrderStatus {
  offer: OrderOffer;
  state: OrderState;
  acceptedAt?: number;
  fundingHash: string;
  executionHash?: string;
  message: string;
}

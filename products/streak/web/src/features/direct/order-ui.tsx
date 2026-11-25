import { useEffect, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BatchCheckout } from './batch-ui';
import {
  getOrderConfig,
  OrderClient,
  orderWallet,
  supportsOrderPayments,
  type SavedOrder,
} from './order-client';
import type { OrderConfig, OrderOffer, OrderStatus } from '../../../../shared/order-wire';
import { ORDER_RESERVE, ORDER_STORAGE, decodeOrder } from '../../../../shared/order-codec.mjs';
import { displayShannons, totalShannons, type Pick } from '../predictions/draft';
import {
  getWalletState,
  subscribeWallet,
  assertActiveWallet,
  assertWalletAccount,
  chooseWallet,
} from '../../lib/wallet';
import { PaymentProgress, PaymentButtonState, type PaymentPresentation } from './payment-progress';
import { Notice } from '../../components/notice';
import { useNow } from '../../lib/use-now';
import './order-ui.css';
import { usePaymentDismissal } from './use-payment-dismissal';
type Props = ComponentProps<typeof BatchCheckout>;
const money = (n: string | bigint) => `${displayShannons(n)} tCKB`;
const terminal = (s: OrderStatus) =>
  ['placed', 'refunded', 'failed', 'cancelled'].includes(s.state);
export function PaymentCheckout(props: Props) {
  const snapshot = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
  const [batchProgress, setBatchProgress] = useState<PaymentPresentation | null>(null);
  const [orderProgress, setOrderProgress] = useState<PaymentPresentation | null>(null);
  const showOrder =
    !!orderProgress &&
    (!batchProgress ||
      Number(orderProgress.pending) > Number(batchProgress.pending) ||
      (orderProgress.pending === batchProgress.pending &&
        orderProgress.createdAt >= batchProgress.createdAt));
  const config = useQuery({
    queryKey: ['order-config'],
    queryFn: ({ signal }) => getOrderConfig(signal),
    staleTime: 30_000,
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.plannedFixtureIds?.some(
        (id) =>
          snapshot.draft.picks.some((p) => p.matchId === id) &&
          !q.state.data?.markets.some((m) => m.fixtureId === id),
      )
        ? 10_000
        : false,
    refetchIntervalInBackground: false,
  });
  const queued = config.data;
  const matching =
    queued &&
    snapshot.draft.picks.filter((p) => queued.markets.some((m) => m.fixtureId === p.matchId))
      .length;
  const missing = (id: string) =>
    snapshot.draft.picks.some((p) => p.matchId === id) &&
    !queued?.markets.some((m) => m.fixtureId === id);
  const opening = queued?.plannedFixtureIds?.some(missing);
  const reserved = queued?.reservedFixtureIds?.some(missing);
  const ready = !config.isPending && !config.isError;
  const earlier = snapshot.draft.picks.filter((p) =>
    queued?.legacyFixtureIds?.includes(p.matchId),
  ).length;
  const orderOnly =
    ready &&
    !!queued &&
    (queued.onDemandMarkets
      ? earlier === 0
      : !snapshot.draft.picks.length || matching === snapshot.draft.picks.length);
  const legacyEnabled =
    ready &&
    !orderOnly &&
    (queued?.onDemandMarkets
      ? earlier === snapshot.draft.picks.length
      : !opening && !reserved && !matching);
  return (
    <>
      {queued && (
        <OrderCheckout
          {...props}
          config={queued}
          checkoutEnabled={orderOnly}
          onProgress={setOrderProgress}
          progressVisible={showOrder}
        />
      )}
      <BatchCheckout
        {...props}
        checkoutEnabled={legacyEnabled}
        onProgress={setBatchProgress}
        progressVisible={!showOrder}
      />
      {config.isPending ? (
        <PaymentButtonState label="Checking payment options" />
      ) : config.isError ? (
        <Notice title="Your picks are saved" tone="attention">
          <p>{config.error.message}</p>
          <button className="quiet" onClick={() => void config.refetch()}>
            Retry payment options
          </button>
        </Notice>
      ) : !orderOnly && (opening || reserved) ? (
        <Notice
          title={
            opening ? "This competition's markets are opening" : 'Market setup is not finished'
          }
          tone="info"
        >
          <p>
            {opening
              ? 'Your picks are saved. Market setup is still confirming. Once open, you can sign a payment and leave Streak to process it.'
              : 'Your picks are saved. The organizer needs to finish opening this market before payment is available.'}
          </p>
          <button className="quiet" onClick={() => void config.refetch()}>
            Check market setup
          </button>
        </Notice>
      ) : !orderOnly && (matching || (queued?.onDemandMarkets && !legacyEnabled)) ? (
        <Notice title="Keep these payment versions in separate slips" tone="attention">
          Some picks use an earlier market. Pay those in a separate slip; each payment keeps its
          original settlement rules.
        </Notice>
      ) : null}
    </>
  );
}

export function OrderCheckout(props: Props & { config: OrderConfig; checkoutEnabled?: boolean }) {
  const { store, account, active, onBusy, config, checkoutEnabled = true } = props;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot),
    wallet = useSyncExternalStore(subscribeWallet, getWalletState);
  const connection = wallet.connection,
    identity = `${account?.id ?? 'guest'}:${wallet.revision}`;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const stamp = JSON.stringify(snapshot.draft),
    stampRef = useRef(stamp);
  stampRef.current = stamp;
  const [review, setReview] = useState<{
    offer: OrderOffer;
    picks: Pick[];
    stamp: string;
    identity: string;
  } | null>(null);
  const [step, setStep] = useState('Preparing your payment');
  const queryClient = useQueryClient(),
    now = useNow(active);
  const client = connection ? new OrderClient(connection.signer, config) : null;
  const history = useQuery({
    queryKey: ['direct-private', account?.id, 'orders'],
    queryFn: () => orderWallet(),
    enabled: !!account && props.accountReady,
    retry: false,
    refetchInterval: (q) => (q.state.data?.orders.some((s) => !terminal(s)) ? 10_000 : false),
    refetchIntervalInBackground: false,
  });
  const local = useQuery({
    queryKey: ['direct-private', identity, 'local-orders'],
    queryFn: () => client!.history(),
    enabled: !!client && !!account,
    retry: false,
  });
  async function assertIdentity(key: string) {
    if (identityRef.current !== key || !connection || !account)
      throw Error('Your wallet changed. Return to the original wallet to finish this payment.');
    await assertActiveWallet(connection);
    await assertWalletAccount(connection, account.walletAddress);
  }
  const prepare = useMutation({
    mutationFn: async () => {
      if (!client || !account) throw Error('Sign in to review your payment.');
      const key = identity,
        version = stamp,
        picks = structuredClone(snapshot.draft.picks);
      await assertIdentity(key);
      setStep('Preparing your payment');
      const offer = await client.prepare(picks, account.id);
      await assertIdentity(key);
      if (stampRef.current !== version) throw Error('Your picks changed. Review the updated slip.');
      setReview({ offer, picks, stamp: version, identity: key });
    },
    retry: false,
  });
  const submit = useMutation({
    mutationFn: async (saved?: SavedOrder) => {
      if (!client) throw Error('Reconnect your wallet to continue.');
      const key = identity;
      await assertIdentity(key);
      let row = saved;
      if (!row) {
        if (!review || review.identity !== key || review.stamp !== stampRef.current)
          throw Error('Review the updated slip first.');
        setStep('Approve in your wallet');
        row = await client.sign(review.offer, review.picks, () => assertIdentity(key));
      }
      setStep('Saving your signed payment');
      const result = await client.submit(row);
      if (identityRef.current === key) {
        store.retireSubmitted(row.sourcePicks);
        setReview(null);
      }
      return result;
    },
    retry: false,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['direct-private', account?.id, 'orders'] });
      void queryClient.invalidateQueries({
        queryKey: ['direct-private', identity, 'local-orders'],
      });
    },
  });
  const connect = useMutation({ mutationFn: chooseWallet, retry: false });
  const cancel = useMutation({
    mutationFn: async (row?: SavedOrder) => {
      const offer = row?.offer ?? review?.offer;
      if (!offer || !client) return;
      await client.cancel(offer, row);
      setReview(null);
    },
    retry: false,
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ['direct-private', identity, 'local-orders'],
      });
    },
  });
  const working = prepare.isPending || submit.isPending || cancel.isPending;
  useEffect(() => {
    if (!checkoutEnabled) return;
    onBusy(working);
    return () => onBusy(false);
  }, [working, onBusy, checkoutEnabled]);
  const visibleReview = review?.identity === identity && review.stamp === stamp ? review : null;
  const orders = history.data?.orders ?? [],
    pending = orders.filter((s) => !terminal(s));
  const progressOrder = pending[0] ?? orders[0];
  const progressKey = progressOrder?.offer.id;
  const progressCreatedAt = progressOrder?.offer.createdAt ?? 0;
  const hasPending = pending.length > 0;
  const { dismissed: progressDismissed, dismiss: dismissProgress } = usePaymentDismissal(
    account?.id ?? 'guest',
    `order:${progressKey ?? ''}`,
    progressOrder?.state ?? '',
    hasPending,
  );
  const { onProgress } = props;
  useEffect(() => {
    onProgress?.(
      progressKey && !progressDismissed
        ? { key: progressKey, pending: hasPending, createdAt: progressCreatedAt }
        : null,
    );
  }, [onProgress, progressKey, hasPending, progressCreatedAt, progressDismissed]);
  useEffect(() => () => onProgress?.(null), [onProgress]);
  const unsent = (local.data ?? []).filter(
    (r) =>
      r.status !== 'discarded' &&
      !orders.some((s) => s.fundingHash === r.hash && s.state !== 'offered'),
  );
  useEffect(() => {
    for (const row of local.data ?? [])
      if (
        history.data?.orders.some(
          (s) => s.fundingHash === row.hash && s.state !== 'offered' && s.state !== 'cancelled',
        )
      )
        store.retireSubmitted(row.sourcePicks);
  }, [history.data, local.data, store]);
  const records = (
    <div className="order-history">
      {unsent.map((row) => (
        <article key={row.hash}>
          <strong>Finish saving your signed payment</strong>
          <p>
            The server has not acknowledged this payment yet. Retry sends the same authorization.
          </p>
          <button
            className="quiet"
            disabled={working}
            onClick={() => (now >= row.offer.expiresAt ? cancel.mutate(row) : submit.mutate(row))}
          >
            {now >= row.offer.expiresAt ? 'Release expired review' : 'Retry saving payment'}
          </button>
        </article>
      ))}
      {orders.map((order) => (
        <article key={order.offer.id}>
          <div className="order-history-heading">
            <strong>
              {order.offer.markets.length}{' '}
              {order.offer.markets.length === 1 ? 'prediction' : 'predictions'}
            </strong>
            <small>
              {order.state === 'placed'
                ? 'On-chain'
                : order.state === 'refunded'
                  ? 'Refunded'
                  : order.state === 'failed'
                    ? 'Not funded'
                    : 'Processing'}
            </small>
          </div>
          <p>{order.message}</p>
          <ul>
            {order.offer.markets.map((market, i) => (
              <li key={market.id}>
                <span>{market.label}</span>
                <small>
                  {['Home', 'Draw', 'Away'][decodeOrder(order.offer.orderData).lines[i].outcome]}
                </small>
              </li>
            ))}
          </ul>
          <a
            href={`https://pudge.explorer.nervos.org/transaction/${order.executionHash ?? order.fundingHash}`}
            target="_blank"
            rel="noreferrer"
          >
            View {order.executionHash ? 'execution' : 'funding'} transaction
          </a>
        </article>
      ))}
    </div>
  );
  const principal = totalShannons(snapshot.draft.picks),
    storage = ORDER_STORAGE * BigInt(snapshot.draft.picks.length);
  const error = prepare.error ?? submit.error ?? connect.error ?? cancel.error;
  return (
    <>
      {props.activityTarget && createPortal(records, props.activityTarget)}
      {orders.length > 0 && (
        <PaymentProgress
          suppressed={props.progressVisible === false || progressDismissed}
          inlineTarget={props.feedbackTarget}
          stage={
            pending.length ? 'queued' : orders[0]?.state === 'placed' ? 'confirmed' : 'resolved'
          }
          count={
            pending.reduce((n, s) => n + s.offer.markets.length, 0) ||
            orders[0].offer.markets.length
          }
          hidden={active}
          onDismiss={dismissProgress}
          operationKey={progressKey ?? ''}
          terminal={!pending.length}
          onOpen={() => {
            props.onOpen?.();
            props.onActivity?.();
          }}
        >
          {records}
        </PaymentProgress>
      )}
      {!checkoutEnabled && pending.length > 0 && (
        <p className="batch-hint">
          {pending.length} queued payments continue processing. See Activity in this slip for their
          status.
        </p>
      )}
      {checkoutEnabled && snapshot.draft.picks.length > 0 && (
        <>
          <dl className="order-total">
            <div>
              <dt>Stakes</dt>
              <dd>{principal === null ? 'Check amounts' : money(principal)}</dd>
            </div>
            <div>
              <dt>Refundable storage</dt>
              <dd>{money(storage)}</dd>
            </div>
            <div>
              <dt>Refundable queue reserve</dt>
              <dd>{money(ORDER_RESERVE)}</dd>
            </div>
            <div className="order-total-final">
              <dt>Wallet total</dt>
              <dd>
                {visibleReview
                  ? money(
                      BigInt(visibleReview.offer.capacityShannons) +
                        BigInt(visibleReview.offer.networkFeeShannons),
                    )
                  : principal === null
                    ? ''
                    : money(principal + storage + ORDER_RESERVE)}
              </dd>
            </div>
          </dl>
          <p className="batch-hint">
            Queue reserve returns after placement or refund, less a network fee capped at 1 tCKB.{' '}
            {visibleReview ? '' : 'Final network fee at review.'}
          </p>
          {!account ? (
            <button
              className="review-button"
              disabled={props.signInPending || !props.accountReady}
              onClick={props.onSignIn}
            >
              {props.signInPending ? (
                <PaymentButtonState label={props.signInStage ?? 'Signing in'} />
              ) : (
                'Sign in to continue'
              )}
            </button>
          ) : !connection ? (
            <button
              className="review-button"
              onClick={() => connect.mutate()}
              disabled={connect.isPending}
            >
              Reconnect wallet
            </button>
          ) : !supportsOrderPayments(connection.signer) ? (
            <Notice title="Choose a wallet for predictions" tone="attention">
              This wallet can sign in, but its payment format is not supported yet. Use MetaMask,
              Zerion or a supported native CKB wallet for predictions. Your picks are saved. Switch
              accounts in <a href="/season/?view=account">My Account</a> to continue. No payment was
              sent.
            </Notice>
          ) : visibleReview ? (
            <div className="batch-review">
              <h3>Approve once. We handle the rest.</h3>
              <p className="batch-hint">
                Your exact picks will be placed when a lane is free. If the slip cannot enter before
                kickoff, it is refunded. Queue acceptance is not market entry.
              </p>
              <ul className="batch-entry-review">
                {visibleReview.picks.map((p, i) => (
                  <li key={p.lineId}>
                    <span>{visibleReview.offer.markets[i].label}</span>
                    <small>
                      {p.competition?.ids
                        .map(
                          (id) =>
                            props.campaigns?.find((c) => c.id === id)?.name ??
                            'Selected competition',
                        )
                        .join(', ') || 'Regular prediction'}
                    </small>
                  </li>
                ))}
              </ul>
              <button
                className="review-button"
                disabled={working || now >= visibleReview.offer.expiresAt}
                onClick={() => submit.mutate(undefined)}
              >
                {working ? (
                  <PaymentButtonState label={step} />
                ) : now >= visibleReview.offer.expiresAt ? (
                  'Review expired'
                ) : (
                  `Approve ${money(BigInt(visibleReview.offer.capacityShannons) + BigInt(visibleReview.offer.networkFeeShannons))}`
                )}
              </button>
              <button className="quiet" disabled={working} onClick={() => cancel.mutate(undefined)}>
                Back to picks
              </button>
            </div>
          ) : (
            <button
              className="review-button"
              disabled={
                working ||
                snapshot.blocked ||
                snapshot.conflict ||
                principal === null ||
                pending.length >= 3 ||
                unsent.length > 0 ||
                history.isError ||
                history.isPending
              }
              onClick={() => prepare.mutate()}
            >
              {working ? (
                <PaymentButtonState label={step} />
              ) : pending.length >= 3 ? (
                'Three payments processing'
              ) : (
                'Review payment'
              )}
            </button>
          )}
          {pending.length > 0 && (
            <p className="batch-hint">
              {pending.length} payment{pending.length === 1 ? '' : 's'} processing. You can prepare
              your next picks.
            </p>
          )}
        </>
      )}
      {error && (
        <Notice title="Your picks are saved" tone="attention">
          {error.message}
        </Notice>
      )}
      {history.isError && (
        <Notice title="Payment history could not be checked" tone="attention">
          <button className="quiet" onClick={() => void history.refetch()}>
            Retry saved payments
          </button>
        </Notice>
      )}
      {!snapshot.draft.picks.length && orders.length > 0 && (
        <p className="batch-hint">
          Your signed payments are saved. Add more matches to start another slip.
        </p>
      )}
    </>
  );
}

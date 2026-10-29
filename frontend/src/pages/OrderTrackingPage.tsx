import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { OrderResponse, OrderView, TimelineItem } from '../types';
import { ApiError, fetchOrder, orderEventsUrl } from '../services/api';
import { cx, formatDateTime, formatInr, formatNumber } from '../services/format';
import {
  AlertIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  RefreshIcon,
  ShieldIcon,
  TruckIcon,
  XIcon,
} from '../components/Icons';
import {
  CopyButton,
  ErrorNotice,
  Eyebrow,
  OrderStatusPill,
  Panel,
  Skeleton,
  StatusDot,
} from '../components/ui';

type LiveMode = 'connecting' | 'sse' | 'polling' | 'closed';

const timelineTone: Record<TimelineItem['state'], string> = {
  complete: 'border-volt-400/30 bg-volt-400/15 text-volt-300',
  active: 'border-amber-300/30 bg-amber-300/15 text-amber-200',
  pending: 'border-white/10 bg-white/[0.04] text-white/30',
  failed: 'border-red-400/30 bg-red-400/15 text-red-300',
};

export function OrderTrackingPage() {
  const { orderId = '' } = useParams();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [terminal, setTerminal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; status: number } | null>(null);
  const [mode, setMode] = useState<LiveMode>('connecting');
  const [refreshing, setRefreshing] = useState(false);
  const orderRef = useRef<OrderView | null>(null);
  const terminalRef = useRef(false);

  const apply = useCallback((next: OrderView, isTerminal: boolean) => {
    orderRef.current = next;
    terminalRef.current = isTerminal;
    setOrder(next);
    setTerminal(isTerminal);
    if (isTerminal) setMode('closed');
  }, []);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 7000);
      try {
        const response = await fetchOrder(orderId, controller.signal);
        apply(response.order, response.terminal);
        setError(null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        if (caught instanceof ApiError) {
          setError({ message: caught.message, status: caught.status });
        } else {
          setError({ message: 'The order could not be loaded.', status: 0 });
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
        window.clearTimeout(timeout);
      }
    },
    [apply, orderId],
  );

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    let pollTimer: number | null = null;

    const startPolling = () => {
      if (cancelled || terminalRef.current) return;
      setMode('polling');
      pollTimer = window.setInterval(async () => {
        if (cancelled || terminalRef.current) {
          if (pollTimer) window.clearInterval(pollTimer);
          return;
        }
        try {
          const response = await fetchOrder(orderId);
          if (cancelled) return;
          apply(response.order, response.terminal);
          if (response.terminal && pollTimer) window.clearInterval(pollTimer);
        } catch {
          // Retain the last durable snapshot; the next tick retries.
        }
      }, 1500);
    };

    const boot = async () => {
      setLoading(true);
      await load(true);
      if (cancelled || terminalRef.current) return;
      if (typeof window !== 'undefined' && 'EventSource' in window) {
        try {
          source = new EventSource(orderEventsUrl(orderId));
          source.onopen = () => {
            if (!cancelled) setMode('sse');
          };
          source.addEventListener('order', (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent).data) as OrderResponse;
              if (!cancelled) apply(payload.order, payload.terminal);
            } catch {
              // Ignore malformed event; polling remains the safety net.
            }
          });
          source.addEventListener('done', () => {
            source?.close();
            setMode('closed');
          });
          source.onerror = () => {
            source?.close();
            source = null;
            startPolling();
          };
        } catch {
          startPolling();
        }
      } else {
        startPolling();
      }
    };

    void boot();

    return () => {
      cancelled = true;
      source?.close();
      if (pollTimer) window.clearInterval(pollTimer);
    };
  }, [apply, load, orderId]);

  if (loading && !order) {
    return <TrackingSkeleton />;
  }

  if (!order) {
    return (
      <main className="mx-auto flex min-h-[65vh] max-w-2xl items-center px-4 py-16">
        <Panel className="w-full p-8 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-red-400/20 bg-red-400/10 text-red-300">
            <AlertIcon size={22} />
          </div>
          <h1 className="mt-5 text-2xl font-semibold text-white">
            {error?.status === 404 ? 'Order not found' : 'Unable to load this order'}
          </h1>
          <p className="mt-2 text-sm leading-6 text-white/45">
            {error?.status === 404
              ? 'This order ID does not exist in the durable order store. Check the link or return to the storefront.'
              : error?.message ?? 'The tracking service is temporarily unavailable.'}
          </p>
          <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
            {error?.status !== 404 ? (
              <button
                type="button"
                onClick={() => void load(false)}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-ember-500 px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-ember-400"
              >
                <RefreshIcon size={15} /> Retry
              </button>
            ) : null}
            <Link
              to="/"
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 px-4 py-2.5 text-sm font-medium text-white/70 transition hover:bg-white/5 hover:text-white"
            >
              <ArrowLeftIcon size={15} /> Back to storefront
            </Link>
          </div>
        </Panel>
      </main>
    );
  }

  const pending = order.status === 'PENDING';
  const failed = order.status === 'FAILED';

  return (
    <main className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className={cx(
          'pointer-events-none absolute inset-x-0 top-0 h-[520px]',
          failed
            ? 'bg-[radial-gradient(ellipse_at_50%_0%,rgba(248,113,113,0.12),transparent_60%)]'
            : pending
              ? 'bg-[radial-gradient(ellipse_at_50%_0%,rgba(251,191,36,0.1),transparent_60%)]'
              : 'bg-[radial-gradient(ellipse_at_50%_0%,rgba(192,245,106,0.1),transparent_60%)]',
        )}
      />
      <div className="relative mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            to="/"
            className="inline-flex items-center gap-2 rounded-lg text-sm font-medium text-white/50 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-400/60"
          >
            <ArrowLeftIcon size={15} /> Back to storefront
          </Link>
          <div className="flex items-center gap-2">
            {terminal ? (
              <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-white/40">
                <StatusDot tone="muted" /> Updates complete
              </span>
            ) : (
              <span
                data-testid="tracking-live"
                className="inline-flex items-center gap-2 rounded-full border border-volt-400/20 bg-volt-400/[0.07] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-volt-300"
              >
                <StatusDot pulse /> {mode === 'sse' ? 'Live stream' : mode === 'polling' ? 'Live polling' : 'Connecting'}
              </span>
            )}
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={refreshing}
              aria-label="Refresh order status"
              className="rounded-lg border border-white/10 p-2 text-white/40 transition hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-400/60 disabled:opacity-40"
            >
              <RefreshIcon size={14} className={refreshing ? 'animate-spin' : undefined} />
            </button>
          </div>
        </div>

        <section className="mt-6 animate-fade-up">
          <Panel className="overflow-hidden">
            <div className="grid gap-6 p-6 sm:grid-cols-[1fr_auto] sm:items-center sm:p-8">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <OrderStatusPill status={order.status} pulse={pending} />
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/30">
                    Order tracking
                  </span>
                </div>
                <h1 className="mt-4 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                  {failed
                    ? 'This order could not be completed.'
                    : order.status === 'CONFIRMED'
                      ? 'Order confirmed. You’re in.'
                      : 'Securing your order.'}
                </h1>
                <p className="mt-2 max-w-xl text-sm leading-6 text-white/45">
                  {failed
                    ? order.failureReason ?? 'The reservation was released. No unit was sold.'
                    : order.status === 'CONFIRMED'
                      ? 'The worker moved your reservation into the durable sold ledger. This order is final.'
                      : 'Your reservation is durable. A queue worker is completing the order — this page updates automatically and stops when the order is final.'}
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px] text-white/35">
                    {order.id.slice(0, 8)}…{order.id.slice(-4)}
                  </span>
                  <CopyButton value={order.id} label="Copy order ID" />
                  <span className="text-white/15">·</span>
                  <span className="text-xs text-white/35">Placed {formatDateTime(order.createdAt)}</span>
                </div>
              </div>
              <div
                className={cx(
                  'relative mx-auto grid h-24 w-24 shrink-0 place-items-center rounded-full border sm:mx-0',
                  failed
                    ? 'border-red-400/20 bg-red-400/[0.07] text-red-300'
                    : order.status === 'CONFIRMED'
                      ? 'border-volt-400/25 bg-volt-400/[0.07] text-volt-300'
                      : 'border-amber-300/20 bg-amber-300/[0.06] text-amber-200',
                )}
              >
                {pending ? (
                  <>
                    <span className="absolute inset-2 animate-ping rounded-full border border-amber-300/20" />
                    <span className="h-8 w-8 animate-spin rounded-full border-2 border-amber-200/20 border-t-amber-200" />
                  </>
                ) : failed ? (
                  <XIcon size={34} />
                ) : (
                  <CheckIcon size={38} />
                )}
              </div>
            </div>
            <div
              className={cx(
                'flex flex-wrap items-center justify-between gap-3 border-t px-6 py-3 text-xs sm:px-8',
                failed
                  ? 'border-red-400/10 bg-red-400/[0.03] text-red-200/60'
                  : 'border-white/[0.06] bg-white/[0.02] text-white/40',
              )}
            >
              <span className="flex items-center gap-2">
                <ShieldIcon size={13} />
                {failed
                  ? 'Reservation released · no unit consumed'
                  : order.status === 'CONFIRMED'
                    ? 'Durable ledger updated · sold unit recorded'
                    : 'Reservation held in PostgreSQL · processing queued'}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em]">
                Last update {formatDateTime(order.updatedAt)}
              </span>
            </div>
          </Panel>
        </section>

        {error ? (
          <div className="mt-4">
            <ErrorNotice
              title="Live update issue"
              message={`${error.message} Showing the last confirmed status.`}
              onRetry={() => void load(true)}
              compact
            />
          </div>
        ) : null}

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1.25fr_0.75fr]">
          <Panel className="p-6">
            <Eyebrow>Progress</Eyebrow>
            <ol className="mt-5 space-y-0" aria-label="Order progress">
              {order.timeline.map((item, index) => {
                const isLast = index === order.timeline.length - 1;
                return (
                  <li key={item.key} className="relative flex gap-4 pb-7 last:pb-0">
                    {!isLast ? (
                      <span
                        aria-hidden="true"
                        className={cx(
                          'absolute left-[15px] top-8 h-[calc(100%-24px)] w-px',
                          item.state === 'complete' ? 'bg-volt-400/25' : 'bg-white/10',
                        )}
                      />
                    ) : null}
                    <span
                      className={cx(
                        'relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full border',
                        timelineTone[item.state],
                      )}
                    >
                      {item.state === 'complete' ? (
                        <CheckIcon size={14} />
                      ) : item.state === 'failed' ? (
                        <XIcon size={14} />
                      ) : item.state === 'active' ? (
                        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-current" />
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-current" />
                      )}
                    </span>
                    <div className="min-w-0 pt-0.5">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p
                          className={cx(
                            'text-sm font-medium',
                            item.state === 'pending' ? 'text-white/35' : 'text-white',
                          )}
                        >
                          {item.label}
                        </p>
                        <span className="font-mono text-[10px] tabular-nums text-white/30">
                          {item.at ? formatDateTime(item.at) : item.state === 'active' ? 'In progress' : 'Waiting'}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-white/40">{item.description}</p>
                    </div>
                  </li>
                );
              })}
            </ol>

            <div className="mt-6 grid grid-cols-2 gap-3 border-t border-white/[0.06] pt-5">
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/30">Reservation</p>
                <p className="mt-1 text-sm text-white/75">{order.reservationStatus}</p>
              </div>
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/30">Reservation expiry</p>
                <p className="mt-1 text-sm text-white/75">{formatDateTime(order.reservationExpiresAt)}</p>
              </div>
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/30">Customer</p>
                <p className="mt-1 text-sm text-white/75">{order.customer.name}</p>
              </div>
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/30">Email</p>
                <p className="mt-1 text-sm text-white/75">{order.customer.email}</p>
              </div>
            </div>
          </Panel>

          <div className="space-y-6">
            <Panel className="overflow-hidden">
              <div className="relative aspect-[4/3] overflow-hidden bg-gradient-to-br from-ink-800 to-ink-900">
                <div
                  aria-hidden="true"
                  className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(255,100,51,0.18),transparent_55%)]"
                />
                <img
                  src={order.product.imageUrl}
                  alt={order.product.name}
                  className="absolute left-1/2 top-1/2 h-[85%] w-auto -translate-x-1/2 -translate-y-1/2 object-contain drop-shadow-2xl"
                />
              </div>
              <div className="p-5">
                <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/30">
                  {order.product.sku}
                </p>
                <h2 className="mt-1.5 text-base font-semibold text-white">{order.product.name}</h2>
                <p className="mt-1 text-xs text-white/40">{order.product.tagline}</p>
                <dl className="mt-4 space-y-2 border-t border-white/[0.06] pt-4 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-white/35">Quantity</dt>
                    <dd className="text-white/75">{formatNumber(order.quantity)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-white/35">Unit price</dt>
                    <dd className="text-white/75">{formatInr(order.unitPriceInr)}</dd>
                  </div>
                  <div className="flex justify-between gap-3 border-t border-white/[0.06] pt-2">
                    <dt className="text-white/35">Total</dt>
                    <dd className="font-semibold text-white">{formatInr(order.totalPriceInr)}</dd>
                  </div>
                </dl>
              </div>
            </Panel>

            <Panel className="p-5">
              <div className="flex items-center gap-2">
                <ClockIcon size={15} className="text-white/40" />
                <p className="text-sm font-medium text-white">What happens next?</p>
              </div>
              <ul className="mt-3 space-y-2.5 text-xs leading-5 text-white/40">
                <li className="flex gap-2">
                  <TruckIcon size={13} className="mt-0.5 shrink-0 text-white/25" />
                  A tracking link is safe to refresh. Terminal orders stop live updates.
                </li>
                <li className="flex gap-2">
                  <ShieldIcon size={13} className="mt-0.5 shrink-0 text-white/25" />
                  Your email and address are masked here; full details never leave the backend.
                </li>
                <li className="flex gap-2">
                  <CopyIcon size={13} className="mt-0.5 shrink-0 text-white/25" />
                  Keep this order ID for support: <span className="font-mono">{order.id.slice(0, 8)}…</span>
                </li>
              </ul>
              <Link
                to="/system-monitor"
                className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-ember-300 transition hover:text-ember-200"
              >
                See this order in the system monitor <ArrowRightIcon size={13} />
              </Link>
            </Panel>
          </div>
        </div>
      </div>
    </main>
  );
}

function TrackingSkeleton() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="mt-6 h-56 w-full rounded-2xl" />
      <div className="mt-6 grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
        <Skeleton className="h-96 rounded-2xl" />
        <Skeleton className="h-96 rounded-2xl" />
      </div>
    </main>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CheckoutResponse, FlashSaleResponse } from '../types';
import { ApiError, fetchFlashSale } from '../services/api';
import { cx, formatInr, formatNumber, formatTime } from '../services/format';
import { CheckoutModal } from '../components/CheckoutModal';
import {
  ActivityIcon,
  ArrowRightIcon,
  BagIcon,
  BatteryIcon,
  BoltIcon,
  CameraIcon,
  CheckIcon,
  CpuIcon,
  DatabaseIcon,
  LayersIcon,
  LockIcon,
  RefreshIcon,
  ScreenIcon,
  ShieldIcon,
  TruckIcon,
} from '../components/Icons';
import {
  ErrorNotice,
  Eyebrow,
  InlineLink,
  LivePill,
  OrderStatusPill,
  Panel,
  SectionHeading,
  Skeleton,
} from '../components/ui';

type LoadState = 'loading' | 'ready' | 'error';

const specCards = [
  { key: 'display', label: 'Display', icon: ScreenIcon },
  { key: 'processor', label: 'Performance', icon: CpuIcon },
  { key: 'camera', label: 'Camera', icon: CameraIcon },
  { key: 'battery', label: 'Battery', icon: BatteryIcon },
  { key: 'storage', label: 'Storage', icon: DatabaseIcon },
  { key: 'security', label: 'Security', icon: ShieldIcon },
] as const;

export function StorefrontPage() {
  const [data, setData] = useState<FlashSaleResponse | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [lastOrder, setLastOrder] = useState<CheckoutResponse | null>(null);
  const [stockPulse, setStockPulse] = useState(false);
  const mounted = useRef(true);
  const refreshTimer = useRef<number | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetchFlashSale(controller.signal);
      if (!mounted.current) return;
      setData((current) => {
        if (current && current.inventory.availableStock !== response.inventory.availableStock) {
          setStockPulse(true);
          window.setTimeout(() => setStockPulse(false), 900);
        }
        return response;
      });
      setState('ready');
      setError(null);
    } catch (caught) {
      if (!mounted.current) return;
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      const message =
        caught instanceof ApiError
          ? caught.message
          : 'The storefront could not load live inventory.';
      setError(message);
      setState((current) => (current === 'ready' ? 'ready' : 'error'));
    } finally {
      if (mounted.current) setRefreshing(false);
      window.clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load(false);
    const interval = window.setInterval(() => void load(true), 5000);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [load]);

  const closeCheckout = useCallback(() => setCheckoutOpen(false), []);

  const handleCompleted = useCallback(
    (response: CheckoutResponse) => {
      setLastOrder(response);
      setData((current) => {
        if (!current) return current;
        return {
          ...current,
          inventory: {
            ...current.inventory,
            availableStock:
              response.remainingStock ?? Math.max(0, current.inventory.availableStock - 1),
            activeReservations: current.inventory.activeReservations + 1,
          },
          sale: {
            ...current.sale,
            claimedUnits: current.sale.claimedUnits + 1,
            percentClaimed: Math.min(
              100,
              Math.round(
                ((current.sale.claimedUnits + 1) / Math.max(1, current.sale.totalUnits)) * 100,
              ),
            ),
          },
        };
      });
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => void load(true), 800);
    },
    [load],
  );

  const handleSoldOut = useCallback(() => {
    setData((current) =>
      current
        ? {
            ...current,
            inventory: { ...current.inventory, availableStock: 0, admissionStock: 0 },
            sale: { ...current.sale, status: 'SOLD_OUT', claimedUnits: current.sale.totalUnits, percentClaimed: 100 },
          }
        : current,
    );
    window.setTimeout(() => void load(true), 400);
  }, [load]);

  if (state === 'loading' && !data) {
    return <StorefrontSkeleton />;
  }

  if (state === 'error' && !data) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-3xl items-center px-4 py-20">
        <Panel className="w-full p-8">
          <Eyebrow>Connection issue</Eyebrow>
          <h1 className="mt-3 text-2xl font-semibold text-white">Live inventory is unavailable</h1>
          <p className="mt-2 text-sm text-white/50">
            The storefront only displays real stock from the backend. It will not guess or simulate
            availability.
          </p>
          <div className="mt-5">
            <ErrorNotice message={error ?? 'Unknown error'} onRetry={() => void load(false)} />
          </div>
        </Panel>
      </main>
    );
  }

  if (!data) return null;

  const { product, inventory, sale } = data;
  const soldOut = sale.status === 'SOLD_OUT' || inventory.availableStock <= 0;
  const claimed = inventory.initialStock - inventory.availableStock;
  const percentClaimed =
    inventory.initialStock === 0
      ? 100
      : Math.min(100, Math.round((claimed / inventory.initialStock) * 100));
  const discount = Math.round(
    ((product.originalPriceInr - product.priceInr) / product.originalPriceInr) * 100,
  );
  const stockLow = inventory.availableStock > 0 && inventory.availableStock <= 50;

  return (
    <main className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[760px] bg-[radial-gradient(ellipse_at_65%_10%,rgba(255,100,51,0.16),transparent_55%),radial-gradient(ellipse_at_15%_30%,rgba(192,245,106,0.05),transparent_45%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:linear-gradient(to_bottom,black,transparent_70%)]"
      />

      <div className="relative mx-auto max-w-7xl px-4 pb-10 pt-8 sm:px-6 lg:px-8 lg:pt-12">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <LivePill label={soldOut ? 'Drop closed' : 'Drop live'} />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/30">
              Drop 001 / Aether X1 Pro
            </span>
          </div>
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-white/35 transition hover:bg-white/5 hover:text-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-400/60 disabled:opacity-40"
            aria-label="Refresh live inventory"
          >
            <RefreshIcon size={12} className={refreshing ? 'animate-spin' : undefined} />
            {refreshing ? 'Refreshing' : `Synced ${formatTime(inventory.generatedAt)}`}
          </button>
        </div>

        {error ? (
          <div className="mt-4">
            <ErrorNotice
              title="Live refresh failed"
              message={`${error} Showing the last real inventory snapshot.`}
              onRetry={() => void load(true)}
              compact
            />
          </div>
        ) : null}

        {lastOrder ? (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-volt-400/20 bg-volt-400/[0.05] px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-volt-400/15 text-volt-300">
                <CheckIcon size={16} />
              </span>
              <div>
                <p className="text-sm font-medium text-white">Order reservation accepted</p>
                <p className="font-mono text-[10px] text-white/40">{lastOrder.orderId}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <OrderStatusPill status={lastOrder.status} pulse={lastOrder.status === 'PENDING'} />
              <Link
                to={`/orders/${lastOrder.orderId}`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/10"
              >
                Track order <ArrowRightIcon size={13} />
              </Link>
            </div>
          </div>
        ) : null}

        <section className="mt-8 grid items-center gap-10 lg:mt-12 lg:grid-cols-[1.02fr_0.98fr] lg:gap-14">
          <div className="relative mx-auto w-full max-w-[560px]">
            <div
              aria-hidden="true"
              className="absolute left-1/2 top-1/2 h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-ember-500/20 blur-[90px] sm:h-[500px] sm:w-[500px]"
            />
            <div className="relative aspect-[4/5] overflow-hidden rounded-[2rem] border border-white/10 bg-gradient-to-b from-ink-800 via-ink-850 to-ink-900 shadow-panel">
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(255,100,51,0.24),transparent_48%)]"
              />
              <div
                aria-hidden="true"
                className="absolute left-1/2 top-[46%] h-[72%] w-[72%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10"
              />
              <div
                aria-hidden="true"
                className="absolute left-1/2 top-[46%] h-[54%] w-[54%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-white/[0.08]"
              />
              <img
                src={product.imageUrl}
                alt={`${product.name} in Obsidian Black`}
                className="absolute left-1/2 top-1/2 h-[82%] w-auto -translate-x-1/2 -translate-y-1/2 object-contain drop-shadow-[0_35px_45px_rgba(0,0,0,0.65)]"
                width={440}
                height={620}
              />
              <div className="absolute left-4 top-4 rounded-full border border-white/10 bg-ink-950/60 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-white/50 backdrop-blur">
                Limited / 500
              </div>
              <div className="absolute right-4 top-4 rounded-full border border-volt-400/20 bg-volt-400/10 px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-volt-300 backdrop-blur">
                {soldOut ? 'Closed' : 'Live'}
              </div>

              <div className="absolute inset-x-4 bottom-4 grid grid-cols-3 gap-2">
                {[
                  { label: 'Admission', value: inventory.admissionStock ?? '—' },
                  { label: 'Held', value: inventory.activeReservations },
                  { label: 'Sold', value: inventory.confirmedOrders },
                ].map((item) => (
                  <div
                    key={item.label}
                    className="rounded-xl border border-white/10 bg-ink-950/55 px-3 py-2.5 backdrop-blur-md"
                  >
                    <p className="font-mono text-[8px] uppercase tracking-[0.18em] text-white/35">
                      {item.label}
                    </p>
                    <p className="mt-1 text-sm font-semibold tabular-nums text-white">
                      {typeof item.value === 'number' ? formatNumber(item.value) : item.value}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div className="absolute -left-3 top-16 hidden rounded-xl border border-white/10 bg-ink-850/95 px-3.5 py-2.5 shadow-panel backdrop-blur sm:block">
              <p className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-white/40">
                <LockIcon size={11} className="text-volt-300" /> Atomic admission
              </p>
              <p className="mt-1 text-xs font-medium text-white">Redis + Lua</p>
            </div>
            <div className="absolute -right-3 bottom-24 hidden rounded-xl border border-white/10 bg-ink-850/95 px-3.5 py-2.5 shadow-panel backdrop-blur sm:block">
              <p className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-white/40">
                <DatabaseIcon size={11} className="text-ember-300" /> Durable ledger
              </p>
              <p className="mt-1 text-xs font-medium text-white">PostgreSQL</p>
            </div>
          </div>

          <div className="animate-fade-up">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-ember-400/25 bg-ember-400/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ember-200">
                Flash drop · {discount}% off
              </span>
              <span className="rounded-full border border-white/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
                1 per customer
              </span>
            </div>

            <h1 className="mt-5 text-4xl font-semibold leading-[1.05] tracking-[-0.04em] text-white sm:text-5xl lg:text-[3.6rem]">
              {product.name}
            </h1>
            <p className="mt-3 text-lg text-white/55">{product.tagline}</p>

            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-white/40">
              <span className="flex items-center gap-1.5">
                <span className="text-amber-300">★★★★★</span>
                <span>4.9 / 5</span>
              </span>
              <span className="h-3 w-px bg-white/15" />
              <span>12 GB · 256 GB · Obsidian Black</span>
              <span className="h-3 w-px bg-white/15" />
              <span className="flex items-center gap-1.5 text-volt-300">
                <ShieldIcon size={13} /> 1-year warranty
              </span>
            </div>

            <p className="mt-5 max-w-xl text-sm leading-6 text-white/50">{product.description}</p>

            <div className="mt-7 flex flex-wrap items-end gap-x-4 gap-y-2">
              <span className="text-4xl font-semibold tracking-tight text-white">
                {formatInr(product.priceInr)}
              </span>
              <span className="pb-1 text-base text-white/30 line-through">
                {formatInr(product.originalPriceInr)}
              </span>
              <span className="mb-1 rounded-md bg-ember-400/10 px-2 py-0.5 text-xs font-medium text-ember-300">
                Save {formatInr(product.originalPriceInr - product.priceInr)}
              </span>
            </div>
            <p className="mt-1 text-xs text-white/30">Inclusive of all taxes · Free delivery</p>

            <div
              className={cx(
                'mt-7 rounded-2xl border p-4 transition-colors duration-500',
                soldOut
                  ? 'border-white/10 bg-white/[0.03]'
                  : stockLow
                    ? 'border-amber-400/20 bg-amber-400/[0.04]'
                    : 'border-white/10 bg-white/[0.03]',
                stockPulse && 'border-volt-400/40',
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="relative flex h-2 w-2">
                    {!soldOut ? (
                      <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-volt-400" />
                    ) : null}
                    <span
                      className={cx(
                        'relative h-2 w-2 rounded-full',
                        soldOut ? 'bg-white/30' : stockLow ? 'bg-amber-300' : 'bg-volt-400',
                      )}
                    />
                  </span>
                  <p className="text-sm font-medium text-white">
                    {soldOut ? 'Sold out' : stockLow ? 'Almost gone' : 'Live inventory'}
                  </p>
                </div>
                <p className="font-mono text-xs tabular-nums text-white/60">
                  <span
                    data-testid="stock-available"
                    className={cx('text-lg font-semibold', soldOut ? 'text-white/40' : 'text-white')}
                  >
                    {formatNumber(inventory.availableStock)}
                  </span>{' '}
                  available
                </p>
              </div>

              <div
                className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.07]"
                role="progressbar"
                aria-label="Units claimed"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percentClaimed}
              >
                <div
                  className={cx(
                    'h-full rounded-full transition-all duration-700',
                    soldOut
                      ? 'bg-white/20'
                      : 'bg-gradient-to-r from-ember-500 via-ember-400 to-amber-300',
                  )}
                  style={{ width: `${percentClaimed}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px] text-white/35">
                <span>{formatNumber(claimed)} of {formatNumber(inventory.initialStock)} claimed</span>
                <span>{percentClaimed}%</span>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-white/[0.06] pt-3">
                <div>
                  <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-white/30">Reserved now</p>
                  <p className="mt-0.5 text-sm font-semibold tabular-nums text-white/80">
                    {formatNumber(inventory.activeReservations)}
                  </p>
                </div>
                <div>
                  <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-white/30">Confirmed</p>
                  <p className="mt-0.5 text-sm font-semibold tabular-nums text-white/80">
                    {formatNumber(inventory.confirmedOrders)}
                  </p>
                </div>
                <div>
                  <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-white/30">Ledger</p>
                  <p
                    className={cx(
                      'mt-0.5 text-sm font-semibold',
                      inventory.invariantHolds ? 'text-volt-300' : 'text-amber-300',
                    )}
                  >
                    {inventory.invariantHolds ? 'Balanced' : 'Reconciling'}
                  </p>
                </div>
              </div>
            </div>

            <button
              type="button"
              data-testid="buy-now"
              onClick={() => setCheckoutOpen(true)}
              disabled={soldOut || checkoutOpen}
              className={cx(
                'group mt-4 flex w-full items-center justify-center gap-2.5 rounded-xl px-5 py-4 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-300 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950',
                soldOut
                  ? 'cursor-not-allowed border border-white/10 bg-white/[0.04] text-white/35'
                  : 'bg-ember-500 text-ink-950 shadow-glow hover:bg-ember-400 active:scale-[0.995] disabled:cursor-not-allowed disabled:opacity-60',
              )}
            >
              <BagIcon size={18} />
              {soldOut ? 'Sold out — drop closed' : 'Buy now'}
              {!soldOut ? (
                <ArrowRightIcon
                  size={17}
                  className="transition-transform group-hover:translate-x-0.5"
                />
              ) : null}
            </button>

            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              {[
                { icon: LockIcon, label: 'Secure checkout' },
                { icon: TruckIcon, label: 'Free delivery' },
                { icon: ShieldIcon, label: 'Buyer protection' },
              ].map(({ icon: Icon, label }) => (
                <div
                  key={label}
                  className="flex items-center justify-center gap-1.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2 py-2 text-[10px] text-white/40"
                >
                  <Icon size={12} /> {label}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mt-20">
          <SectionHeading
            eyebrow="Engineering"
            title="Every number on this page is live."
            description="The storefront reads the same admission counter and durable ledger exposed in the system monitor. The 500-unit limit is enforced twice — atomically in Redis, then by a PostgreSQL row-level capacity guard."
            action={
              <Link
                to="/system-monitor"
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm font-medium text-white transition hover:border-white/20 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-400/60"
              >
                <ActivityIcon size={15} className="text-volt-300" />
                Open system monitor
                <ArrowRightIcon size={14} />
              </Link>
            }
          />
          <div className="mt-6 grid gap-3 md:grid-cols-3">
            {[
              {
                icon: BoltIcon,
                step: '01',
                title: 'Atomic admission',
                body: 'A single Lua script checks stock, reserves one unit and records the idempotency key without a race window.',
                accent: 'text-ember-300',
              },
              {
                icon: DatabaseIcon,
                step: '02',
                title: 'Durable order intent',
                body: 'Reservation, order and outbox event commit together in PostgreSQL under a capacity guard. No 202 before commit.',
                accent: 'text-volt-300',
              },
              {
                icon: LayersIcon,
                step: '03',
                title: 'Asynchronous confirmation',
                body: 'A publisher drains the outbox to durable RabbitMQ queues; an idempotent worker moves each reservation to sold.',
                accent: 'text-sky-300',
              },
            ].map((item) => (
              <Panel key={item.step} className="group p-5 transition hover:border-white/20">
                <div className="flex items-center justify-between">
                  <item.icon size={20} className={item.accent} />
                  <span className="font-mono text-[10px] text-white/20">{item.step}</span>
                </div>
                <h3 className="mt-4 text-base font-semibold text-white">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-white/45">{item.body}</p>
              </Panel>
            ))}
          </div>
        </section>

        <section className="mt-20">
          <SectionHeading
            eyebrow="Hardware"
            title="Flagship, without the wait."
            description="A titanium frame, a 120 Hz LTPO panel and a camera system that keeps up. This is the only configuration in the drop."
          />
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {specCards.map(({ key, label, icon: Icon }) => (
              <Panel key={key} className="p-5">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/[0.04] text-white/60">
                    <Icon size={15} />
                  </span>
                  <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">
                    {label}
                  </p>
                </div>
                <p className="mt-3 text-sm leading-6 text-white/80">{product.specs[key]}</p>
              </Panel>
            ))}
          </div>

          <Panel className="mt-3 overflow-hidden">
            <dl className="grid divide-y divide-white/[0.06] sm:grid-cols-2 sm:divide-x sm:divide-y-0">
              <div className="divide-y divide-white/[0.06]">
                {[
                  ['Front camera', product.specs.frontCamera],
                  ['Connectivity', product.specs.connectivity],
                  ['Operating system', product.specs.os],
                ].map(([term, detail]) => (
                  <div key={term} className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:justify-between sm:gap-6">
                    <dt className="text-xs text-white/35">{term}</dt>
                    <dd className="text-right text-xs text-white/70">{detail}</dd>
                  </div>
                ))}
              </div>
              <div className="divide-y divide-white/[0.06]">
                {[
                  ['Colours', product.specs.colors],
                  ['In the box', product.specs.box],
                  ['SKU', product.sku],
                ].map(([term, detail]) => (
                  <div key={term} className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:justify-between sm:gap-6">
                    <dt className="text-xs text-white/35">{term}</dt>
                    <dd className="text-right text-xs text-white/70">{detail}</dd>
                  </div>
                ))}
              </div>
            </dl>
          </Panel>
        </section>

        <section className="mt-16 rounded-3xl border border-white/10 bg-gradient-to-br from-ember-500/[0.1] via-ink-850 to-ink-900 p-6 sm:p-8">
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div className="max-w-xl">
              <Eyebrow>Built for the drop</Eyebrow>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
                500 units. Zero overselling.
              </h2>
              <p className="mt-2 text-sm leading-6 text-white/45">
                Watch reservations, outbox delivery, worker confirmations and infrastructure health
                update while you shop.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <InlineLink
                to="/system-monitor"
                className="rounded-xl border border-ember-300/30 bg-ember-400/10 px-4 py-2.5 text-ember-200 no-underline hover:bg-ember-400/15"
              >
                View live monitor <ArrowRightIcon size={14} />
              </InlineLink>
            </div>
          </div>
        </section>
      </div>

      {checkoutOpen ? (
        <CheckoutModal
          product={product}
          onClose={closeCheckout}
          onCompleted={handleCompleted}
          onSoldOut={handleSoldOut}
        />
      ) : null}
    </main>
  );
}

function StorefrontSkeleton() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-6 w-40" />
      </div>
      <div className="mt-10 grid items-center gap-12 lg:grid-cols-2">
        <Skeleton className="mx-auto aspect-[4/5] w-full max-w-[560px] rounded-[2rem]" />
        <div className="space-y-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-14 w-4/5" />
          <Skeleton className="h-5 w-3/5" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-12 w-48" />
          <Skeleton className="h-36 w-full rounded-2xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
        </div>
      </div>
    </main>
  );
}

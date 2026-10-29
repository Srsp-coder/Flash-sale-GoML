import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { HealthReport, MonitorEvent, MonitorOverview } from '../types';
import {
  fetchMonitorEvents,
  fetchMonitorHealth,
  fetchMonitorOverview,
} from '../services/api';
import {
  cx,
  formatDateTime,
  formatInr,
  formatNumber,
  formatTime,
  timeAgo,
} from '../services/format';
import {
  ActivityIcon,
  AlertIcon,
  ArrowRightIcon,
  BoltIcon,
  ClockIcon,
  CpuIcon,
  DatabaseIcon,
  GaugeIcon,
  LayersIcon,
  LockIcon,
  RefreshIcon,
  ServerIcon,
  ShieldIcon,
} from '../components/Icons';
import {
  ErrorNotice,
  Eyebrow,
  LivePill,
  OrderStatusPill,
  Panel,
  SectionHeading,
  Skeleton,
  StatusDot,
} from '../components/ui';

const POLL_MS = 2500;

function serviceIcon(name: string) {
  switch (name) {
    case 'api':
      return CpuIcon;
    case 'postgresql':
      return DatabaseIcon;
    case 'redis':
      return BoltIcon;
    case 'rabbitmq':
      return LayersIcon;
    default:
      return ServerIcon;
  }
}

const toneClass = {
  ok: 'text-volt-300 border-volt-400/20 bg-volt-400/[0.06]',
  degraded: 'text-amber-300 border-amber-300/20 bg-amber-300/[0.05]',
  down: 'text-red-300 border-red-400/20 bg-red-400/[0.05]',
} as const;

export function SystemMonitorPage() {
  const [overview, setOverview] = useState<MonitorOverview | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [events, setEvents] = useState<MonitorEvent[]>([]);
  const [eventsAvailable, setEventsAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async (silent = false) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (!silent) setRefreshing(true);
    try {
      const [overviewResult, healthResult, eventsResult] = await Promise.all([
        fetchMonitorOverview(controller.signal),
        fetchMonitorHealth(controller.signal),
        fetchMonitorEvents(30, controller.signal),
      ]);
      if (!mounted.current || controller.signal.aborted) return;
      setOverview(overviewResult);
      setHealth(healthResult);
      setEvents(eventsResult.events);
      setEventsAvailable(eventsResult.available);
      setLastUpdated(overviewResult.generatedAt);
      setError(null);
    } catch (caught) {
      if (!mounted.current || controller.signal.aborted) return;
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof Error ? caught.message : 'Monitor refresh failed.');
    } finally {
      if (mounted.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load(false);
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => void load(true), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, paused]);

  if (loading && !overview) {
    return <MonitorSkeleton />;
  }

  if (!overview) {
    return (
      <main className="mx-auto flex min-h-[65vh] max-w-2xl items-center px-4 py-16">
        <Panel className="w-full p-8">
          <Eyebrow>System monitor</Eyebrow>
          <h1 className="mt-3 text-2xl font-semibold text-white">Monitor unavailable</h1>
          <p className="mt-2 text-sm leading-6 text-white/45">
            The monitor could not reach the API. It shows nothing rather than invented statistics.
          </p>
          <div className="mt-5">
            <ErrorNotice
              message={error ?? 'The monitoring endpoints did not respond.'}
              onRetry={() => void load(false)}
            />
          </div>
        </Panel>
      </main>
    );
  }

  const inventory = overview.inventory;
  const queue = overview.asyncProcessing.queue;
  const outbox = overview.asyncProcessing.outbox;
  const checkout = overview.checkout;
  const performance = overview.performance;
  const healthStatus = health?.status ?? 'degraded';
  const availableForBar = inventory?.availableStock ?? 0;

  return (
    <main className="relative overflow-hidden pb-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[600px] bg-[radial-gradient(ellipse_at_70%_0%,rgba(192,245,106,0.07),transparent_55%),radial-gradient(ellipse_at_10%_0%,rgba(255,100,51,0.08),transparent_45%)]"
      />
      <div className="relative mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <Eyebrow>Backend activity / live</Eyebrow>
              <LivePill label={paused ? 'Paused' : 'Polling 2.5s'} />
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-white sm:text-4xl">
              System monitor
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-white/45">
              Real reservation, outbox, queue, worker, database and health signals from the FlashSale
              backend. Missing metrics are labelled — nothing here is fabricated.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setPaused((value) => !value)}
              className={cx(
                'inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-400/60',
                paused
                  ? 'border-amber-300/25 bg-amber-300/10 text-amber-200 hover:bg-amber-300/15'
                  : 'border-white/10 bg-white/[0.03] text-white/60 hover:bg-white/[0.06] hover:text-white',
              )}
              aria-pressed={paused}
            >
              {paused ? <ActivityIcon size={14} /> : <span className="h-2 w-2 rounded-full bg-volt-400" />}
              {paused ? 'Resume polling' : 'Pause polling'}
            </button>
            <button
              type="button"
              onClick={() => void load(false)}
              disabled={refreshing}
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2 text-xs font-medium text-white/60 transition hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-400/60 disabled:opacity-40"
            >
              <RefreshIcon size={14} className={refreshing ? 'animate-spin' : undefined} />
              Refresh
            </button>
            <Link
              to="/"
              className="inline-flex items-center gap-2 rounded-xl border border-ember-300/25 bg-ember-400/10 px-3.5 py-2 text-xs font-medium text-ember-200 transition hover:bg-ember-400/15"
            >
              Storefront <ArrowRightIcon size={13} />
            </Link>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-white/35">
          <span className="flex items-center gap-1.5">
            <StatusDot tone={healthStatus === 'healthy' ? 'ok' : 'warn'} />
            Overall {health?.status ?? 'unknown'}
          </span>
          <span>Last poll {lastUpdated ? timeAgo(lastUpdated) : '—'}</span>
          <span className="font-mono">snapshot {lastUpdated ? formatTime(lastUpdated) : '—'}</span>
          {paused ? <span className="text-amber-300">Polling paused — values are from the last snapshot.</span> : null}
        </div>

        {error ? (
          <div className="mt-4">
            <ErrorNotice
              title="Monitor refresh failed"
              message={`${error} Showing the last successful snapshot.`}
              onRetry={() => void load(false)}
              compact
            />
          </div>
        ) : null}

        <section className="mt-6" aria-label="Infrastructure health">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {(health?.services ?? []).map((service) => {
              const Icon = serviceIcon(service.name);
              const tone = service.status === 'ok' ? 'ok' : 'down';
              return (
                <Panel key={service.name} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <span
                        className={cx(
                          'grid h-8 w-8 place-items-center rounded-lg border',
                          toneClass[tone],
                        )}
                      >
                        <Icon size={15} />
                      </span>
                      <div>
                        <p className="text-sm font-medium capitalize text-white">{service.name}</p>
                        <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/30">
                          {service.status === 'ok' ? 'Operational' : 'Unavailable'}
                        </p>
                      </div>
                    </div>
                    <span
                      className={cx(
                        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px]',
                        toneClass[tone],
                      )}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />
                      {service.latencyMs}ms
                    </span>
                  </div>
                  <p className="mt-3 truncate text-[11px] text-white/35" title={service.detail}>
                    {service.detail}
                  </p>
                  {service.error ? (
                    <p className="mt-1.5 truncate font-mono text-[10px] text-red-300/70" title={service.error}>
                      {service.error}
                    </p>
                  ) : null}
                </Panel>
              );
            })}
            {!health
              ? Array.from({ length: 4 }).map((_, index) => (
                  <Skeleton key={index} className="h-[112px] rounded-2xl" />
                ))
              : null}
          </div>
        </section>

        <div className="mt-3 grid gap-3 lg:grid-cols-12">
          <Panel className="p-5 lg:col-span-7">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <Eyebrow>Inventory ledger</Eyebrow>
                <h2 className="mt-1.5 text-lg font-semibold text-white">Zero-overselling invariant</h2>
              </div>
              <span
                className={cx(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em]',
                  inventory?.invariant.holds
                    ? 'border-volt-400/25 bg-volt-400/10 text-volt-300'
                    : 'border-red-400/25 bg-red-400/10 text-red-300',
                )}
              >
                <ShieldIcon size={12} />
                {inventory?.invariant.holds ? 'Balanced' : 'Drift detected'}
              </span>
            </div>

            {inventory ? (
              <>
                <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    { label: 'Initial', value: inventory.initialStock, tone: 'text-white' },
                    { label: 'Available', value: inventory.availableStock, tone: 'text-volt-300' },
                    { label: 'Reserved', value: inventory.activeReservations, tone: 'text-amber-300' },
                    { label: 'Confirmed', value: inventory.confirmedOrders, tone: 'text-ember-300' },
                  ].map((metric) => (
                    <div key={metric.label} className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3">
                      <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/30">
                        {metric.label}
                      </p>
                      <p className={cx('mt-1.5 text-2xl font-semibold tabular-nums tracking-tight', metric.tone)}>
                        {formatNumber(metric.value)}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="mt-5">
                  <div className="flex h-3 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="bg-volt-400/80 transition-all duration-700"
                      style={{ width: `${(availableForBar / inventory.initialStock) * 100}%` }}
                      title={`${inventory.availableStock} available`}
                    />
                    <div
                      className="bg-amber-300/80 transition-all duration-700"
                      style={{ width: `${(inventory.activeReservations / inventory.initialStock) * 100}%` }}
                      title={`${inventory.activeReservations} reserved`}
                    />
                    <div
                      className="bg-ember-500/90 transition-all duration-700"
                      style={{ width: `${(inventory.confirmedOrders / inventory.initialStock) * 100}%` }}
                      title={`${inventory.confirmedOrders} confirmed`}
                    />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-white/35">
                    <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-volt-400/80" /> Available</span>
                    <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-amber-300/80" /> Active reservations</span>
                    <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-ember-500/90" /> Confirmed / sold</span>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-ink-900/60 px-3.5 py-3 font-mono text-[10px]">
                  <span className="text-white/45">
                    {formatNumber(inventory.availableStock)} available +{' '}
                    {formatNumber(inventory.activeReservations)} reserved +{' '}
                    {formatNumber(inventory.confirmedOrders)} confirmed ={' '}
                    <span className="text-white/80">{formatNumber(inventory.initialStock)}</span>
                  </span>
                  <span
                    className={cx(
                      'uppercase tracking-[0.12em]',
                      inventory.invariant.holds ? 'text-volt-300' : 'text-red-300',
                    )}
                  >
                    {inventory.invariant.holds ? 'Invariant holds' : 'Ledger mismatch'}
                  </span>
                </div>
                <div className="mt-3 grid gap-2 text-[10px] text-white/35 sm:grid-cols-2">
                  <div className="flex items-center justify-between rounded-lg border border-white/[0.06] px-3 py-2">
                    <span className="flex items-center gap-1.5"><BoltIcon size={11} /> Redis admission counter</span>
                    <span className="font-mono text-white/70">
                      {inventory.admissionStock === null ? 'Unavailable' : formatNumber(inventory.admissionStock)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-white/[0.06] px-3 py-2">
                    <span className="flex items-center gap-1.5"><GaugeIcon size={11} /> Admission drift</span>
                    <span
                      className={cx(
                        'font-mono',
                        inventory.drift === 0 ? 'text-white/70' : 'text-amber-300',
                      )}
                    >
                      {inventory.drift === null ? 'Unavailable' : `${inventory.drift > 0 ? '+' : ''}${inventory.drift}`}
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <div className="mt-5 rounded-xl border border-amber-300/15 bg-amber-300/[0.04] p-4 text-sm text-amber-200/70">
                Inventory snapshot unavailable. PostgreSQL may be unreachable.
              </div>
            )}
          </Panel>

          <Panel className="p-5 lg:col-span-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <Eyebrow>Checkout activity</Eyebrow>
                <h2 className="mt-1.5 text-lg font-semibold text-white">Admission outcomes</h2>
              </div>
              <span className="rounded-full border border-white/10 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-white/35">
                {checkout.source}
              </span>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {[
                { label: 'Accepted', value: checkout.accepted, tone: 'text-volt-300' },
                { label: 'Sold out', value: checkout.soldOut, tone: 'text-amber-300' },
                { label: 'Failed', value: checkout.failed, tone: 'text-red-300' },
                { label: 'Idempotent', value: checkout.idempotent, tone: 'text-sky-300' },
                { label: 'Rejected', value: checkout.rejected, tone: 'text-white/70' },
                { label: 'Attempts', value: checkout.attempts, tone: 'text-white/70' },
              ].map((metric) => (
                <div key={metric.label} className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3">
                  <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/30">
                    {metric.label}
                  </p>
                  <p className={cx('mt-1 text-xl font-semibold tabular-nums', metric.tone)}>
                    {checkout.countersAvailable ? formatNumber(metric.value) : '—'}
                  </p>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between rounded-xl border border-white/[0.06] bg-ink-900/60 px-3.5 py-3">
              <span className="text-[11px] text-white/35">Accepted / decided</span>
              <span className="font-mono text-sm text-white/80">
                {checkout.successRatePercent === null ? 'Unavailable' : `${checkout.successRatePercent}%`}
              </span>
            </div>
            {!checkout.countersAvailable ? (
              <p className="mt-2 text-[10px] text-amber-300/70">
                Counter store unavailable; showing this API process's fallback counters.
              </p>
            ) : null}
          </Panel>
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-12">
          <Panel className="p-5 lg:col-span-7">
            <div className="flex items-start justify-between gap-3">
              <div>
                <Eyebrow>Asynchronous processing</Eyebrow>
                <h2 className="mt-1.5 text-lg font-semibold text-white">Outbox &amp; queue</h2>
              </div>
              <span
                className={cx(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em]',
                  queue.available
                    ? 'border-volt-400/20 bg-volt-400/[0.07] text-volt-300'
                    : 'border-amber-300/20 bg-amber-300/[0.07] text-amber-200',
                )}
              >
                <StatusDot tone={queue.available ? 'ok' : 'warn'} />
                {queue.available ? 'Management API' : 'Unavailable'}
              </span>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {[
                { label: 'Outbox pending', value: outbox.pending, tone: 'text-amber-300' },
                { label: 'Publishing', value: outbox.publishing, tone: 'text-sky-300' },
                { label: 'Published', value: outbox.published, tone: 'text-volt-300' },
                { label: 'Publish failed', value: outbox.failed, tone: 'text-red-300' },
              ].map((metric) => (
                <div key={metric.label} className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3">
                  <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/30">{metric.label}</p>
                  <p className={cx('mt-1 text-xl font-semibold tabular-nums', metric.tone)}>{metric.value}</p>
                </div>
              ))}
            </div>

            <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
              {[
                { key: 'main', label: 'Orders queue', data: queue.queues.main, icon: LayersIcon },
                { key: 'retry', label: 'Retry queue', data: queue.queues.retry, icon: ClockIcon },
                { key: 'dlq', label: 'Dead letters', data: queue.queues.deadLetter, icon: AlertIcon },
              ].map(({ key, label, data, icon: Icon }) => (
                <div key={key} className="rounded-xl border border-white/[0.07] bg-ink-900/50 p-3">
                  <div className="flex items-center gap-1.5 text-[10px] text-white/35">
                    <Icon size={11} /> {label}
                  </div>
                  {data ? (
                    <>
                      <p className="mt-1.5 text-xl font-semibold tabular-nums text-white/85">
                        {data.ready === null ? '—' : formatNumber(data.ready)}
                        <span className="ml-1 text-[9px] font-normal uppercase tracking-wider text-white/25">ready</span>
                      </p>
                      <p className="mt-1 font-mono text-[9px] text-white/30">
                        {data.unacknowledged === null ? 'unacked —' : `${data.unacknowledged} unacked`} ·{' '}
                        {data.consumers === null ? 'consumers —' : `${data.consumers} consumers`}
                      </p>
                    </>
                  ) : (
                    <p className="mt-2 text-xs text-white/30">Unavailable</p>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-3 grid gap-2 text-[10px] sm:grid-cols-3">
              <div className="flex items-center justify-between rounded-lg border border-white/[0.06] px-3 py-2 text-white/35">
                <span>Processed confirmations</span>
                <span className="font-mono text-white/70">{overview.asyncProcessing.processedConfirmations}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-white/[0.06] px-3 py-2 text-white/35">
                <span>Failed orders</span>
                <span className="font-mono text-white/70">{overview.asyncProcessing.failedOrders}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-white/[0.06] px-3 py-2 text-white/35">
                <span>Oldest pending outbox</span>
                <span className="font-mono text-white/70">
                  {outbox.oldestPendingAgeSeconds === null ? '—' : `${outbox.oldestPendingAgeSeconds}s`}
                </span>
              </div>
            </div>
            {!queue.available ? (
              <p className="mt-2 text-[10px] text-amber-300/70">
                {queue.error ?? 'RabbitMQ management API did not respond.'} Queue depth is not fabricated.
              </p>
            ) : null}
          </Panel>

          <Panel className="p-5 lg:col-span-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <Eyebrow>Performance</Eyebrow>
                <h2 className="mt-1.5 text-lg font-semibold text-white">API window</h2>
              </div>
              <span className="rounded-full border border-white/10 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-white/35">
                {performance.source}
              </span>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-2.5">
              {[
                { label: 'p50 latency', value: performance.p50Ms === null ? '—' : `${performance.p50Ms.toFixed(0)} ms` },
                { label: 'p95 latency', value: performance.p95Ms === null ? '—' : `${performance.p95Ms.toFixed(0)} ms` },
                { label: 'Throughput', value: `${performance.throughputPerSecond.toFixed(2)}/s` },
                { label: 'Error rate', value: `${performance.errorRatePercent}%` },
              ].map((metric) => (
                <div key={metric.label} className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3">
                  <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-white/30">{metric.label}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-white/85">{metric.value}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 space-y-2 text-[10px]">
              <div className="flex items-center justify-between rounded-lg border border-white/[0.06] px-3 py-2 text-white/35">
                <span>API requests sampled</span>
                <span className="font-mono text-white/70">{formatNumber(performance.requestCount)}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-white/[0.06] px-3 py-2 text-white/35">
                <span>5xx responses</span>
                <span className="font-mono text-white/70">{formatNumber(performance.errorCount)}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-white/[0.06] px-3 py-2 text-white/35">
                <span>API uptime</span>
                <span className="font-mono text-white/70">
                  {Math.floor(performance.uptimeSeconds / 3600)}h{' '}
                  {Math.floor((performance.uptimeSeconds % 3600) / 60)}m
                </span>
              </div>
            </div>
            <p className="mt-3 text-[10px] leading-4 text-white/25">{performance.window}.</p>
          </Panel>
        </div>

        <div className="mt-3 grid gap-3 lg:grid-cols-12">
          <Panel className="p-5 lg:col-span-7">
            <SectionHeading
              eyebrow="Recent orders"
              title="Durable order states"
              description="Newest first. Every row is read from PostgreSQL; tracking opens the live order view."
            />
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-xs">
                <thead>
                  <tr className="border-b border-white/[0.07] font-mono text-[9px] uppercase tracking-[0.14em] text-white/25">
                    <th className="pb-2 pr-3 font-normal">Order</th>
                    <th className="pb-2 pr-3 font-normal">Status</th>
                    <th className="pb-2 pr-3 font-normal">Created</th>
                    <th className="pb-2 pr-3 font-normal">Confirmed</th>
                    <th className="pb-2 text-right font-normal">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05]">
                  {overview.orders.recent.map((order) => (
                    <tr key={order.id} className="group">
                      <td className="py-2.5 pr-3">
                        <Link
                          to={`/orders/${order.id}`}
                          className="font-mono text-[10px] text-white/60 transition hover:text-ember-300"
                        >
                          {order.id.slice(0, 8)}…{order.id.slice(-4)}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-3">
                        <OrderStatusPill status={order.status} pulse={order.status === 'PENDING'} />
                      </td>
                      <td className="py-2.5 pr-3 text-white/40">{formatDateTime(order.createdAt)}</td>
                      <td className="py-2.5 pr-3 text-white/40">{formatDateTime(order.confirmedAt)}</td>
                      <td className="py-2.5 text-right tabular-nums text-white/60">{formatInr(order.totalPriceInr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {overview.orders.recent.length === 0 ? (
                <div className="mt-4 rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-white/30">
                  No orders yet. Place a checkout from the storefront.
                </div>
              ) : null}
            </div>
            <div className="mt-4 flex flex-wrap gap-2 text-[10px] text-white/30">
              <span className="rounded-full border border-white/10 px-2.5 py-1">
                {overview.orders.pending} pending
              </span>
              <span className="rounded-full border border-volt-400/15 px-2.5 py-1 text-volt-300/70">
                {overview.orders.confirmed} confirmed
              </span>
              <span className="rounded-full border border-red-400/15 px-2.5 py-1 text-red-300/70">
                {overview.orders.failed} failed
              </span>
            </div>
          </Panel>

          <Panel className="p-5 lg:col-span-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <Eyebrow>Activity feed</Eyebrow>
                <h2 className="mt-1.5 text-lg font-semibold text-white">Recent backend events</h2>
              </div>
              <span className="rounded-full border border-white/10 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-white/35">
                Redis log
              </span>
            </div>
            {!eventsAvailable ? (
              <div className="mt-4 rounded-xl border border-amber-300/15 bg-amber-300/[0.04] p-3 text-xs text-amber-200/70">
                Event log unavailable. Redis did not respond.
              </div>
            ) : (
              <ol className="mt-4 max-h-[430px] space-y-0 overflow-y-auto pr-1">
                {events.map((event, index) => (
                  <li key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
                    {index < events.length - 1 ? (
                      <span className="absolute left-[5px] top-4 h-[calc(100%-8px)] w-px bg-white/[0.07]" />
                    ) : null}
                    <span
                      className={cx(
                        'relative z-10 mt-1 h-2.5 w-2.5 shrink-0 rounded-full border-2 border-ink-850',
                        event.level === 'error'
                          ? 'bg-red-400'
                          : event.level === 'warn'
                            ? 'bg-amber-300'
                            : 'bg-volt-400',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-mono text-[9px] uppercase tracking-[0.1em] text-white/30">
                          {event.type.replaceAll('_', ' ')}
                        </span>
                        <span className="font-mono text-[9px] text-white/25" title={formatDateTime(event.at)}>
                          {timeAgo(event.at)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs leading-5 text-white/55">{event.message}</p>
                      {event.orderId ? (
                        <Link
                          to={`/orders/${event.orderId}`}
                          className="mt-0.5 inline-block font-mono text-[9px] text-white/25 transition hover:text-ember-300"
                        >
                          {event.orderId.slice(0, 8)}…
                        </Link>
                      ) : null}
                      {event.data && (event.data.error || event.data.reason) ? (
                        <p className="mt-0.5 truncate font-mono text-[9px] text-red-300/50">
                          {String(event.data.error ?? event.data.reason)}
                        </p>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
            )}
            {eventsAvailable && events.length === 0 ? (
              <div className="mt-4 rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-white/30">
                No backend events recorded yet.
              </div>
            ) : null}
          </Panel>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-[10px] text-white/30">
          <span className="flex items-center gap-2">
            <LockIcon size={12} />
            Read-only monitor. Reset and destructive operations are not exposed here.
          </span>
          <span className="font-mono">GET /api/monitor/overview · /health · /events</span>
        </div>
      </div>
    </main>
  );
}

function MonitorSkeleton() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="mt-4 h-10 w-72" />
      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-[112px] rounded-2xl" />
        ))}
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-12">
        <Skeleton className="h-[380px] rounded-2xl lg:col-span-7" />
        <Skeleton className="h-[380px] rounded-2xl lg:col-span-5" />
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-12">
        <Skeleton className="h-[340px] rounded-2xl lg:col-span-7" />
        <Skeleton className="h-[340px] rounded-2xl lg:col-span-5" />
      </div>
    </main>
  );
}

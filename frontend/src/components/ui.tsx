import { ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertIcon, CheckIcon, CopyIcon, RefreshIcon } from './Icons';
import { cx } from '../services/format';
import type { OrderStatus } from '../types';

export function Panel({
  children,
  className,
  as: Tag = 'section',
}: {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article' | 'aside';
}) {
  return (
    <Tag
      className={cx(
        'rounded-2xl border border-white/10 bg-ink-850/80 shadow-panel backdrop-blur-sm',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cx(
        'font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-white/45',
        className,
      )}
    >
      {children}
    </p>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-white sm:text-2xl">{title}</h2>
        {description ? <p className="mt-2 max-w-2xl text-sm text-white/50">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

const statusStyles: Record<OrderStatus, string> = {
  PENDING: 'border-amber-400/30 bg-amber-400/10 text-amber-200',
  CONFIRMED: 'border-volt-400/30 bg-volt-400/10 text-volt-300',
  FAILED: 'border-red-400/30 bg-red-400/10 text-red-300',
};

const statusLabels: Record<OrderStatus, string> = {
  PENDING: 'Processing',
  CONFIRMED: 'Confirmed',
  FAILED: 'Failed',
};

export function OrderStatusPill({ status, pulse }: { status: OrderStatus; pulse?: boolean }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium',
        statusStyles[status],
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        {status === 'PENDING' && pulse ? (
          <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-amber-300" />
        ) : null}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      {statusLabels[status]}
    </span>
  );
}

export function StatusDot({
  tone = 'ok',
  pulse = false,
}: {
  tone?: 'ok' | 'warn' | 'error' | 'muted';
  pulse?: boolean;
}) {
  const colors = {
    ok: 'bg-volt-400 text-volt-400',
    warn: 'bg-amber-300 text-amber-300',
    error: 'bg-red-400 text-red-400',
    muted: 'bg-white/30 text-white/30',
  } as const;
  return (
    <span className="relative flex h-2 w-2" aria-hidden="true">
      {pulse ? (
        <span
          className={cx(
            'absolute inline-flex h-full w-full animate-pulse-ring rounded-full',
            colors[tone],
          )}
        />
      ) : null}
      <span className={cx('relative inline-flex h-2 w-2 rounded-full', colors[tone])} />
    </span>
  );
}

export function LivePill({ label = 'Live' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-volt-400/20 bg-volt-400/[0.07] px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-volt-300">
      <StatusDot pulse />
      {label}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cx(
        'animate-pulse rounded-lg bg-gradient-to-r from-white/[0.04] via-white/[0.09] to-white/[0.04] bg-[length:200%_100%]',
        className,
      )}
    />
  );
}

export function ErrorNotice({
  title = 'Something went wrong',
  message,
  onRetry,
  retryLabel = 'Try again',
  compact = false,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  compact?: boolean;
}) {
  return (
    <div
      role="alert"
      className={cx(
        'rounded-xl border border-red-400/20 bg-red-400/[0.06]',
        compact ? 'p-3' : 'p-4',
      )}
    >
      <div className="flex gap-3">
        <AlertIcon size={18} className="mt-0.5 shrink-0 text-red-300" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-red-100">{title}</p>
          <p className="mt-1 break-words text-sm text-red-200/70">{message}</p>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-red-300/20 bg-red-300/10 px-3 py-1.5 text-xs font-medium text-red-100 transition hover:bg-red-300/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/60"
            >
              <RefreshIcon size={13} />
              {retryLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : `${label} ${value}`}
      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1 font-mono text-[11px] text-white/60 transition hover:border-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-400/60"
    >
      {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
      {copied ? 'Copied' : label}
    </button>
  );
}

export function InlineLink({
  to,
  children,
  className,
}: {
  to: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={cx(
        'inline-flex items-center gap-1.5 text-sm font-medium text-ember-300 underline-offset-4 transition hover:text-ember-200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-400/60',
        className,
      )}
    >
      {children}
    </Link>
  );
}

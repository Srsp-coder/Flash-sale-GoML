import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CheckoutResponse, Product } from '../types';
import { ApiError, createCheckout } from '../services/api';
import { formatInr } from '../services/format';
import {
  ArrowRightIcon,
  BagIcon,
  CheckIcon,
  LockIcon,
  TruckIcon,
  XIcon,
} from './Icons';
import { CopyButton, ErrorNotice, OrderStatusPill } from './ui';

interface CheckoutModalProps {
  product: Product;
  onClose: () => void;
  onCompleted: (response: CheckoutResponse) => void;
  onSoldOut: () => void;
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `web-${crypto.randomUUID()}`;
  }
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function CheckoutModal({ product, onClose, onCompleted, onSoldOut }: CheckoutModalProps) {
  const [form, setForm] = useState({
    customerName: '',
    customerEmail: '',
    shippingAddress: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CheckoutResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [soldOut, setSoldOut] = useState(false);
  const submittingRef = useRef(false);
  const keyRef = useRef(newIdempotencyKey());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    nameRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submittingRef.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const updateField = (field: keyof typeof form, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    if (error && !result) {
      // Changing the payload invalidates an errored attempt. A fresh key avoids
      // returning the earlier request's result for different customer details.
      keyRef.current = newIdempotencyKey();
      setError(null);
    }
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (submittingRef.current || result || soldOut) return;

    if (form.customerName.trim().length < 2) {
      setError('Enter your full name (at least 2 characters).');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.customerEmail.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    if (form.shippingAddress.trim().length < 10) {
      setError('Enter a delivery address of at least 10 characters.');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    try {
      const response = await createCheckout(
        { productId: product.id, ...form },
        keyRef.current,
      );
      setResult(response);
      onCompleted(response);
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.code === 'SOLD_OUT') {
          setSoldOut(true);
          onSoldOut();
        } else if (caught.code === 'IDEMPOTENCY_MISMATCH') {
          keyRef.current = newIdempotencyKey();
          setError('This checkout attempt was reused with different details. Please try again.');
        } else {
          setError(caught.message);
        }
      } else {
        setError('The checkout request could not be completed. Please try again.');
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/80 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submittingRef.current) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkout-title"
        className="max-h-[94vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-white/10 bg-ink-850 p-5 shadow-2xl sm:rounded-3xl sm:p-6"
      >
        {result ? (
          <div className="animate-fade-up" data-testid="checkout-success">
            <div className="flex items-start justify-between gap-4">
              <div className="grid h-12 w-12 place-items-center rounded-2xl border border-volt-400/25 bg-volt-400/10 text-volt-300">
                <CheckIcon size={24} />
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close checkout"
                className="rounded-lg p-2 text-white/40 transition hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-400/60"
              >
                <XIcon size={18} />
              </button>
            </div>
            <h2 ref={headingRef} id="checkout-title" className="mt-5 text-2xl font-semibold tracking-tight text-white">
              Your unit is reserved.
            </h2>
            <p className="mt-2 text-sm leading-6 text-white/50">
              A durable reservation and order intent were written to PostgreSQL before this
              confirmation. The queue worker is now confirming the order.
            </p>

            <dl className="mt-5 space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-white/40">Order</dt>
                <dd className="flex items-center gap-2 font-mono text-xs text-white/80">
                  {result.orderId.slice(0, 8)}…{result.orderId.slice(-4)}
                  <CopyButton value={result.orderId} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-white/40">Status</dt>
                <dd>
                  <OrderStatusPill status={result.status} pulse />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-white/40">Item</dt>
                <dd className="text-right text-white/80">{product.name}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-white/40">Total</dt>
                <dd className="font-semibold text-white">{formatInr(product.priceInr)}</dd>
              </div>
            </dl>

            <Link
              to={`/orders/${result.orderId}`}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-ember-500 px-4 py-3 text-sm font-semibold text-ink-950 transition hover:bg-ember-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-300 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-850"
            >
              Track this order
              <ArrowRightIcon size={16} />
            </Link>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 w-full rounded-xl px-4 py-2.5 text-sm text-white/50 transition hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
            >
              Back to storefront
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-ember-300">
                  Secure flash checkout
                </p>
                <h2 ref={headingRef} id="checkout-title" className="mt-2 text-xl font-semibold tracking-tight text-white">
                  Claim one {product.name}
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                aria-label="Close checkout"
                className="rounded-lg p-2 text-white/40 transition hover:bg-white/5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-400/60 disabled:opacity-40"
              >
                <XIcon size={18} />
              </button>
            </div>

            <div className="mt-5 flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-lg bg-gradient-to-br from-ember-500/20 to-ink-800">
                <img src={product.imageUrl} alt="" className="h-12 w-12 object-contain" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-white">{product.name}</p>
                <p className="mt-0.5 text-xs text-white/40">1 unit · limited drop</p>
              </div>
              <p className="text-sm font-semibold text-white">{formatInr(product.priceInr)}</p>
            </div>

            {soldOut ? (
              <div className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] p-4" data-testid="checkout-soldout">
                <p className="text-sm font-medium text-amber-100">This drop is sold out.</p>
                <p className="mt-1 text-sm text-amber-100/60">
                  All 500 units are reserved or sold. No order was created.
                </p>
                <button
                  type="button"
                  onClick={onClose}
                  className="mt-3 rounded-lg border border-amber-200/20 px-3 py-1.5 text-xs font-medium text-amber-100 transition hover:bg-amber-200/10"
                >
                  Back to storefront
                </button>
              </div>
            ) : (
              <form onSubmit={submit} className="mt-5 space-y-4" noValidate>
                <div>
                  <label htmlFor="customerName" className="mb-1.5 block text-xs font-medium text-white/60">
                    Full name
                  </label>
                  <input
                    ref={nameRef}
                    id="customerName"
                    name="name"
                    autoComplete="name"
                    maxLength={80}
                    value={form.customerName}
                    onChange={(event) => updateField('customerName', event.target.value)}
                    placeholder="Asha Rao"
                    className="w-full rounded-xl border border-white/10 bg-ink-900 px-3.5 py-2.5 text-sm text-white placeholder:text-white/25 transition focus:border-ember-400/50 focus:outline-none focus:ring-2 focus:ring-ember-400/20"
                  />
                </div>
                <div>
                  <label htmlFor="customerEmail" className="mb-1.5 block text-xs font-medium text-white/60">
                    Email for order updates
                  </label>
                  <input
                    id="customerEmail"
                    name="email"
                    type="email"
                    autoComplete="email"
                    maxLength={200}
                    value={form.customerEmail}
                    onChange={(event) => updateField('customerEmail', event.target.value)}
                    placeholder="asha@example.com"
                    className="w-full rounded-xl border border-white/10 bg-ink-900 px-3.5 py-2.5 text-sm text-white placeholder:text-white/25 transition focus:border-ember-400/50 focus:outline-none focus:ring-2 focus:ring-ember-400/20"
                  />
                </div>
                <div>
                  <label htmlFor="shippingAddress" className="mb-1.5 block text-xs font-medium text-white/60">
                    Delivery address
                  </label>
                  <textarea
                    id="shippingAddress"
                    name="address"
                    autoComplete="street-address"
                    rows={3}
                    maxLength={500}
                    value={form.shippingAddress}
                    onChange={(event) => updateField('shippingAddress', event.target.value)}
                    placeholder="Flat, building, street, city, state, PIN"
                    className="w-full resize-none rounded-xl border border-white/10 bg-ink-900 px-3.5 py-2.5 text-sm text-white placeholder:text-white/25 transition focus:border-ember-400/50 focus:outline-none focus:ring-2 focus:ring-ember-400/20"
                  />
                </div>

                {error ? <div data-testid="checkout-error"><ErrorNotice message={error} compact /></div> : null}

                <div className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-[11px] text-white/40">
                  <LockIcon size={13} className="shrink-0 text-volt-300" />
                  Idempotency-Key attached. Double submits return the same order.
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  data-testid="checkout-submit"
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-ember-500 px-4 py-3 text-sm font-semibold text-ink-950 shadow-glow transition hover:bg-ember-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-300 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-850 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? (
                    <>
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-950/30 border-t-ink-950" />
                      Securing your unit…
                    </>
                  ) : (
                    <>
                      <BagIcon size={16} />
                      Place order · {formatInr(product.priceInr)}
                    </>
                  )}
                </button>
                <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-white/30">
                  <TruckIcon size={12} /> Free delivery · demo checkout, no payment collected
                </p>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

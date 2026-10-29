import { Link } from 'react-router-dom';
import { BoltIcon } from './Icons';

export function Footer() {
  return (
    <footer className="mt-20 border-t border-white/[0.07] bg-ink-950/60">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr] lg:px-8">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-ember-500 text-ink-950">
              <BoltIcon size={14} strokeWidth={2.4} />
            </span>
            Flash<span className="-ml-2 text-ember-400">Sale</span>
          </div>
          <p className="mt-3 max-w-sm text-sm leading-6 text-white/40">
            A real high-concurrency checkout demonstration. PostgreSQL is the durable ledger,
            Redis admits inventory atomically, and RabbitMQ drives asynchronous order processing.
          </p>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-white/30">Explore</p>
          <div className="mt-3 flex flex-col gap-2 text-sm text-white/50">
            <Link to="/" className="transition hover:text-white">
              Storefront
            </Link>
            <Link to="/system-monitor" className="transition hover:text-white">
              System monitor
            </Link>
            <a href="/api/health" className="transition hover:text-white" target="_blank" rel="noreferrer">
              API health
            </a>
          </div>
        </div>
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-white/30">
            Consistency model
          </p>
          <p className="mt-3 text-sm leading-6 text-white/40">
            Redis admission + PostgreSQL ledger + transactional outbox. No claim of a single
            distributed transaction — recovery closes the gaps.
          </p>
        </div>
      </div>
      <div className="border-t border-white/[0.05] px-4 py-4 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-white/25">
        FlashSale demo · 500 units · one per checkout
      </div>
    </footer>
  );
}

import { NavLink, Link } from 'react-router-dom';
import { ActivityIcon, BoltIcon } from './Icons';
import { LivePill } from './ui';
import { cx } from '../services/format';

export function Navbar() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.07] bg-ink-950/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <Link
          to="/"
          className="group flex items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-400/60"
          aria-label="FlashSale home"
        >
          <span className="relative grid h-9 w-9 place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-ember-400 to-ember-600 text-ink-950 shadow-glow">
            <BoltIcon size={19} strokeWidth={2.4} />
            <span className="absolute inset-0 bg-white/20 opacity-0 transition group-hover:opacity-100" />
          </span>
          <span className="leading-none">
            <span className="block text-sm font-bold tracking-tight text-white">
              FLASH<span className="text-ember-400">SALE</span>
            </span>
            <span className="mt-1 block font-mono text-[9px] uppercase tracking-[0.28em] text-white/35">
              Drop 001
            </span>
          </span>
        </Link>

        <nav aria-label="Main navigation" className="flex items-center gap-1 sm:gap-2">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              cx(
                'rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-400/60',
                isActive ? 'text-white' : 'text-white/50 hover:text-white',
              )
            }
          >
            Storefront
          </NavLink>
          <NavLink
            to="/system-monitor"
            className={({ isActive }) =>
              cx(
                'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember-400/60',
                isActive
                  ? 'border-ember-400/30 bg-ember-400/10 text-ember-200'
                  : 'border-white/10 text-white/60 hover:border-white/20 hover:text-white',
              )
            }
          >
            <ActivityIcon size={15} />
            <span className="hidden sm:inline">System monitor</span>
            <span className="sm:hidden">Monitor</span>
          </NavLink>
          <span className="ml-1 hidden lg:inline-flex">
            <LivePill label="Live drop" />
          </span>
        </nav>
      </div>
    </header>
  );
}

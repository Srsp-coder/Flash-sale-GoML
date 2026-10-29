import { useEffect } from 'react';
import { BrowserRouter, Link, Route, Routes, useLocation } from 'react-router-dom';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';
import { StorefrontPage } from './pages/StorefrontPage';
import { OrderTrackingPage } from './pages/OrderTrackingPage';
import { SystemMonitorPage } from './pages/SystemMonitorPage';
import { Panel } from './components/ui';
import { ArrowLeftIcon } from './components/Icons';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [pathname]);
  return null;
}

function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-[65vh] max-w-xl items-center px-4 py-16">
      <Panel className="w-full p-8 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-ember-300">404</p>
        <h1 className="mt-3 text-2xl font-semibold text-white">This page is not part of the drop.</h1>
        <p className="mt-2 text-sm text-white/45">
          The link may be outdated. The storefront and system monitor are still live.
        </p>
        <Link
          to="/"
          className="mt-6 inline-flex items-center gap-2 rounded-xl bg-ember-500 px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-ember-400"
        >
          <ArrowLeftIcon size={15} /> Back to storefront
        </Link>
      </Panel>
    </main>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <div className="flex min-h-screen flex-col">
        <Navbar />
        <div className="flex-1">
          <Routes>
            <Route path="/" element={<StorefrontPage />} />
            <Route path="/orders/:orderId" element={<OrderTrackingPage />} />
            <Route path="/system-monitor" element={<SystemMonitorPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </div>
        <Footer />
      </div>
    </BrowserRouter>
  );
}

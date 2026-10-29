import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SystemMonitorPage } from '../pages/SystemMonitorPage';
import { eventsResponse, healthReport, jsonResponse, monitorOverview } from './fixtures';

describe('SystemMonitorPage', () => {
  it('renders real inventory, queue, health and activity metrics', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/monitor/overview')) return jsonResponse(monitorOverview);
        if (url.includes('/monitor/health')) return jsonResponse(healthReport);
        if (url.includes('/monitor/events')) return jsonResponse(eventsResponse);
        return jsonResponse({}, 404);
      }),
    );

    render(
      <MemoryRouter>
        <SystemMonitorPage />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'System monitor' })).toBeInTheDocument();
    expect(screen.getByText('Zero-overselling invariant')).toBeInTheDocument();
    expect(screen.getByText('Balanced')).toBeInTheDocument();
    expect(
      screen.getByText((_, element) => {
        if (!element) return false;
        const text = element.textContent?.replace(/\s+/g, ' ').trim();
        return text === '499 available + 0 reserved + 1 confirmed = 500';
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Orders queue')).toBeInTheDocument();
    expect(screen.getAllByText('Management API').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1 consumers/).length).toBeGreaterThan(0);
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('Order confirmed; reservation moved to sold ledger')).toBeInTheDocument();
  });

  it('labels unavailable queue metrics instead of inventing depth', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/monitor/overview')) {
          return jsonResponse({
            ...monitorOverview,
            asyncProcessing: {
              ...monitorOverview.asyncProcessing,
              queue: {
                available: false,
                source: 'management-api',
                queues: { main: null, retry: null, deadLetter: null },
                error: 'Management API unreachable',
                latencyMs: null,
              },
            },
          });
        }
        if (url.includes('/monitor/health')) return jsonResponse(healthReport);
        return jsonResponse(eventsResponse);
      }),
    );

    render(
      <MemoryRouter>
        <SystemMonitorPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/management api unreachable/i)).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
  });
});

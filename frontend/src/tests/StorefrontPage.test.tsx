import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorefrontPage } from '../pages/StorefrontPage';
import { apiErrorResponse, flashSale, jsonResponse } from './fixtures';

function renderPage() {
  return render(
    <MemoryRouter>
      <StorefrontPage />
    </MemoryRouter>,
  );
}

describe('StorefrontPage', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows loading state and then the real live stock', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(flashSale)),
    );
    const { container } = renderPage();

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(await screen.findByRole('heading', { name: 'Aether X1 Pro 5G' })).toBeInTheDocument();
    expect(screen.getByTestId('stock-available')).toHaveTextContent('499');
    expect(screen.getByRole('button', { name: /buy now/i })).toBeEnabled();
  });

  it('locks the checkout button and sends exactly one request for a double submit', async () => {
    const user = userEvent.setup();
    let resolveCheckout: ((value: Response) => void) | undefined;
    const checkoutGate = new Promise<Response>((resolve) => {
      resolveCheckout = resolve;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/checkout')) {
        expect(init?.method).toBe('POST');
        return checkoutGate;
      }
      return jsonResponse(flashSale);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();
    await screen.findByRole('heading', { name: 'Aether X1 Pro 5G' });
    await user.click(screen.getByTestId('buy-now'));

    await user.type(screen.getByLabelText(/full name/i), 'Asha Rao');
    await user.type(screen.getByLabelText(/email for order updates/i), 'asha@example.com');
    await user.type(
      screen.getByLabelText(/delivery address/i),
      '12 MG Road, Bengaluru, Karnataka 560001',
    );

    const submit = screen.getByTestId('checkout-submit');
    await user.click(submit);
    expect(submit).toBeDisabled();
    await user.click(submit);

    await waitFor(() => {
      const checkoutCalls = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes('/checkout'),
      );
      expect(checkoutCalls).toHaveLength(1);
    });

    await act(async () => {
      resolveCheckout?.(
        jsonResponse({
          orderId: '11111111-2222-4333-8444-555555555555',
          status: 'PENDING',
          trackingUrl: '/orders/11111111-2222-4333-8444-555555555555',
          acceptedAt: '2026-10-28T10:00:00.000Z',
          remainingStock: 498,
          replayed: false,
          message: 'Reservation accepted',
        }),
      );
      await checkoutGate;
    });

    expect(await screen.findByTestId('checkout-success')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /track this order/i })).toHaveAttribute(
      'href',
      '/orders/11111111-2222-4333-8444-555555555555',
    );
  });

  it('shows sold-out feedback without pretending the order succeeded', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/checkout')) {
          return apiErrorResponse(409, 'SOLD_OUT', 'All 500 flash-sale units have been claimed');
        }
        return jsonResponse(flashSale);
      }),
    );

    renderPage();
    await screen.findByRole('heading', { name: 'Aether X1 Pro 5G' });
    await user.click(screen.getByTestId('buy-now'));
    await user.type(screen.getByLabelText(/full name/i), 'Asha Rao');
    await user.type(screen.getByLabelText(/email for order updates/i), 'asha@example.com');
    await user.type(
      screen.getByLabelText(/delivery address/i),
      '12 MG Road, Bengaluru, Karnataka 560001',
    );
    await user.click(screen.getByTestId('checkout-submit'));

    expect(await screen.findByTestId('checkout-soldout')).toBeInTheDocument();
    expect(screen.getByText(/this drop is sold out/i)).toBeInTheDocument();
    expect(screen.queryByTestId('checkout-success')).not.toBeInTheDocument();
  });

  it('renders a real backend failure instead of a fabricated storefront', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    renderPage();
    expect(await screen.findByText(/live inventory is unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/will not guess or simulate availability/i)).toBeInTheDocument();
  });
});

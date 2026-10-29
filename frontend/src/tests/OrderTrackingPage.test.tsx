import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { OrderTrackingPage } from '../pages/OrderTrackingPage';
import { jsonResponse, orderView } from './fixtures';

function renderOrder(id = orderView.order.id) {
  return render(
    <MemoryRouter initialEntries={[`/orders/${id}`]}>
      <Routes>
        <Route path="/orders/:orderId" element={<OrderTrackingPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OrderTrackingPage', () => {
  it('renders the durable order and stops live updates at a terminal state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(orderView)),
    );

    renderOrder();

    expect(await screen.findByText(/order confirmed\. you.re in\./i)).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText(/durable ledger updated/i)).toBeInTheDocument();
    expect(screen.getByText(/updates complete/i)).toBeInTheDocument();
    expect(screen.getByText('A*** R**')).toBeInTheDocument();
  });

  it('shows a not-found state for an unknown order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' } }, 404),
      ),
    );

    renderOrder('99999999-9999-4999-8999-999999999999');
    expect(await screen.findByText(/order not found/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to storefront/i })).toBeInTheDocument();
  });
});

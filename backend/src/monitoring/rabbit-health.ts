import { config, queueNames } from '../config';
import { safeErrorMessage } from '../lib/logger';

interface RabbitQueueStats {
  name: string;
  ready: number | null;
  unacknowledged: number | null;
  consumers: number | null;
}

export interface RabbitMetrics {
  available: boolean;
  source: 'management-api';
  queues: {
    main: RabbitQueueStats | null;
    retry: RabbitQueueStats | null;
    deadLetter: RabbitQueueStats | null;
  };
  error: string | null;
  latencyMs: number | null;
}

function basicAuth(): string {
  const user = config.RABBITMQ_MANAGEMENT_USER ?? 'guest';
  const password = config.RABBITMQ_MANAGEMENT_PASSWORD ?? 'guest';
  return Buffer.from(`${user}:${password}`).toString('base64');
}

function managementBase(): string {
  return config.RABBITMQ_MANAGEMENT_URL.replace(/\/$/, '');
}

async function fetchJson(path: string, timeoutMs = 2500): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${managementBase()}${path}`, {
      headers: { Authorization: `Basic ${basicAuth()}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`RabbitMQ management returned HTTP ${response.status}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

interface QueueResponse {
  messages?: number;
  messages_ready?: number;
  messages_unacknowledged?: number;
  consumers?: number;
}

function queuePath(name: string): string {
  return `/api/queues/%2F/${encodeURIComponent(name)}`;
}

export async function getRabbitMetrics(): Promise<RabbitMetrics> {
  const started = Date.now();
  const empty: RabbitMetrics = {
    available: false,
    source: 'management-api',
    queues: { main: null, retry: null, deadLetter: null },
    error: null,
    latencyMs: null,
  };

  try {
    const [main, retry, dlq] = await Promise.all([
      fetchJson(queuePath(queueNames.queue)) as Promise<QueueResponse>,
      fetchJson(queuePath(queueNames.retryQueue)).catch(() => null) as Promise<QueueResponse | null>,
      fetchJson(queuePath(queueNames.deadLetterQueue)).catch(() => null) as Promise<QueueResponse | null>,
    ]);

    return {
      available: true,
      source: 'management-api',
      queues: {
        main: {
          name: queueNames.queue,
          ready: main.messages_ready ?? null,
          unacknowledged: main.messages_unacknowledged ?? null,
          consumers: main.consumers ?? null,
        },
        retry: retry
          ? {
              name: queueNames.retryQueue,
              ready: retry.messages_ready ?? null,
              unacknowledged: retry.messages_unacknowledged ?? null,
              consumers: retry.consumers ?? null,
            }
          : null,
        deadLetter: dlq
          ? {
              name: queueNames.deadLetterQueue,
              ready: dlq.messages_ready ?? null,
              unacknowledged: dlq.messages_unacknowledged ?? null,
              consumers: dlq.consumers ?? null,
            }
          : null,
      },
      error: null,
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ...empty,
      error: safeErrorMessage(error),
      latencyMs: Date.now() - started,
    };
  }
}

export async function checkRabbitManagementHealthy(): Promise<{
  ok: boolean;
  latencyMs: number;
  error: string | null;
  queues: string[];
}> {
  const started = Date.now();
  try {
    await fetchJson('/api/overview');
    return {
      ok: true,
      latencyMs: Date.now() - started,
      error: null,
      queues: [queueNames.queue, queueNames.retryQueue, queueNames.deadLetterQueue],
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: safeErrorMessage(error),
      queues: [],
    };
  }
}

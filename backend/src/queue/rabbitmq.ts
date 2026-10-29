import amqp, { Connection, ConfirmChannel, ConsumeMessage } from 'amqplib';
import { config, queueNames } from '../config';
import { logger, safeErrorMessage } from '../lib/logger';

let model: Connection | null = null;
let confirmChannel: ConfirmChannel | null = null;
let connecting: Promise<{ model: Connection; channel: ConfirmChannel }> | null = null;

export async function assertTopology(channel: ConfirmChannel): Promise<void> {
  await channel.assertExchange(queueNames.exchange, 'direct', { durable: true });
  await channel.assertExchange(queueNames.deadLetterExchange, 'direct', { durable: true });

  await channel.assertQueue(queueNames.queue, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': queueNames.deadLetterExchange,
      'x-dead-letter-routing-key': queueNames.routingKey,
    },
  });
  await channel.bindQueue(queueNames.queue, queueNames.exchange, queueNames.routingKey);

  await channel.assertQueue(queueNames.retryQueue, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': queueNames.exchange,
      'x-dead-letter-routing-key': queueNames.routingKey,
    },
  });
  await channel.bindQueue(queueNames.retryQueue, queueNames.exchange, 'order.retry');

  await channel.assertQueue(queueNames.deadLetterQueue, { durable: true });
  await channel.bindQueue(
    queueNames.deadLetterQueue,
    queueNames.deadLetterExchange,
    queueNames.routingKey,
  );
}

async function connect(role: string): Promise<{ model: Connection; channel: ConfirmChannel }> {
  if (confirmChannel && model) return { model, channel: confirmChannel };
  if (connecting) return connecting;

  connecting = (async () => {
    logger.info('Connecting to RabbitMQ', { role });
    const connection = await amqp.connect(config.RABBITMQ_URL, {
      heartbeat: 15,
      timeout: 10_000,
    });
    connection.on('error', (error) => logger.warn('RabbitMQ connection error', { role, error: error.message }));
    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed', { role });
      model = null;
      confirmChannel = null;
    });

    const channel = await connection.createConfirmChannel();
    channel.on('error', (error) => logger.warn('RabbitMQ channel error', { role, error: error.message }));
    await assertTopology(channel);

    model = connection;
    confirmChannel = channel;
    logger.info('RabbitMQ connected and topology asserted', { role });
    return { model: connection, channel };
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export async function getPublisherChannel(role = 'publisher'): Promise<ConfirmChannel> {
  const { channel } = await connect(role);
  return channel;
}

async function publishConfirmed(
  channel: ConfirmChannel,
  exchange: string,
  routingKey: string,
  payload: unknown,
  options: amqp.Options.Publish,
): Promise<void> {
  const buffer = Buffer.from(JSON.stringify(payload));
  await new Promise<void>((resolve, reject) => {
    channel.publish(exchange, routingKey, buffer, { ...options, persistent: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function publishOrderReserved(
  payload: unknown,
  outboxEventId: string,
): Promise<void> {
  const channel = await getPublisherChannel();
  await publishConfirmed(channel, queueNames.exchange, queueNames.routingKey, payload, {
    contentType: 'application/json',
    messageId: outboxEventId,
    timestamp: Math.floor(Date.now() / 1000),
    headers: { 'x-outbox-id': outboxEventId, 'x-attempt': 0 },
  });
}

export async function publishRetry(
  payload: unknown,
  outboxEventId: string,
  attempt: number,
  delayMs: number,
): Promise<void> {
  const channel = await getPublisherChannel('worker-retry');
  await publishConfirmed(channel, queueNames.exchange, 'order.retry', payload, {
    contentType: 'application/json',
    messageId: `${outboxEventId}:retry:${attempt}`,
    expiration: String(delayMs),
    timestamp: Math.floor(Date.now() / 1000),
    headers: { 'x-outbox-id': outboxEventId, 'x-attempt': attempt },
  });
}

export async function publishToDeadLetter(
  payload: unknown,
  outboxEventId: string,
  reason: string,
): Promise<void> {
  const channel = await getPublisherChannel('dead-letter');
  await publishConfirmed(
    channel,
    queueNames.deadLetterExchange,
    queueNames.routingKey,
    payload,
    {
      contentType: 'application/json',
      messageId: `${outboxEventId}:dead`,
      timestamp: Math.floor(Date.now() / 1000),
      headers: { 'x-outbox-id': outboxEventId, 'x-failure-reason': reason },
    },
  );
}

export interface ConsumedOrderMessage {
  orderId: string;
  attempt: number;
  outboxEventId: string;
}

export function parseOrderMessage(message: ConsumeMessage): ConsumedOrderMessage {
  const content = JSON.parse(message.content.toString('utf8')) as {
    orderId?: unknown;
    eventId?: unknown;
  };
  if (typeof content.orderId !== 'string' || content.orderId.length < 10) {
    throw new Error('Message is missing a valid orderId');
  }
  const headerAttempt = message.properties.headers?.['x-attempt'];
  const attempt = typeof headerAttempt === 'number' ? headerAttempt : Number(headerAttempt ?? 0);
  return {
    orderId: content.orderId,
    attempt: Number.isFinite(attempt) ? attempt : 0,
    outboxEventId:
      (message.properties.headers?.['x-outbox-id'] as string | undefined) ??
      message.properties.messageId ??
      'unknown',
  };
}

export async function createConsumerChannel(role: string): Promise<{
  channel: amqp.Channel;
  connection: Connection;
}> {
  const connection = await amqp.connect(config.RABBITMQ_URL, { heartbeat: 15, timeout: 10_000 });
  const channel = await connection.createChannel();
  await channel.prefetch(config.WORKER_PREFETCH);
  await assertTopology(channel as unknown as ConfirmChannel);
  return { channel, connection };
}

export async function getQueueDepths(): Promise<{
  queue: { ready: number; unacked: number; consumers: number } | null;
  retry: { ready: number; unacked: number } | null;
  deadLetter: { ready: number } | null;
}> {
  const channel = await getPublisherChannel('queue-depth');
  const inspect = async (name: string) => {
    try {
      const result = await channel.checkQueue(name);
      return result;
    } catch (error) {
      logger.debug('Queue inspection failed', { queue: name, error: safeErrorMessage(error) });
      return null;
    }
  };

  const [main, retry, dlq] = await Promise.all([
    inspect(queueNames.queue),
    inspect(queueNames.retryQueue),
    inspect(queueNames.deadLetterQueue),
  ]);

  return {
    queue: main
      ? { ready: main.messageCount, unacked: main.consumerCount, consumers: main.consumerCount }
      : null,
    retry: retry ? { ready: retry.messageCount, unacked: 0 } : null,
    deadLetter: dlq ? { ready: dlq.messageCount } : null,
  };
}

export async function closeRabbit(): Promise<void> {
  try {
    await confirmChannel?.close();
  } catch {
    // ignore
  }
  try {
    await model?.close();
  } catch {
    // ignore
  }
  confirmChannel = null;
  model = null;
}

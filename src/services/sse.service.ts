import { Response } from 'express';
import { logger } from '../utils/logger.util';

/**
 * Live delivery to a screen that is currently open.
 *
 * Server-sent events rather than WebSockets, on purpose: the traffic is
 * entirely one-way (the server tells the client something happened), SSE
 * survives proxies that mangle upgrades, and the browser reconnects on its own
 * without a library. The gate console is the case that demanded it — a guard
 * must see an approval come back within a second or two, and polling every
 * second from every gate device is a load nobody needs to carry.
 *
 * This is in-process state, and that is a real limit worth naming: with more
 * than one Node process, a client connected to process A will not see an event
 * emitted on process B. Today the deployment is single-process. The moment it
 * is not, this file grows a Redis pub/sub behind the same two functions and
 * nothing else in the codebase changes — which is why every caller goes
 * through `publish` rather than touching the registry.
 */

interface Client {
  id: number;
  userId: string;
  societyId: string;
  res: Response;
}

const clients = new Map<number, Client>();
let nextId = 1;

/** Heartbeat. Proxies close a connection that has been silent, and the client would only find out on its next action. */
const HEARTBEAT_MS = 25_000;
let heartbeat: NodeJS.Timeout | null = null;

function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const c of clients.values()) {
      try { c.res.write(': ping\n\n'); } catch { drop(c.id); }
    }
  }, HEARTBEAT_MS);
  // Do not hold the process open for the sake of a heartbeat.
  heartbeat.unref?.();
}

function stopHeartbeatIfIdle() {
  if (heartbeat && clients.size === 0) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

function drop(id: number) {
  const c = clients.get(id);
  if (!c) return;
  clients.delete(id);
  try { c.res.end(); } catch { /* already gone */ }
  stopHeartbeatIfIdle();
}

/**
 * Attach a client. Returns a teardown the route registers on 'close'.
 */
export function subscribe(res: Response, userId: string, societyId: string): () => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx buffers text/event-stream by default and the whole thing appears
    // to work while delivering nothing until the buffer fills.
    'X-Accel-Buffering': 'no',
  });
  // Tell the browser how long to wait before reconnecting, and open the stream
  // with a real event so the client's onopen fires immediately.
  res.write('retry: 5000\n\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  res.flushHeaders?.();

  const id = nextId++;
  clients.set(id, { id, userId, societyId, res });
  startHeartbeat();

  return () => drop(id);
}

/**
 * Send an event to specific people. Silent when nobody is listening — which is
 * the normal case, and precisely why the notification record is written first.
 */
export function publish(societyId: string, userIds: string[], event: string, data: unknown): number {
  if (!userIds.length || clients.size === 0) return 0;
  const wanted = new Set(userIds.map(String));
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  let sent = 0;
  for (const c of clients.values()) {
    if (c.societyId !== societyId || !wanted.has(c.userId)) continue;
    try { c.res.write(frame); sent++; } catch { drop(c.id); }
  }
  return sent;
}

/** Everyone in the society who is currently watching — for gate-wide events. */
export function publishToSociety(societyId: string, event: string, data: unknown): number {
  if (clients.size === 0) return 0;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let sent = 0;
  for (const c of clients.values()) {
    if (c.societyId !== societyId) continue;
    try { c.res.write(frame); sent++; } catch { drop(c.id); }
  }
  return sent;
}

/** How many screens are open. Diagnostics only. */
export function connectionCount(): number {
  return clients.size;
}

/** Close everything — used on shutdown so the process can exit cleanly. */
export function closeAll(): void {
  for (const id of [...clients.keys()]) drop(id);
  logger.info('SSE: all client connections closed.');
}

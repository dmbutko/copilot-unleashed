import { WebSocket } from 'ws';
import type { CopilotClient } from '@github/copilot-sdk';
import { config } from '../config.js';
import { createCopilotClient } from '../copilot/client.js';

const MAX_BUFFER_SIZE = 500;
const TAB_ID_PATTERN = /^[a-z0-9_-]{1,64}$/i;

// Control message types that should be prioritized in the buffer (never evicted before data messages)
const CONTROL_MESSAGE_TYPES = new Set([
  'connected', 'cold_resume', 'session_created', 'session_resumed', 'session_reconnected',
  'turn_start', 'turn_end', 'error', 'warning',
  'session_shutdown', 'mode_changed', 'model_changed', 'title_changed',
  'permission_request', 'user_input_request',
  'tool_start', 'tool_end', 'session_idle', 'task_complete',
  'compaction_start', 'compaction_complete',
]);

/** Threshold for considering a client connection stale (no ping received). */
export const CLIENT_STALE_MS = 35_000;

/** Maximum background sessions per pool entry (tab). */
const MAX_BACKGROUND_SESSIONS = 3;

export type BackgroundSessionStatus = 'running' | 'completed' | 'errored';

export interface BackgroundSession {
  /** Self-contained pool entry with its own client+session and ws:null for buffering */
  entry: PoolEntry;
  sdkSessionId: string;
  model: string | null;
  title: string | null;
  status: BackgroundSessionStatus;
  parkedAt: number;
}

export interface PoolEntry {
  client: CopilotClient;
  session: any;
  /** SDK session ID for cold resume — stored when session is created */
  sdkSessionId: string | null;
  /** Current model for session resume */
  model: string | null;
  /** Current session mode */
  mode: string | null;
  ws: WebSocket | null;
  messageBuffer: Record<string, unknown>[];
  ttlTimer: NodeJS.Timeout | null;
  userInputResolve: ((response: { answer: string; wasFreeform: boolean }) => void) | null;
  /** Map of pending permission resolvers keyed by requestId — supports concurrent permission requests */
  permissionResolves: Map<string, (decision: string) => void>;
  permissionPreferences: Map<string, 'allow' | 'deny'>;
  isProcessing: boolean;
  /** Monotonically increasing sequence number for message ordering */
  seq: number;
  /** Stored pending user input prompt for re-send on reconnect */
  pendingUserInputPrompt: Record<string, unknown> | null;
  /** Map of pending permission prompts keyed by requestId — re-sent on reconnect */
  pendingPermissionPrompts: Map<string, Record<string, unknown>>;
  /** Current reasoning effort level for the session */
  reasoningEffort: string | null;
  /** Timestamp of the last client ping — used to detect backgrounded/suspended apps */
  lastPingAt: number;
  /** Latest workspace cwd reported by the SDK session */
  workspaceCwd: string | null;
  /** Latest git root reported by the SDK session */
  workspaceGitRoot: string | null;
  /** Background sessions parked while user works in another session */
  backgroundSessions: Map<string, BackgroundSession>;
}

export const sessionPool = new Map<string, PoolEntry>();

export function createPoolEntry(client: CopilotClient, ws: WebSocket): PoolEntry {
  return {
    client,
    session: null,
    sdkSessionId: null,
    model: null,
    mode: null,
    ws,
    messageBuffer: [],
    ttlTimer: null,
    userInputResolve: null,
    permissionResolves: new Map(),
    permissionPreferences: new Map(),
    isProcessing: false,
    seq: 0,
    pendingUserInputPrompt: null,
    pendingPermissionPrompts: new Map(),
    reasoningEffort: null,
    lastPingAt: Date.now(),
    workspaceCwd: null,
    workspaceGitRoot: null,
    backgroundSessions: new Map(),
  };
}

export async function destroyPoolEntry(entry: PoolEntry): Promise<void> {
  if (entry.ttlTimer) {
    clearTimeout(entry.ttlTimer);
    entry.ttlTimer = null;
  }
  if (entry.session) {
    try { await entry.session.disconnect(); } catch { /* ignore */ }
    entry.session = null;
  }
  // Clean up all background sessions
  for (const bg of entry.backgroundSessions.values()) {
    try { await bg.entry.session?.disconnect(); } catch { /* ignore */ }
    try { await bg.entry.client.stop(); } catch { /* ignore */ }
  }
  entry.backgroundSessions.clear();
  entry.userInputResolve = null;
  entry.permissionResolves.clear();
  entry.pendingUserInputPrompt = null;
  entry.pendingPermissionPrompts.clear();
  entry.permissionPreferences.clear();
  try { await entry.client.stop(); } catch { /* ignore */ }
}

/** True when the client WS is closed or hasn't sent a ping recently (e.g. iOS backgrounded). */
export function isClientUnreachable(entry: PoolEntry): boolean {
  if (!entry.ws || entry.ws.readyState !== WebSocket.OPEN) return true;
  return Date.now() - entry.lastPingAt > CLIENT_STALE_MS;
}

export function poolSend(entry: PoolEntry, data: Record<string, unknown>): void {
  const seqData = { ...data, seq: entry.seq++ };
  if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
    entry.ws.send(JSON.stringify(seqData));
  } else {
    if (entry.messageBuffer.length >= MAX_BUFFER_SIZE) {
      // Evict oldest data (non-control) message first to preserve important messages
      const dataIdx = entry.messageBuffer.findIndex(
        (m) => !CONTROL_MESSAGE_TYPES.has(m.type as string),
      );
      if (dataIdx >= 0) {
        entry.messageBuffer.splice(dataIdx, 1);
      } else {
        entry.messageBuffer.shift();
      }
    }
    entry.messageBuffer.push(seqData);
  }
}

/**
 * Park the current foreground session into the background.
 *
 * Key insight: wireSessionEvents() handlers close over the `entry` reference they
 * were wired with.  We can't remove those listeners (SDK limitation) and we can't
 * redirect them by mutating fields on a *different* object.  So instead of copying
 * fields into a new bgEntry, we keep the ORIGINAL entry as-is (it becomes the
 * background) and null its `ws` so poolSend auto-buffers.  A brand-new PoolEntry
 * with a fresh CopilotClient takes over the foreground in the session pool.
 *
 * Returns the new foreground entry (caller must use it for subsequent operations)
 * and the background session metadata.
 */
export function parkSession(
  entry: PoolEntry,
  githubToken: string,
  poolKey: string,
): { newEntry: PoolEntry; bgSession: BackgroundSession } | null {
  if (!entry.session) return null;

  const sessionId = entry.sdkSessionId || entry.session?.sessionId;
  if (!sessionId) {
    // No session ID — can't park, just disconnect
    try { entry.session.disconnect(); } catch { /* ignore */ }
    entry.session = null;
    entry.sdkSessionId = null;
    entry.isProcessing = false;
    return null;
  }

  // Save the WS reference before nulling it on the old entry
  const ws = entry.ws;
  if (!ws) {
    // No active WS — just disconnect, can't park properly
    try { entry.session.disconnect(); } catch { /* ignore */ }
    entry.session = null;
    entry.sdkSessionId = null;
    entry.isProcessing = false;
    return null;
  }

  // Null the WS on the ORIGINAL entry — its wired event handlers will now
  // auto-buffer via poolSend(entry, ...) instead of sending to the WebSocket
  entry.ws = null;

  // The original entry IS the background session now
  const bg: BackgroundSession = {
    entry,
    sdkSessionId: sessionId,
    model: entry.model,
    title: null,
    status: entry.isProcessing ? 'running' : 'completed',
    parkedAt: Date.now(),
  };

  // Create a brand-new foreground entry with the saved WS + fresh client
  const newEntry = createPoolEntry(
    createCopilotClient(githubToken, config.copilotConfigDir),
    ws,
  );

  // Transfer all existing background sessions from the old entry to the new one
  for (const [id, bgSession] of entry.backgroundSessions) {
    newEntry.backgroundSessions.set(id, bgSession);
  }
  entry.backgroundSessions = new Map();

  // Register the old entry as a background session on the new foreground
  newEntry.backgroundSessions.set(sessionId, bg);

  // Replace the pool entry so subsequent WS messages use the new foreground
  sessionPool.set(poolKey, newEntry);

  // Evict oldest completed background sessions if over the cap
  evictOldestBackground(newEntry);

  // Wire status notifications using poolKey lookup (survives further swaps)
  wireBackgroundStatusNotifications(poolKey, bg);

  return { newEntry, bgSession: bg };
}

/**
 * Move a background session back to the foreground.
 *
 * The background session's original entry is restored as the pool entry.
 * Its event handlers (which close over that entry) regain access to the WS.
 * The current foreground entry's client is stopped.
 *
 * Returns the new foreground entry and buffered messages to replay.
 */
export async function unparkSession(
  entry: PoolEntry,
  sessionId: string,
  poolKey: string,
): Promise<{ newEntry: PoolEntry; buffered: Record<string, unknown>[] } | null> {
  const bg = entry.backgroundSessions.get(sessionId);
  if (!bg) return null;

  // Save the WS from the current foreground
  const ws = entry.ws;

  // Stop the current foreground (may have just been created by parkSession)
  if (entry.session) {
    try { await entry.session.disconnect(); } catch { /* ignore */ }
  }
  try { await entry.client.stop(); } catch { /* ignore */ }

  // Restore the WS on the background entry — its wired handlers will now
  // send to the WebSocket again instead of buffering
  bg.entry.ws = ws;

  // Transfer remaining background sessions to the restored entry
  for (const [id, bgSession] of entry.backgroundSessions) {
    if (id !== sessionId) {
      bg.entry.backgroundSessions.set(id, bgSession);
    }
  }
  entry.backgroundSessions.clear();

  // Grab and clear the buffered messages for replay
  const buffered = bg.entry.messageBuffer.splice(0);

  // Replace in the session pool
  sessionPool.set(poolKey, bg.entry);

  return { newEntry: bg.entry, buffered };
}

/** Wire event-based status notifications for a background session.
 * Uses poolKey to look up the current foreground entry at notification time,
 * so notifications survive further park/unpark cycles.
 */
function wireBackgroundStatusNotifications(poolKey: string, bg: BackgroundSession): void {
  const session = bg.entry.session;
  if (!session) return;

  const sendStatus = () => {
    const current = sessionPool.get(poolKey);
    if (current) sendBackgroundStatus(current, bg);
  };

  session.on('assistant.turn_end', () => {
    bg.status = 'completed';
    sendStatus();
  });
  session.on('session.idle', () => {
    bg.status = 'completed';
    sendStatus();
  });
  session.on('session.task_complete', () => {
    bg.status = 'completed';
    sendStatus();
  });
  session.on('session.error', () => {
    bg.status = 'errored';
    sendStatus();
  });
  session.on('session.title_changed', (event: any) => {
    bg.title = event.data?.title ?? bg.title;
    sendStatus();
  });
  session.on('session.shutdown', () => {
    const current = sessionPool.get(poolKey);
    if (current) {
      current.backgroundSessions.delete(bg.sdkSessionId);
    }
    try { bg.entry.client.stop(); } catch { /* ignore */ }
  });
}

/** Send a background_session_status message to the foreground WS */
function sendBackgroundStatus(foreground: PoolEntry, bg: BackgroundSession): void {
  poolSend(foreground, {
    type: 'background_session_status',
    sessionId: bg.sdkSessionId,
    status: bg.status,
    title: bg.title,
    model: bg.model,
    bufferedCount: bg.entry.messageBuffer.length,
  });
}

/** Evict oldest completed background sessions to stay within the cap. */
function evictOldestBackground(entry: PoolEntry): void {
  while (entry.backgroundSessions.size > MAX_BACKGROUND_SESSIONS) {
    let evictId: string | null = null;
    let evictTime = Infinity;

    // Prefer evicting completed/errored over running
    for (const [id, bg] of entry.backgroundSessions) {
      if (bg.status !== 'running' && bg.parkedAt < evictTime) {
        evictId = id;
        evictTime = bg.parkedAt;
      }
    }
    if (!evictId) {
      for (const [id, bg] of entry.backgroundSessions) {
        if (bg.parkedAt < evictTime) {
          evictId = id;
          evictTime = bg.parkedAt;
        }
      }
    }
    if (!evictId) break;

    const bg = entry.backgroundSessions.get(evictId);
    if (bg) {
      try { bg.entry.session?.disconnect(); } catch { /* ignore */ }
      try { bg.entry.client.stop(); } catch { /* ignore */ }
    }
    entry.backgroundSessions.delete(evictId);
  }
}

export async function cleanupAllSessions(): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [key, entry] of sessionPool) {
    promises.push(destroyPoolEntry(entry));
    sessionPool.delete(key);
  }
  await Promise.allSettled(promises);
}

/** Validate that a tabId is a UUID-like string (max 36 chars, alphanumeric + hyphens) */
export function isValidTabId(tabId: string): boolean {
  return TAB_ID_PATTERN.test(tabId);
}

/** Destroy all pool entries for a specific user (e.g., on logout or token revocation) */
export async function cleanupUserSessions(username: string): Promise<void> {
  const prefix = `${username}:`;
  const promises: Promise<void>[] = [];
  for (const [key, entry] of sessionPool) {
    if (key.startsWith(prefix)) {
      promises.push(destroyPoolEntry(entry));
      sessionPool.delete(key);
    }
  }
  await Promise.allSettled(promises);
}

/** Send a message to all pool entries with an active WebSocket */
export function broadcastToAll(data: Record<string, unknown>): void {
  for (const entry of sessionPool.values()) {
    if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(JSON.stringify(data));
    }
  }
}

/** Count active pool entries for a specific user */
export function countUserSessions(username: string): number {
  const prefix = `${username}:`;
  let count = 0;
  for (const key of sessionPool.keys()) {
    if (key.startsWith(prefix)) count++;
  }
  return count;
}

/** Find and destroy the oldest pool entry for a user (the one with no active WS or earliest TTL) */
export async function evictOldestUserSession(username: string): Promise<void> {
  const prefix = `${username}:`;
  let oldestKey: string | null = null;
  let oldestHasWs = true;

  for (const [key, entry] of sessionPool) {
    if (!key.startsWith(prefix)) continue;
    // Prefer evicting entries without an active WebSocket
    const hasWs = entry.ws !== null && entry.ws.readyState === WebSocket.OPEN;
    if (oldestKey === null || (!hasWs && oldestHasWs)) {
      oldestKey = key;
      oldestHasWs = hasWs;
    }
  }

  if (oldestKey) {
    const entry = sessionPool.get(oldestKey);
    if (entry) {
      // Notify the client before destroying so it can show a meaningful message
      if (entry.ws && entry.ws.readyState === WebSocket.OPEN) {
        try {
          entry.ws.send(JSON.stringify({ type: 'error', message: 'Session evicted — too many active sessions. Please refresh to reconnect.' }));
          entry.ws.close(4003, 'Session evicted');
        } catch { /* ignore */ }
      }
      await destroyPoolEntry(entry);
      sessionPool.delete(oldestKey);
    }
  }
}

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
 * The old { client, session } pair moves to a background PoolEntry with ws:null,
 * so the existing event handlers (which close over that entry) auto-buffer via poolSend.
 * A new CopilotClient is created for the foreground.
 */
export function parkSession(
  entry: PoolEntry,
  githubToken: string,
): BackgroundSession | null {
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

  // Create a background PoolEntry that owns the old client+session
  // ws:null means poolSend will buffer all messages automatically
  const bgEntry: PoolEntry = {
    client: entry.client,
    session: entry.session,
    sdkSessionId: sessionId,
    model: entry.model,
    mode: entry.mode,
    ws: null,
    messageBuffer: [],
    ttlTimer: null,
    userInputResolve: entry.userInputResolve,
    permissionResolves: entry.permissionResolves,
    permissionPreferences: entry.permissionPreferences,
    isProcessing: entry.isProcessing,
    seq: 0,
    pendingUserInputPrompt: entry.pendingUserInputPrompt,
    pendingPermissionPrompts: entry.pendingPermissionPrompts,
    reasoningEffort: entry.reasoningEffort,
    lastPingAt: 0,
    workspaceCwd: entry.workspaceCwd,
    workspaceGitRoot: entry.workspaceGitRoot,
    backgroundSessions: new Map(),
  };

  const bg: BackgroundSession = {
    entry: bgEntry,
    sdkSessionId: sessionId,
    model: entry.model,
    title: null,
    status: entry.isProcessing ? 'running' : 'completed',
    parkedAt: Date.now(),
  };

  entry.backgroundSessions.set(sessionId, bg);

  // Create a fresh client for the foreground
  entry.client = createCopilotClient(githubToken, config.copilotConfigDir);
  entry.session = null;
  entry.sdkSessionId = null;
  entry.userInputResolve = null;
  entry.permissionResolves = new Map();
  entry.permissionPreferences = new Map();
  entry.pendingUserInputPrompt = null;
  entry.pendingPermissionPrompts = new Map();
  entry.isProcessing = false;

  // Evict oldest completed background sessions if over the cap
  evictOldestBackground(entry);

  // Wire status notifications: when background session completes/errors,
  // notify the foreground WS
  wireBackgroundStatusNotifications(entry, bg);

  return bg;
}

/**
 * Move a background session back to the foreground.
 * Returns the buffered messages to replay, or null if not found.
 */
export async function unparkSession(
  entry: PoolEntry,
  sessionId: string,
): Promise<Record<string, unknown>[] | null> {
  const bg = entry.backgroundSessions.get(sessionId);
  if (!bg) return null;

  // Park the current foreground if there is one (but we don't have githubToken here
  // so we just disconnect it - the caller should park first if needed)
  if (entry.session) {
    try { await entry.session.disconnect(); } catch { /* ignore */ }
  }
  // Stop the current foreground client
  try { await entry.client.stop(); } catch { /* ignore */ }

  // Swap the background entry's client+session back to foreground
  entry.client = bg.entry.client;
  entry.session = bg.entry.session;
  entry.sdkSessionId = bg.sdkSessionId;
  entry.model = bg.model;
  entry.mode = bg.entry.mode;
  entry.isProcessing = bg.status === 'running';

  // Restore the WS reference so poolSend sends to the client again
  bg.entry.ws = entry.ws;

  const buffered = bg.entry.messageBuffer;
  entry.backgroundSessions.delete(sessionId);
  return buffered;
}

/** Wire event-based status notifications for a background session */
function wireBackgroundStatusNotifications(foreground: PoolEntry, bg: BackgroundSession): void {
  const session = bg.entry.session;
  if (!session) return;

  // Listen for terminal events to update status and notify foreground
  session.on('assistant.turn_end', () => {
    bg.status = 'completed';
    sendBackgroundStatus(foreground, bg);
  });
  session.on('session.idle', () => {
    bg.status = 'completed';
    sendBackgroundStatus(foreground, bg);
  });
  session.on('session.task_complete', () => {
    bg.status = 'completed';
    sendBackgroundStatus(foreground, bg);
  });
  session.on('session.error', () => {
    bg.status = 'errored';
    sendBackgroundStatus(foreground, bg);
  });
  session.on('session.title_changed', (event: any) => {
    bg.title = event.data?.title ?? bg.title;
    sendBackgroundStatus(foreground, bg);
  });
  session.on('session.shutdown', () => {
    foreground.backgroundSessions.delete(bg.sdkSessionId);
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

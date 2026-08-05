/**
 * The smallest Chrome DevTools Protocol client that can drive this extension.
 *
 * Node has had a global WebSocket since 22, which is the only reason a CDP
 * client can be 90 lines with no dependencies. Sessions use flat mode: one
 * socket to the browser endpoint carries every target, tagged by sessionId,
 * so there is a single connection to open and a single one to close.
 */
const RESERVED = Symbol('cdp-close');

export class Cdp {
  #socket;

  #nextId = 1;

  /** id -> {resolve, reject} for calls still in flight. */
  #pending = new Map();

  /** "Domain.event" -> Set<handler>. Handlers get (params, sessionId). */
  #listeners = new Map();

  #closed = null;

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => this.#receive(event.data));
    socket.addEventListener('close', () => this.#fail(new Error('DevTools socket closed')));
    socket.addEventListener('error', () => this.#fail(new Error('DevTools socket errored')));
  }

  static async open(url, { timeout = 30000 } = {}) {
    if (typeof WebSocket !== 'function') {
      throw new Error('this harness needs a global WebSocket; run it on Node 22 or newer');
    }
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`DevTools socket did not open within ${timeout}ms`)), timeout);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('DevTools socket refused')); }, { once: true });
    });
    return new Cdp(socket);
  }

  #receive(data) {
    const message = JSON.parse(typeof data === 'string' ? data : String(data));

    if (message.id !== undefined) {
      const slot = this.#pending.get(message.id);
      if (!slot) return;
      this.#pending.delete(message.id);
      if (message.error) {
        slot.reject(new Error(`${slot.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`));
      } else {
        slot.resolve(message.result ?? {});
      }
      return;
    }

    for (const handler of this.#listeners.get(message.method) ?? []) {
      handler(message.params ?? {}, message.sessionId);
    }
  }

  #fail(error) {
    if (this.#closed === RESERVED) return; // an expected close, not a failure
    this.#closed ??= error;
    for (const slot of this.#pending.values()) slot.reject(error);
    this.#pending.clear();
  }

  send(method, params = {}, sessionId = undefined) {
    if (this.#closed && this.#closed !== RESERVED) return Promise.reject(this.#closed);
    const id = this.#nextId++;
    const frame = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      try {
        this.#socket.send(JSON.stringify(frame));
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  on(event, handler) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(handler);
    return () => this.#listeners.get(event)?.delete(handler);
  }

  /** Resolve with the params of the next `event`, or reject on timeout. */
  once(event, { timeout = 30000, filter = () => true } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${event}`)); }, timeout);
      const off = this.on(event, (params, sessionId) => {
        if (!filter(params, sessionId)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  close() {
    this.#closed = RESERVED;
    try {
      this.#socket.close();
    } catch { /* already gone */ }
  }
}

/**
 * Marionette, the automation server built into Firefox.
 *
 * geckodriver is a WebDriver front end onto this protocol. Talking to it
 * directly means the suite needs no driver binary to be installed or matched to
 * a Firefox version — the server is already in the browser we are testing.
 *
 * The wire format is length-prefixed JSON: `27:[0,1,"WebDriver:Navigate",{}]`.
 * A command is [0, id, name, params]; a reply is [1, id, error, result], where
 * `error` is null when the command worked.
 */
import { connect } from 'node:net';

const COMMAND = 0;

export class Marionette {
  #socket;

  #nextId = 1;

  #pending = new Map();

  /** Bytes received but not yet a complete packet. */
  #buffer = Buffer.alloc(0);

  /** Resolved with the server's hello packet, which arrives unprompted. */
  #hello;

  #announce;

  #broken = null;

  constructor(socket) {
    this.#socket = socket;
    this.#hello = new Promise((resolve) => { this.#announce = resolve; });

    socket.on('data', (chunk) => this.#feed(chunk));
    socket.on('close', () => this.#fail(new Error('Marionette connection closed')));
    socket.on('error', (error) => this.#fail(error));
  }

  static async connect(port, { host = '127.0.0.1', timeout = 60000 } = {}) {
    const deadline = Date.now() + timeout;

    for (;;) {
      try {
        const socket = await new Promise((resolve, reject) => {
          const s = connect({ port, host });
          s.once('connect', () => resolve(s));
          s.once('error', reject);
        });
        socket.setNoDelay(true);
        const client = new Marionette(socket);
        await client.hello();
        return client;
      } catch (error) {
        if (Date.now() > deadline) {
          throw new Error(`Marionette never came up on port ${port}: ${error.message}`, { cause: error });
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  hello() {
    return this.#hello;
  }

  #feed(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    for (;;) {
      const colon = this.#buffer.indexOf(0x3a); // ':'
      if (colon < 0) return;

      const length = Number(this.#buffer.subarray(0, colon).toString('ascii'));
      if (!Number.isInteger(length)) {
        this.#fail(new Error(`Marionette sent a packet with no length: ${this.#buffer.subarray(0, 40)}`));
        return;
      }

      const start = colon + 1;
      if (this.#buffer.length < start + length) return; // wait for the rest

      const body = this.#buffer.subarray(start, start + length).toString('utf8');
      this.#buffer = this.#buffer.subarray(start + length);
      this.#dispatch(JSON.parse(body));
    }
  }

  #dispatch(packet) {
    // The hello packet is an object, not the [type, id, ...] array a reply is.
    if (!Array.isArray(packet)) {
      this.#announce(packet);
      return;
    }

    const [, id, error, result] = packet;
    const slot = this.#pending.get(id);
    if (!slot) return;
    this.#pending.delete(id);

    if (error) {
      const message = error.message ?? error.error ?? JSON.stringify(error);
      const failure = new Error(`${slot.name} failed: ${message}`);
      failure.stacktrace = error.stacktrace;
      slot.reject(failure);
      return;
    }
    slot.resolve(result ?? {});
  }

  #fail(error) {
    if (this.#broken) return;
    this.#broken = error;
    for (const slot of this.#pending.values()) slot.reject(error);
    this.#pending.clear();
  }

  send(name, params = {}) {
    if (this.#broken) return Promise.reject(this.#broken);

    const id = this.#nextId++;
    const body = Buffer.from(JSON.stringify([COMMAND, id, name, params]), 'utf8');

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, name });
      this.#socket.write(`${body.length}:`);
      this.#socket.write(body);
    });
  }

  close() {
    this.#broken ??= new Error('Marionette connection closed by the harness');
    try { this.#socket.destroy(); } catch { /* already gone */ }
  }
}

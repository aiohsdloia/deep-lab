import type {
  ApprovalResponsePayload,
  ClientRequest,
  ClientResponse,
  HostFrame,
  MuxFrame,
  QuestionResponsePayload,
  ServerRequest,
  ServerResponse,
} from "./types";

/**
 * Transport client for the DeepSeek Harness `/api` HTTP+SSE gateway — the dsh
 * client framework's wire protocol. Unary calls POST a `ClientRequest`
 * envelope to `/api/<method>` and read the echoed `ServerResponse`; the two
 * event streams ride WebSocket downlinks at `/api/events.mux` and
 * `/api/events.host` (each frame is a `ServerRequest` whose payload is a
 * `MuxFrame` or `HostFrame`).
 *
 * `DshRuntime` owns session/event folding; this class is transport only.
 */
export class DshApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketCtor: typeof WebSocket | undefined;
  private nextRpcId = 0;

  constructor(options: { baseUrl: string; fetchImpl?: typeof fetch; WebSocket?: typeof WebSocket }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.WebSocketCtor = options.WebSocket ?? globalThis.WebSocket;
  }

  private mintRpcId(): string {
    this.nextRpcId += 1;
    return `${Date.now()}-${this.nextRpcId}`;
  }

  /** One unary call: POST /api/<method> with the ClientRequest envelope. */
  async call<Value = unknown>(
    method: string,
    payload: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<Value> {
    const message: ClientRequest = {
      type: "client-request",
      rpcId: this.mintRpcId(),
      method,
      payload,
    };
    const response = await this.fetchImpl(new URL(`/api/${method}`, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`dsh transport failure for /api/${method}: HTTP ${response.status}`);
    }
    const full = (await response.json()) as ServerResponse;
    if (full.rpcId !== message.rpcId) {
      throw new Error(`dsh rpcId mismatch for ${method}: sent ${message.rpcId}, got ${full.rpcId}`);
    }
    if (!full.result.ok) {
      const err = full.result.error;
      throw new DshRpcError(err.code, err.message, err.details);
    }
    return full.result.value as Value;
  }

  /** Answer an outstanding approval/question `ServerRequest` (echo its rpcId). */
  async respond(rpcId: string, result: { ok: true; value: QuestionResponsePayload | ApprovalResponsePayload }): Promise<void> {
    const message: ClientResponse = { type: "client-response", rpcId, result };
    const response = await this.fetchImpl(new URL("/api/respond", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!response.ok) {
      throw new Error(`dsh transport failure for /api/respond: HTTP ${response.status}`);
    }
  }

  /**
   * Open a WebSocket event stream. Yields every parsed `ServerRequest` frame;
   * the generator terminates when the socket closes. A single corrupt frame is
   * skipped, never fatal. `onOpen` fires once the socket handshake completes,
   * before any frame arrives.
   */
  async *stream<F extends MuxFrame | HostFrame>(
    path: "/api/events.mux" | "/api/events.host",
    signal?: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<ServerRequest<F>> {
    const Ctor = this.WebSocketCtor;
    if (!Ctor) throw new Error("dsh event streams require WebSocket support");
    const url = new URL(path, this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new Ctor(url.toString());
    const inbox: Array<ServerRequest<F>> = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let failed: unknown;
    const enqueue = (frame: ServerRequest<F>): void => {
      inbox.push(frame);
      wake?.();
      wake = undefined;
    };
    const onMessage = (event: unknown): void => {
      const raw = typeof event === "object" && event !== null && "data" in event
        ? (event as { data: unknown }).data
        : event;
      try {
        if (typeof raw !== "string") throw new Error("binary WebSocket frame");
        const full = JSON.parse(raw) as ServerRequest<F>;
        enqueue(full);
      } catch (error) {
        console.error(`[deeplab] dropping malformed WebSocket frame on ${path}:`, error);
      }
    };
    const onClose = (): void => {
      closed = true;
      wake?.();
      wake = undefined;
    };
    const onError = (error: unknown): void => {
      failed = error;
      closed = true;
      wake?.();
      wake = undefined;
    };
    const onOpenEvent = (): void => {
      onOpen?.();
      wake?.();
      wake = undefined;
    };
    socket.addEventListener("open", onOpenEvent);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    if (signal) {
      signal.addEventListener("abort", () => socket.close());
    }
    try {
      while (true) {
        if (inbox.length > 0) {
          const frame = inbox.shift();
          if (frame) yield frame;
          continue;
        }
        if (closed) {
          if (failed) throw failed;
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      socket.removeEventListener("open", onOpenEvent);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
      if (socket.readyState === 0 || socket.readyState === 1) socket.close();
    }
  }
}

/** An error returned inside the dsh ServerResponse `result.error` slot. */
export class DshRpcError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DshRpcError";
    this.code = code;
    this.details = details;
  }
}

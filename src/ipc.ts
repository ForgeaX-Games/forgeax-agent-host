/**
 * IPC(规格 §2.1,T3.2)—— newline-delimited JSON-RPC 2.0 over unix-socket(`node:net`)。
 * 帧 = 一行 JSON + `\n`。支持请求/响应(id 关联)+ 单向通知(如 sidecar→server 的 exit 事件)。
 */
import { connect as netConnect, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

export interface RpcRequest { jsonrpc: '2.0'; id: number; method: string; params?: unknown }
export interface RpcNotify { jsonrpc: '2.0'; method: string; params?: unknown }
export interface RpcResponse { jsonrpc: '2.0'; id: number; result?: unknown; error?: { code: number; message: string } }
type RpcMessage = RpcRequest | RpcNotify | RpcResponse;

export function encodeFrame(msg: RpcMessage): string {
  return JSON.stringify(msg) + '\n';
}

/** 连到 unix-socket,返回一个 RpcConnection;超时/拒连 → reject(供单例探测 + client)。 */
export function connect(sockPath: string, timeoutMs = 2000): Promise<RpcConnection> {
  return new Promise((resolve, reject) => {
    let sock: Socket;
    try {
      sock = netConnect(sockPath);
    } catch (e) {
      reject(e as Error);
      return;
    }
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('connect timeout')); }, timeoutMs);
    // 立刻挂 error 监听(避免 socket 在 connect 前 emit error → unhandled 同步抛)。
    sock.once('error', (e) => { clearTimeout(timer); reject(e); });
    sock.once('connect', () => { clearTimeout(timer); resolve(new RpcConnection(sock)); });
  });
}

/** 半包/粘包安全:喂 chunk,吐完整消息。
 *  ⚠️ 用 StringDecoder(而非 `chunk.toString('utf8')`)解 Buffer:socket 分片可能落在
 *  多字节 UTF-8 序列**中间**,`toString` 会把不完整的尾字节解成 `U+FFFD` 替换符并丢弃,
 *  下一片开头残字节再解成第二个坏字符 —— 大 charter(system prompt)静默损坏中文指令词
 *  (如"不能"→"不��",见验收报告 A.5)。StringDecoder 会把不完整尾字节缓到下一片再解。 */
export function createFrameParser(): (chunk: Buffer | string) => RpcMessage[] {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  return (chunk) => {
    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    const out: RpcMessage[] = [];
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as RpcMessage); } catch { /* drop malformed frame */ }
    }
    return out;
  };
}

export type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
export type NotifyHandler = (method: string, params: unknown) => void;

/**
 * 一条连接上的双向 JSON-RPC 端点。client 用 `request`/`onNotify`;server 端用
 * `setRequestHandler` 处理调用、`notify` 推事件。
 */
export class RpcConnection {
  private readonly parse = createFrameParser();
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private reqHandler: RequestHandler | null = null;
  private notifyHandler: NotifyHandler | null = null;
  /** Set once the socket is gone (peer reset / close()). Guards against a
   *  request issued after close hanging forever (send fails silently → its
   *  pending entry never settles). */
  private closed = false;

  constructor(private readonly sock: Socket) {
    sock.on('data', (chunk) => { for (const msg of this.parse(chunk)) void this.dispatch(msg); });
    // 已建立的连接上 peer reset → 'error';无监听会 unhandled 同步抛。吞掉,靠 'close' 收尾。
    sock.on('error', () => {});
    sock.on('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('connection closed'));
      this.pending.clear();
    });
  }

  setRequestHandler(h: RequestHandler): void { this.reqHandler = h; }
  onNotify(h: NotifyHandler): void { this.notifyHandler = h; }

  /** 连接是否仍打开(peer 未 reset、未被 close())。复用方在复用一条连接前探测存活,
   *  避免向已死连接发请求换来一轮 'connection closed' 才被动自愈。 */
  get isOpen(): boolean { return !this.closed; }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  /** 主动关闭底层连接(让对端 server.close 不被本连接挂住)。幂等。 */
  close(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('connection closed'));
    this.pending.clear();
    try { this.sock.end(); } catch { /* ignore */ }
    try { this.sock.destroy(); } catch { /* ignore */ }
  }

  private send(msg: RpcMessage): void {
    try { this.sock.write(encodeFrame(msg)); } catch { /* socket gone */ }
  }

  private async dispatch(msg: RpcMessage): Promise<void> {
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      // response
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result);
      return;
    }
    if ('id' in msg) {
      // request
      const req = msg as RpcRequest;
      if (!this.reqHandler) {
        this.send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'no handler' } });
        return;
      }
      try {
        const result = await this.reqHandler(req.method, req.params);
        this.send({ jsonrpc: '2.0', id: req.id, result: result ?? null });
      } catch (e) {
        const code = (e as { code?: number }).code ?? -32603;
        this.send({ jsonrpc: '2.0', id: req.id, error: { code, message: (e as Error).message } });
      }
      return;
    }
    // notification
    this.notifyHandler?.((msg as RpcNotify).method, (msg as RpcNotify).params);
  }
}

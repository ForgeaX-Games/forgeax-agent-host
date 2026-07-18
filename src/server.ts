/**
 * agent-host socket server —— listen unix-socket + 每连接一个 RpcConnection,
 * 把 RPC 派发到 Host;并把 Host.onExit 作为 `exit` 通知推给该连接(server 侧)。
 */
import { createServer, type Server, type Socket } from 'node:net';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RpcConnection } from './ipc';
import { Host } from './host';
import { setCredAudit } from './cred-vault';
import { RpcError, type StartSessionReq } from './types';

export interface AgentHostServer {
  host: Host;
  /** 优雅关停:reap 所有 session + 关 socket。 */
  close(): Promise<void>;
}

export function startAgentHostServer(sockPath: string): Promise<AgentHostServer> {
  // 孤儿登记目录与 sock 同址:硬杀残留的进程组记录留在此,供下次 boot sweep(main.ts)。
  const host = new Host({ orphanDir: `${sockPath}.orphans` });
  // 凭据授予审计(S3):issue/budget_exceeded/revoke 各 append 一行 JSONL,永不抛。
  setCredAudit((rec) => {
    try {
      const dir = join(homedir(), '.forgeax');
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'agent-host-cred-audit.jsonl'), JSON.stringify(rec) + '\n');
    } catch { /* 审计不反噬主流程 */ }
  });
  const conns = new Set<Socket>(); // 关停时强制销毁,避免 server.close 被开着的连接挂住
  const server: Server = createServer((sock) => {
    conns.add(sock);
    const conn = new RpcConnection(sock);
    // 本连接名下发起的 session。共享 host 下多 server 各持一条连接:某 server 断线时
    // 只 reap 它自己的 session(I4 隔离),不波及别的 server;host.shutdownAll 仅留给
    // host 进程整体退出。session 自然退出 → onExit 剪枝,避免集合无限增长。
    const owned = new Set<string>();
    const unsubExit = host.onExit((info) => { owned.delete(info.sessionId); conn.notify('exit', info); });
    const unsubData = host.onData((sessionId, stream, chunk) => conn.notify('data', { sessionId, stream, chunk }));
    sock.on('close', () => {
      unsubExit(); unsubData(); conns.delete(sock);
      // 按连接 reap:整组收割本连接名下 session(shutdownSession 对已退出 sid 幂等)。
      for (const sid of owned) void host.shutdownSession(sid).catch(() => {});
      owned.clear();
    });
    sock.on('error', () => { /* client gone */ });
    conn.setRequestHandler(async (method, params) => {
      switch (method) {
        case 'ping': return host.ping();
        case 'startSession': {
          const req = params as StartSessionReq;
          const grant = await host.startSession(req);
          owned.add(req.sessionId); // spawn 成功才登记归属;失败会抛,不进 owned
          return grant;
        }
        case 'cancel': return void (await host.cancel(String((params as { callId: string }).callId)));
        case 'shutdownSession': return void (await host.shutdownSession(String((params as { sessionId: string }).sessionId)));
        case 'getProcess': return host.getProcess(String((params as { sessionId: string }).sessionId));
        case 'listSessions': return host.listSessions();
        case 'shutdown':
          // 单例接管:旧实例被新实例要求退出。
          setTimeout(() => void shutdownAndExit(), 50);
          return { ok: true };
        default:
          throw Object.assign(new Error(`unknown method: ${method}`), { code: RpcError.METHOD_NOT_FOUND });
      }
    });
  });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await host.shutdownAll().catch(() => {});
    for (const s of conns) { try { s.destroy(); } catch { /* ignore */ } }
    conns.clear();
    await new Promise<void>((r) => server.close(() => r()));
  };
  const shutdownAndExit = async (): Promise<void> => { await close(); process.exit(0); };

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(sockPath, () => resolve({ host, close }));
  });
}

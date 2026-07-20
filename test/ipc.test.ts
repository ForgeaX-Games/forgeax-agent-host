/** ipc 单测:JSON-RPC 帧编解码 + 半包/粘包。 */
import { describe, expect, test } from 'bun:test';
import { createFrameParser, encodeFrame } from '../src/ipc';

describe('ipc framing', () => {
  test('encodeFrame 末尾带 \\n', () => {
    expect(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'ping' })).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  });

  test('粘包:一次喂多帧 → 全部解出', () => {
    const parse = createFrameParser();
    const a = encodeFrame({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const b = encodeFrame({ jsonrpc: '2.0', id: 2, method: 'listSessions' });
    const msgs = parse(a + b);
    expect(msgs).toHaveLength(2);
    expect((msgs[0] as { id: number }).id).toBe(1);
    expect((msgs[1] as { method: string }).method).toBe('listSessions');
  });

  test('半包:分片到达 → 跨片拼出完整帧', () => {
    const parse = createFrameParser();
    const full = encodeFrame({ jsonrpc: '2.0', id: 7, method: 'ping', params: { x: 1 } });
    const mid = Math.floor(full.length / 2);
    expect(parse(full.slice(0, mid))).toHaveLength(0); // 不完整 → 暂不吐
    const msgs = parse(full.slice(mid));
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as { id: number }).id).toBe(7);
  });

  test('坏帧被丢弃,不影响后续好帧', () => {
    const parse = createFrameParser();
    const good = encodeFrame({ jsonrpc: '2.0', id: 9, method: 'ping' });
    const msgs = parse('{bad json\n' + good);
    expect(msgs).toHaveLength(1);
    expect((msgs[0] as { id: number }).id).toBe(9);
  });

  // 回归:socket 分片落在多字节 UTF-8 序列中间(大 charter 高发)。旧实现 `chunk.toString('utf8')`
  // 会把不完整尾字节解成 U+FFFD 并丢字节,静默损坏中文指令词(验收报告 A.5)。
  test('字节级半包:多字节 UTF-8 被拆到两片 → 无 U+FFFD、内容无损', () => {
    const parse = createFrameParser();
    const charter = '你不能删除方案'.repeat(2000); // 够大,保证被切在多字节序列中间
    const full = Buffer.from(encodeFrame({ jsonrpc: '2.0', id: 42, method: 'runTurn', params: { charter } }), 'utf8');
    // 从中间某字节切开(极可能落在一个 3 字节汉字内部)。
    const cut = Math.floor(full.length / 2);
    expect(parse(full.subarray(0, cut))).toHaveLength(0); // 不完整帧不吐
    const msgs = parse(full.subarray(cut));
    expect(msgs).toHaveLength(1);
    const got = (msgs[0] as { params: { charter: string } }).params.charter;
    expect(got).toBe(charter);
    expect(got.includes('�')).toBe(false);
  });

  test('逐字节喂多字节字符 → 无损', () => {
    const parse = createFrameParser();
    const line = Buffer.from(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'x', params: { s: '不能方案①🎮' } }), 'utf8');
    const out = [];
    for (const b of line) out.push(...parse(Buffer.from([b])));
    expect(out).toHaveLength(1);
    expect((out[0] as { params: { s: string } }).params.s).toBe('不能方案①🎮');
  });
});

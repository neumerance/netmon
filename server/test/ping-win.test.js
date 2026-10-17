// Windows ping.exe parsing (pure; runs on any OS): `npm --prefix server test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWinPingOutput, parsePingOutput, buildPingArgs, WIN_SUB_MS_RTT } from '../src/net/pinger.js';

const fx = (name) => readFileSync(new URL(`./fixtures/win/${name}`, import.meta.url), 'utf8');
const DEAD = { alive: false, rttMs: null, ttl: null };

// Minimal CP866 encoder for Cyrillic, to reproduce what a Russian console's OEM bytes look like once
// Node decodes them as UTF-8 (the unit 'мс' and every word arrive as U+FFFD garbage).
function cp866Garbled(s) {
  const bytes = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c >= 0x410 && c <= 0x42f) bytes.push(0x80 + (c - 0x410));
    else if (c >= 0x430 && c <= 0x43f) bytes.push(0xa0 + (c - 0x430));
    else if (c >= 0x440 && c <= 0x44f) bytes.push(0xe0 + (c - 0x440));
    else bytes.push(0x3f);
  }
  return Buffer.from(bytes).toString('utf8');
}

test('win ping: English reply time=12ms TTL=64', () => {
  assert.deepEqual(parseWinPingOutput(fx('ping-en-reply.txt'), '192.168.0.1'), { alive: true, rttMs: 12, ttl: 64 });
});

test(`win ping: time<1ms is reported as ${WIN_SUB_MS_RTT} ms`, () => {
  assert.equal(WIN_SUB_MS_RTT, 0.5);
  assert.deepEqual(parseWinPingOutput(fx('ping-en-sub1ms.txt'), '192.168.0.23'), { alive: true, rttMs: 0.5, ttl: 128 });
});

test('win ping: "Destination host unreachable" (exit 0) is NOT a reply', () => {
  assert.deepEqual(parseWinPingOutput(fx('ping-en-unreachable-self.txt'), '192.168.0.77'), DEAD);
  assert.deepEqual(parseWinPingOutput(fx('ping-en-unreachable-gateway.txt'), '10.20.30.40'), DEAD);
  // Even when the unreachable line comes from the very IP we pinged, no TTL= means no echo reply.
  assert.deepEqual(parseWinPingOutput('Reply from 192.168.0.1: Destination host unreachable.\r\n', '192.168.0.1'), DEAD);
  assert.deepEqual(parseWinPingOutput(fx('ping-en-unreachable-gateway.txt')), DEAD);
});

test('win ping: timeout and TTL expired in transit are dead', () => {
  assert.deepEqual(parseWinPingOutput(fx('ping-en-timeout.txt'), '192.168.0.250'), DEAD);
  assert.deepEqual(parseWinPingOutput(fx('ping-en-ttl-expired.txt'), '8.8.8.8'), DEAD);
  assert.deepEqual(parseWinPingOutput('', '192.168.0.1'), DEAD);
  assert.deepEqual(parseWinPingOutput(null), DEAD);
});

test('win ping: German (Zeit<1ms / Zeit=23ms / Zielhost nicht erreichbar / Zeitüberschreitung)', () => {
  assert.deepEqual(parseWinPingOutput(fx('ping-de-reply.txt'), '192.168.0.1'), { alive: true, rttMs: 0.5, ttl: 64 });
  assert.deepEqual(parseWinPingOutput(fx('ping-de-reply-23ms.txt'), '192.168.0.1'), { alive: true, rttMs: 23, ttl: 255 });
  assert.deepEqual(parseWinPingOutput(fx('ping-de-unreachable.txt'), '192.168.0.77'), DEAD);
  assert.deepEqual(parseWinPingOutput(fx('ping-de-timeout.txt'), '192.168.0.250'), DEAD);
});

test('win ping: German output decoded from CP850 bytes as UTF-8 still parses', () => {
  const garbled = Buffer.from(fx('ping-de-reply-23ms.txt'), 'latin1').toString('utf8');
  assert.deepEqual(parseWinPingOutput(garbled, '192.168.0.1'), { alive: true, rttMs: 23, ttl: 255 });
});

test('win ping: French, Japanese (spaces before = and <), Chinese', () => {
  assert.deepEqual(parseWinPingOutput('Réponse de 192.168.0.1 : octets=32 temps<1ms TTL=64\r\n', '192.168.0.1'), { alive: true, rttMs: 0.5, ttl: 64 });
  assert.deepEqual(parseWinPingOutput('Réponse de 192.168.0.1 : octets=32 temps=3 ms TTL=64\r\n', '192.168.0.1'), { alive: true, rttMs: 3, ttl: 64 });
  const ja = '\r\n192.168.0.1 に ping を送信しています 32 バイトのデータ:\r\n192.168.0.1 からの応答: バイト数 =32 時間 =7ms TTL=64\r\n';
  assert.deepEqual(parseWinPingOutput(ja, '192.168.0.1'), { alive: true, rttMs: 7, ttl: 64 });
  assert.deepEqual(parseWinPingOutput('192.168.0.1 からの応答: バイト数 =32 時間 <1ms TTL=64', '192.168.0.1'), { alive: true, rttMs: 0.5, ttl: 64 });
  assert.deepEqual(parseWinPingOutput('来自 192.168.0.1 的回复: 字节=32 时间=2ms TTL=64', '192.168.0.1'), { alive: true, rttMs: 2, ttl: 64 });
  assert.deepEqual(parseWinPingOutput('来自 192.168.0.101 的回复: 无法访问目标主机。', '192.168.0.77'), DEAD);
});

test('win ping: Russian (unit "мс") arriving as CP866 garbage still parses', () => {
  const ru = cp866Garbled('Обмен пакетами с 192.168.0.1 по с 32 байтами данных:\r\nОтвет от 192.168.0.1: число байт=32 время=2мс TTL=128\r\n');
  assert.match(ru, /�/); // really garbled
  assert.deepEqual(parseWinPingOutput(ru, '192.168.0.1'), { alive: true, rttMs: 2, ttl: 128 });
  const ruSub = cp866Garbled('Ответ от 192.168.0.1: число байт=32 время<1мс TTL=128');
  assert.deepEqual(parseWinPingOutput(ruSub, '192.168.0.1'), { alive: true, rttMs: 0.5, ttl: 128 });
  const ruDead = cp866Garbled('Ответ от 192.168.0.101: Заданный узел недоступен.');
  assert.deepEqual(parseWinPingOutput(ruDead, '192.168.0.77'), DEAD);
});

test('win ping: reply from a different host than the target is ignored', () => {
  assert.deepEqual(parseWinPingOutput(fx('ping-en-reply.txt'), '192.168.0.2'), DEAD);
  // '192.168.0.1' must not match inside '192.168.0.10'
  assert.deepEqual(parseWinPingOutput('Reply from 192.168.0.10: bytes=32 time=1ms TTL=64', '192.168.0.1'), DEAD);
  // Without a target, any proper reply counts.
  assert.deepEqual(parseWinPingOutput(fx('ping-en-reply.txt')), { alive: true, rttMs: 12, ttl: 64 });
});

test('win ping: lowercase ttl / missing time still yields alive with ttl', () => {
  assert.deepEqual(parseWinPingOutput('Reply from 192.168.0.1: bytes=32 ttl=64', '192.168.0.1'), { alive: true, rttMs: null, ttl: 64 });
});

test('ping argv: Windows uses -n 1 -w <ms>; macOS/Linux argv unchanged', () => {
  assert.deepEqual(buildPingArgs('192.168.0.1', 700, 'full', 'win32'), ['-n', '1', '-w', '700', '192.168.0.1']);
  assert.deepEqual(buildPingArgs('192.168.0.1', 20, 'full', 'win32'), ['-n', '1', '-w', '100', '192.168.0.1']);
  assert.deepEqual(buildPingArgs('10.0.0.1', 700, 'full', 'darwin'), ['-c', '1', '-n', '-i', '0.1', '-W', '700', '-t', '2', '10.0.0.1']);
  assert.deepEqual(buildPingArgs('10.0.0.1', 700, 'minimal', 'darwin'), ['-c', '1', '-n', '-W', '700', '-t', '2', '10.0.0.1']);
  assert.deepEqual(buildPingArgs('10.0.0.1', 1500, 'full', 'linux'), ['-c', '1', '-n', '-W', '2', '10.0.0.1']);
  assert.deepEqual(buildPingArgs('10.0.0.1', 1500, 'minimal', 'linux'), ['-c', '1', '-W', '2', '10.0.0.1']);
});

test('unix ping parser unchanged (macOS / Linux reply lines)', () => {
  const mac = 'PING 10.0.0.1 (10.0.0.1): 56 data bytes\n64 bytes from 10.0.0.1: icmp_seq=0 ttl=63 time=20.242 ms\n';
  assert.deepEqual(parsePingOutput(mac, '10.0.0.1'), { alive: true, rttMs: 20.24, ttl: 63 });
  assert.deepEqual(parsePingOutput('64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time<1 ms', '1.1.1.1'), { alive: true, rttMs: 1, ttl: 57 });
  assert.deepEqual(parsePingOutput(mac, '10.0.0.2'), DEAD);
});

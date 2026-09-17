import { describe, expect, it } from 'vitest';
import {
  allBytes,
  decodeProtoMessage,
  firstBytes,
  readText,
  safeVarint,
} from '../protobuf.js';

/** (field << 3) | wire 的单字节 tag，仅用于 field <= 15。 */
function tag(field: number, wire: number): number {
  return (field << 3) | wire;
}

function varintBytes(value: number): number[] {
  const bytes: number[] = [];
  let current = value;
  do {
    const byte = current % 128;
    current = Math.floor(current / 128);
    bytes.push(current > 0 ? byte | 0x80 : byte);
  } while (current > 0);
  return bytes;
}

describe('decodeProtoMessage', () => {
  it('decodes varint, length-delimited, fixed32 and fixed64 fields', () => {
    const fixed64 = Buffer.alloc(8, 0x01);
    const fixed32 = Buffer.alloc(4, 0x02);
    const message = decodeProtoMessage(Buffer.from([
      tag(1, 0), ...varintBytes(300),
      tag(2, 2), 3, 0x61, 0x62, 0x63,
      tag(3, 1), ...fixed64,
      tag(4, 5), ...fixed32,
    ]));

    expect(message).not.toBeNull();
    expect(safeVarint(message!, 1)).toBe(300);
    expect(firstBytes(message!, 2)?.toString('utf8')).toBe('abc');
    // fixed32 / fixed64 是未知值：保留 wire type 但不产生 varint / bytes
    expect(safeVarint(message!, 3)).toBeUndefined();
    expect(firstBytes(message!, 3)).toBeUndefined();
    expect(firstBytes(message!, 4)).toBeUndefined();
  });

  it('keeps every occurrence of a repeated field in order', () => {
    const message = decodeProtoMessage(Buffer.from([
      tag(5, 0), 1,
      tag(5, 0), 2,
      tag(6, 2), 1, 0x78,
      tag(6, 2), 1, 0x79,
    ]));

    expect(allBytes(message!, 6).map(b => b.toString('utf8'))).toEqual(['x', 'y']);
    // singular 字段取最后一次出现
    expect(safeVarint(message!, 5)).toBe(2);
  });

  it('returns null for structurally broken input', () => {
    const broken = [
      Buffer.from([tag(1, 0)]),                       // 缺少 varint 负载
      Buffer.from([tag(1, 0), 0x80]),                 // 截断的多字节 varint
      Buffer.from([tag(1, 2), 5, 0x61]),              // length 越界
      Buffer.from([tag(1, 2), 0x80]),                 // 截断的 length
      Buffer.from([tag(1, 1), 0x01]),                 // fixed64 越界
      Buffer.from([tag(1, 5), 0x01]),                 // fixed32 越界
      Buffer.from([tag(1, 3), 0x00]),                 // group 起始，无法安全跳过
      Buffer.from([tag(1, 7), 0x00]),                 // 非法 wire type
      Buffer.from([0x00, 0x01]),                      // field 0
    ];
    for (const input of broken) expect(decodeProtoMessage(input)).toBeNull();
  });

  it('accepts an empty message', () => {
    expect(decodeProtoMessage(Buffer.from([]))).toEqual(new Map());
  });
});

describe('safeVarint', () => {
  it('rejects two\'s complement negatives instead of reporting a huge positive value', () => {
    // -1 的 10 字节编码
    const message = decodeProtoMessage(Buffer.from([
      tag(1, 0), 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01,
    ]));

    expect(safeVarint(message!, 1)).toBeUndefined();
  });

  it('rejects values beyond Number.MAX_SAFE_INTEGER', () => {
    const message = decodeProtoMessage(Buffer.from([
      tag(1, 0), 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
    ]));

    expect(safeVarint(message!, 1)).toBeUndefined();
  });

  it('returns undefined for absent fields', () => {
    const message = decodeProtoMessage(Buffer.from([tag(1, 0), 7]));
    expect(safeVarint(message!, 2)).toBeUndefined();
    expect(firstBytes(message!, 2)).toBeUndefined();
    expect(allBytes(message!, 2)).toEqual([]);
  });
});

describe('readText', () => {
  it('returns printable UTF-8 text', () => {
    const text = Buffer.from('gemini-3.8-flash', 'utf8');
    const message = decodeProtoMessage(Buffer.from([tag(1, 2), text.length, ...text]));
    expect(readText(message!, 1)).toBe('gemini-3.8-flash');
  });

  it('rejects binary payloads, control characters and oversized values', () => {
    const binary = Buffer.from([0xff, 0xfe, 0xfd]);
    const controls = Buffer.from([0x61, 0x00, 0x62]);
    const oversized = Buffer.from('x'.repeat(8), 'utf8');
    const message = decodeProtoMessage(Buffer.from([
      tag(1, 2), binary.length, ...binary,
      tag(2, 2), controls.length, ...controls,
      tag(3, 2), oversized.length, ...oversized,
      tag(4, 2), 0,
    ]));

    expect(readText(message!, 1)).toBeUndefined();
    expect(readText(message!, 2)).toBeUndefined();
    expect(readText(message!, 3, 4)).toBeUndefined();
    expect(readText(message!, 4)).toBeUndefined();
  });
});

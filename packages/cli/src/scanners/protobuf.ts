/**
 * 最小 protobuf wire format 解码器。
 *
 * Antigravity 的本地数据是内部格式，没有随包发布的 .proto，因此这里只实现读取所需
 * 的最小能力：明确字段号 + wire type，未知字段安全跳过，任何结构性异常都返回
 * `null` 而不是抛错或猜值。
 *
 * 不支持的值：group（wire type 3/4，无法安全跳过）与非法 tag。
 */

const MAX_UINT64 = 0xffffffffffffffffn;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_FIELD_NUMBER = 0x1fffffff;

export interface ProtoFieldValue {
  /** 原始 wire type。 */
  wire: number;
  /** wire type 0 的取值。 */
  varint?: bigint;
  /** wire type 2 的负载，是源 buffer 的视图（不复制）。 */
  bytes?: Buffer;
}

/** 字段号 → 该字段出现的所有值（按出现顺序）。 */
export type ProtoMessage = Map<number, ProtoFieldValue[]>;

interface VarintResult {
  value: bigint;
  next: number;
}

/** 解析一个 varint。截断或超过 64 位时返回 `null`。 */
function readVarint(buf: Buffer, start: number): VarintResult | null {
  let value = 0n;
  let shift = 0n;
  let index = start;

  while (index < buf.length) {
    const byte = buf[index++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return value > MAX_UINT64 ? null : { value, next: index };
    }
    shift += 7n;
    if (shift > 63n) return null;
  }

  return null;
}

/**
 * 解码一个 message。返回 `null` 表示这段字节不是合法 message（截断、变长字段越界、
 * group wire type、非法字段号）。未知字段会被跳过并保留，不会导致解码失败。
 */
export function decodeProtoMessage(input: Uint8Array): ProtoMessage | null {
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const fields: ProtoMessage = new Map();
  let offset = 0;

  while (offset < buf.length) {
    const tag = readVarint(buf, offset);
    if (!tag) return null;
    offset = tag.next;

    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 0x7n);
    if (field < 1 || field > MAX_FIELD_NUMBER) return null;

    if (wire === 0) {
      const value = readVarint(buf, offset);
      if (!value) return null;
      offset = value.next;
      push(fields, field, { wire, varint: value.value });
    } else if (wire === 1) {
      if (offset + 8 > buf.length) return null;
      offset += 8;
      push(fields, field, { wire });
    } else if (wire === 2) {
      const length = readVarint(buf, offset);
      if (!length) return null;
      const size = Number(length.value);
      const start = length.next;
      if (!Number.isSafeInteger(size) || size < 0 || start + size > buf.length) return null;
      offset = start + size;
      push(fields, field, { wire, bytes: buf.subarray(start, offset) });
    } else if (wire === 5) {
      if (offset + 4 > buf.length) return null;
      offset += 4;
      push(fields, field, { wire });
    } else {
      // group 起始/结束标签无法安全跳过；也没有已知字段使用它们。
      return null;
    }
  }

  return fields;
}

/** 字段第一次出现的 length-delimited 值。 */
export function firstBytes(message: ProtoMessage, field: number): Buffer | undefined {
  for (const value of message.get(field) ?? []) {
    if (value.bytes) return value.bytes;
  }
  return undefined;
}

/** 字段所有 length-delimited 值，用于 repeated 字段（如 map entry）。 */
export function allBytes(message: ProtoMessage, field: number): Buffer[] {
  const result: Buffer[] = [];
  for (const value of message.get(field) ?? []) {
    if (value.bytes) result.push(value.bytes);
  }
  return result;
}

/**
 * 字段最后一次出现的 varint，且必须落在 `[0, Number.MAX_SAFE_INTEGER]`。
 * 负数（two's complement 的 10 字节编码）与超范围值返回 `undefined`，避免把
 * 哨兵值当成 token 计数。
 */
export function safeVarint(message: ProtoMessage, field: number): number | undefined {
  let result: number | undefined;
  for (const value of message.get(field) ?? []) {
    if (value.varint === undefined) continue;
    result = value.varint >= 0n && value.varint <= MAX_SAFE_INTEGER
      ? Number(value.varint)
      : undefined;
  }
  return result;
}

/**
 * 字段第一次出现的可打印 UTF-8 文本。
 * 要求能完整往返编码，因此二进制负载不会被误当成字符串。
 */
export function readText(
  message: ProtoMessage,
  field: number,
  maxLength = 512,
): string | undefined {
  const bytes = firstBytes(message, field);
  if (!bytes || bytes.length === 0 || bytes.length > maxLength) return undefined;

  const text = bytes.toString('utf8');
  if (text.length === 0) return undefined;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  // 拒绝替换字符与非法序列：必须能无损往返。
  if (!Buffer.from(text, 'utf8').equals(bytes)) return undefined;
  return text.trim() || undefined;
}

function push(message: ProtoMessage, field: number, value: ProtoFieldValue): void {
  const existing = message.get(field);
  if (existing) existing.push(value);
  else message.set(field, [value]);
}

// pkt-line framing for the git smart-HTTP protocol (gitprotocol-pack / gitprotocol-v2).
// A pkt-line is 4 lowercase hex digits of the total length (header included) followed by the
// payload. 0000 is a flush, 0001 a delimiter, 0002 a response end. The largest packet is
// 65520 bytes including its header, so a sideband payload is at most 65516 bytes.

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  /** The payload of a data packet; empty for control packets. */
  payload: Buffer;
}

export const PKT_MAX = 65520;
/** The largest sideband payload: the pkt-line max less the header and the band byte. */
export const SIDEBAND_MAX = PKT_MAX - 4 - 1;

/** Encode one data packet: a 4-hex length header plus the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > PKT_MAX) throw new Error(`pkt-line of ${length} bytes exceeds the 65520 maximum`);
  const header = Buffer.alloc(4);
  header.write(length.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, body]);
}

/** The flush packet (0000). */
export const FLUSH: Buffer = Buffer.from('0000', 'ascii');
/** The delimiter packet (0001). */
export const DELIM: Buffer = Buffer.from('0001', 'ascii');
/** The response-end packet (0002). */
export const RESPONSE_END: Buffer = Buffer.from('0002', 'ascii');

/** Encode a list of lines (strings), 'flush' and 'delim' markers into one buffer. */
export function encodePktLines(lines: ReadonlyArray<string | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(FLUSH);
    else if (line === 'delim') parts.push(DELIM);
    else if (line === 'response-end') parts.push(RESPONSE_END);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/**
 * Decode a whole buffer of pkt-lines. A malformed length (not hex, or past the buffer) stops the
 * scan and the rest is returned as trailing bytes, so a garbage body never crashes the caller.
 */
export function decodePktLines(buffer: Buffer): { packets: Pkt[]; trailing: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, trailing: buffer.subarray(offset) };
}

/** Split a buffer of sideband packets into band-1 data, band-2 progress and a band-3 error. */
export function demuxSideband(packets: readonly Pkt[]): { data: Buffer[]; progress: string; error: string | null } {
  const data: Buffer[] = [];
  let progress = '';
  let error: string | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload.length < 1) continue;
    const band = packet.payload[0];
    const rest = packet.payload.subarray(1);
    if (band === 1) data.push(rest);
    else if (band === 2) progress += rest.toString('utf8');
    else if (band === 3) error = rest.toString('utf8');
  }
  return { data, progress, error };
}

/** Wrap buffers as sideband band-1 packets, chunked to the pkt-line maximum. */
export function sidebandData(chunks: readonly Buffer[]): Buffer {
  const parts: Buffer[] = [];
  for (const chunk of chunks) {
    let offset = 0;
    while (offset < chunk.length) {
      const slice = chunk.subarray(offset, offset + SIDEBAND_MAX);
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
      offset += slice.length;
    }
  }
  return Buffer.concat(parts);
}

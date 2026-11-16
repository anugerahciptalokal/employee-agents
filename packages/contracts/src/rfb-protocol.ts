/**
 * Pure TypeScript RFB (Remote Framebuffer) Protocol Encoders & Utilities
 * Compatible with both Node.js server and Browser environments.
 */

export function parseResolutionString(res: string): { width: number; height: number } {
  const match = res.match(/^(\d+)x(\d+)$/);
  if (match) {
    const width = parseInt(match[1], 10);
    const height = parseInt(match[2], 10);
    if (!isNaN(width) && !isNaN(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }
  return { width: 1440, height: 900 };
}

/**
 * Encodes an RFB (Remote Framebuffer) PointerEvent packet (Message Type 5).
 * Format:
 * - [0]: u8 message-type (5)
 * - [1]: u8 button-mask (bit 0: left, bit 1: middle, bit 2: right)
 * - [2..3]: u16 x-position (big-endian)
 * - [4..5]: u16 y-position (big-endian)
 */
export function encodeRfbPointerEvent(buttonMask: number, x: number, y: number): Uint8Array {
  const buf = new Uint8Array(6);
  const view = new DataView(buf.buffer);
  buf[0] = 5; // PointerEvent
  buf[1] = buttonMask & 0xff;
  view.setUint16(2, Math.max(0, Math.floor(x)), false); // big-endian
  view.setUint16(4, Math.max(0, Math.floor(y)), false); // big-endian
  return buf;
}

/**
 * Encodes an RFB (Remote Framebuffer) KeyEvent packet (Message Type 4).
 * Format:
 * - [0]: u8 message-type (4)
 * - [1]: u8 down-flag (1 = pressed, 0 = released)
 * - [2..3]: u16 padding (0)
 * - [4..7]: u32 keysym (big-endian)
 */
export function encodeRfbKeyEvent(isDown: boolean, keysym: number): Uint8Array {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  buf[0] = 4; // KeyEvent
  buf[1] = isDown ? 1 : 0;
  buf[2] = 0;
  buf[3] = 0;
  view.setUint32(4, keysym >>> 0, false); // big-endian
  return buf;
}


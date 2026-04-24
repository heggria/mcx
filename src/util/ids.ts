import { customAlphabet } from 'nanoid';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
const nano = customAlphabet(alphabet, 16);

export function callId(): string {
  return nano();
}

export function correlationId(): string | undefined {
  return process.env.MCX_CORRELATION_ID || undefined;
}

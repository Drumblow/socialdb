import { fromString as uint8ArrayFromStringInternal, toString as uint8ArrayToStringInternal } from 'uint8arrays';

export function uint8ArrayToString(array) {
  return uint8ArrayToStringInternal(array);
}

export function stringToUint8Array(str) {
  return uint8ArrayFromStringInternal(str);
} 
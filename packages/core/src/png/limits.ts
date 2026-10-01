// 02 §5 hard limits for images. Raising one needs a measured memory bound, never a disabled check.
export const MAX_PNG_BYTES = 32 * 1024 * 1024;
export const MAX_DIMENSION = 16383;
export const MAX_PIXELS = 16_000_000;
/** Error text is bounded like every other ingress diagnostic (02 §5). */
export const MAX_ERROR_BYTES = 2048;

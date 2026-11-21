/** Direction-labelled proofs prevent a handshake message being replayed the other way. */
export const CLIENT_AUTH_LABEL = "zen-control-client-auth-v1:";
export const SERVER_AUTH_LABEL = "zen-control-server-auth-v1:";
export const AUTH_NONCE_BYTES = 32;
export const AUTH_TIMEOUT_MS = 10_000;
export const AUTH_FAILED_CLOSE = 4003;
export const AUTH_TIMEOUT_CLOSE = 4008;
export const AUTH_REQUIRED_CLOSE = 4009;

export const clientAuthMessage = (nonce: string): string => CLIENT_AUTH_LABEL + nonce;
export const serverAuthMessage = (nonce: string): string => SERVER_AUTH_LABEL + nonce;

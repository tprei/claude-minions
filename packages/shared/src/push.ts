export interface PushSubscriptionInfo {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

export interface VapidPublicKeyResponse {
  publicKey: string;
}

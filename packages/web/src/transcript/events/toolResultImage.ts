const DATA_IMAGE_RE =
  /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

export function safeToolResultImageSrc(src: string): string | null {
  const value = src.trim();
  if (DATA_IMAGE_RE.test(value)) return value;
  try {
    const base =
      typeof window === "undefined" ? "https://minions.local/" : window.location.href;
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (typeof window !== "undefined" && url.origin !== window.location.origin) return null;
    return url.href;
  } catch {
    return null;
  }
}

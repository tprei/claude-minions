import { useOnline } from "./offline.js";

export function OfflineBanner() {
  const online = useOnline();

  if (online) return null;

  return (
    <div
      role="alert"
      className="fixed bottom-0 inset-x-0 z-50 flex items-center justify-center gap-2 py-2 px-4 bg-tone-warn-bg text-tone-warn-fg text-sm backdrop-blur border-t border-tone-warn-border"
    >
      <span>●</span>
      <span>You're offline — changes will not sync until reconnected</span>
    </div>
  );
}

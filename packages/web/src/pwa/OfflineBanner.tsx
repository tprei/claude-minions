import { useOnline } from "./offline.js";

export function OfflineBanner() {
  const online = useOnline();

  if (online) return null;

  return (
    <div
      role="alert"
      className="fixed bottom-0 inset-x-0 z-50 flex items-center justify-center gap-2 py-2 px-4 bg-amber-900/90 text-amber-200 text-sm backdrop-blur border-t border-amber-700"
    >
      <span>●</span>
      <span>You're offline — changes will not sync until reconnected</span>
    </div>
  );
}

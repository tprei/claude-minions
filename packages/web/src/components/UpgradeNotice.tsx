import type { ReactElement } from "react";
import type { FeatureFlag } from "../types.js";

interface UpgradeNoticeProps {
  feature: FeatureFlag;
}

export function UpgradeNotice({ feature }: UpgradeNoticeProps): ReactElement {
  return (
    <div className="card p-4 flex items-start gap-3">
      <span className="text-warn text-lg leading-none mt-0.5">⚠</span>
      <div>
        <p className="text-sm font-medium text-zinc-200">Feature unavailable</p>
        <p className="text-xs text-zinc-500 mt-0.5">
          The <code className="font-mono text-zinc-400">{feature}</code> feature is not enabled on the connected engine.
          Upgrade your engine to unlock this capability.
        </p>
      </div>
    </div>
  );
}

import { useInstallPrompt } from "./install.js";

export function InstallButton() {
  const { hasPrompt, promptInstall } = useInstallPrompt();

  if (!hasPrompt) return null;

  return (
    <button
      className="btn-primary text-xs"
      onClick={() => void promptInstall()}
    >
      Install app
    </button>
  );
}

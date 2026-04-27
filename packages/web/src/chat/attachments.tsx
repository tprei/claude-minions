import { useState, useCallback } from "react";

export interface Attachment {
  name: string;
  mimeType: string;
  dataBase64: string;
  previewUrl: string;
}

function fileToAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] ?? "";
      resolve({
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        dataBase64: base64,
        previewUrl: result,
      });
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

interface Props {
  attachments: Attachment[];
  onChange: (attachments: Attachment[]) => void;
}

export function AttachmentBar({ attachments, onChange }: Props) {
  const remove = (i: number) => {
    onChange(attachments.filter((_, idx) => idx !== i));
  };

  if (attachments.length === 0) return null;

  return (
    <div className="flex gap-2 px-3 pt-2 overflow-x-auto">
      {attachments.map((a, i) => (
        <div
          key={i}
          className="flex items-center gap-2 shrink-0 rounded-lg border border-border bg-bg-elev pl-1 pr-1 py-1"
        >
          <img
            src={a.previewUrl}
            alt={a.name}
            className="w-8 h-8 rounded object-cover shrink-0"
          />
          <span className="text-xs text-fg-muted max-w-[140px] truncate">
            {a.name}
          </span>
          <button
            type="button"
            onClick={() => remove(i)}
            aria-label={`Remove ${a.name}`}
            className="w-5 h-5 flex items-center justify-center rounded text-fg-subtle hover:text-fg hover:bg-bg-soft text-sm leading-none"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function useAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const onPaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const images = Array.from(e.clipboardData.files).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (images.length === 0) return;
      e.preventDefault();
      const converted = await Promise.all(images.map(fileToAttachment));
      setAttachments((prev) => [...prev, ...converted]);
    },
    [],
  );

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      const images = Array.from(e.dataTransfer.files).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (images.length === 0) return;
      e.preventDefault();
      const converted = await Promise.all(images.map(fileToAttachment));
      setAttachments((prev) => [...prev, ...converted]);
    },
    [],
  );

  const clear = useCallback(() => setAttachments([]), []);

  return { attachments, setAttachments, onPaste, onDrop, clear };
}


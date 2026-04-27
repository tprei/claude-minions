import { useState, useCallback, useRef } from "react";

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface Attachment {
  name: string;
  mimeType: string;
  dataBase64: string;
  previewUrl: string;
  file: File;
  url?: string;
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
        file,
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
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArr = Array.from(files).filter((f) => ALLOWED_MIME.has(f.type));
      const converted = await Promise.all(fileArr.map(fileToAttachment));
      onChange([...attachments, ...converted]);
    },
    [attachments, onChange],
  );

  const remove = (i: number) => {
    onChange(attachments.filter((_, idx) => idx !== i));
  };

  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2">
      {attachments.map((a, i) => (
        <div
          key={i}
          className="relative group w-14 h-14 rounded-lg overflow-hidden border border-border"
        >
          <img src={a.previewUrl} alt={a.name} className="w-full h-full object-cover" />
          <button
            type="button"
            onClick={() => remove(i)}
            className="absolute top-0 right-0 w-5 h-5 bg-black/70 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity rounded-bl"
          >
            ×
          </button>
        </div>
      ))}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && addFiles(e.target.files)}
      />
    </div>
  );
}

export function useAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const onPaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const images = Array.from(e.clipboardData.files).filter((f) =>
        ALLOWED_MIME.has(f.type),
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
        ALLOWED_MIME.has(f.type),
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

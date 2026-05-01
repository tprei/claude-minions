import { useState, useRef, useCallback, useEffect } from "react";
import { slashCommands } from "./slashCommands.js";
import { AutocompletePopover } from "./autocomplete.js";
import { FileMentionPopover } from "./FileMentionPopover.js";
import { currentMentionToken, replaceMentionToken, type MentionToken } from "./mentions.js";
import { AttachmentBar, useAttachments, type Attachment } from "./attachments.js";
import { startListening, stopListening, isVoiceSupported, type VoiceSession } from "./voice.js";
import { useFeature } from "../hooks/useFeature.js";
import { cx } from "../util/classnames.js";
import { useRootStore } from "../store/root.js";
import { listRepoFiles, uploadAttachment } from "../transport/rest.js";
import type { SlashCommand } from "./slashCommands.js";

interface Props {
  onSubmit: (text: string, attachments: Attachment[]) => void;
  onSlashCommand: (cmd: SlashCommand, args: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  hint?: string;
  running?: boolean;
  onStop?: () => void | Promise<void>;
  repoId?: string;
}

interface MentionState {
  token: MentionToken;
  results: string[];
}

function matchSlash(value: string) {
  if (!value.startsWith("/")) return null;
  const parts = value.slice(1).split(" ");
  const prefix = parts[0] ?? "";
  const isPartial = parts.length === 1;
  if (isPartial) {
    return slashCommands.filter((c) =>
      c.name.startsWith(prefix.toLowerCase()),
    );
  }
  return null;
}

function parseSlashCommand(value: string): { cmd: SlashCommand; args: string[] } | null {
  if (!value.startsWith("/")) return null;
  const parts = value.slice(1).split(" ");
  const name = parts[0]?.toLowerCase() ?? "";
  const cmd = slashCommands.find((c) => c.name === name);
  if (!cmd) return null;
  return { cmd, args: parts.slice(1) };
}

export function ChatInput({ onSubmit, onSlashCommand, disabled, placeholder, hint, running, onStop, repoId }: Props) {
  const [value, setValue] = useState("");
  const [caret, setCaret] = useState(0);
  const [autocompleteIdx, setAutocompleteIdx] = useState(0);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceRef = useRef<VoiceSession | null>(null);
  const [listening, setListening] = useState(false);
  const voiceEnabled = useFeature("voice-input");
  const { attachments, setAttachments, onPaste, onDrop, clear: clearAttachments } = useAttachments();
  const conn = useRootStore((s) => s.getActiveConnection());

  const matches = matchSlash(value) ?? [];
  const showAutocomplete = matches.length > 0;
  const showMention = !showAutocomplete && mention !== null && mention.results.length > 0;

  useEffect(() => {
    setAutocompleteIdx(0);
  }, [value]);

  useEffect(() => {
    if (!conn || !repoId) {
      setMention(null);
      return;
    }
    const token = currentMentionToken(value, caret);
    if (!token) {
      setMention(null);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      listRepoFiles(conn, repoId, { q: token.query, limit: 50 })
        .then((res) => {
          if (cancelled) return;
          setMention({ token, results: res.items });
          setMentionIdx(0);
        })
        .catch(() => {
          if (cancelled) return;
          setMention(null);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [value, caret, conn, repoId]);

  const applyMention = useCallback(
    (path: string) => {
      if (!mention) return;
      const next = replaceMentionToken(value, mention.token, "@" + path);
      setValue(next.value);
      setCaret(next.caret);
      setMention(null);
      const ta = textareaRef.current;
      if (ta) {
        queueMicrotask(() => {
          ta.focus();
          ta.setSelectionRange(next.caret, next.caret);
        });
      }
    },
    [mention, value],
  );

  const submit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed && attachments.length === 0) return;
    const parsed = parseSlashCommand(trimmed);
    if (parsed) {
      onSlashCommand(parsed.cmd, parsed.args);
      setValue("");
      clearAttachments();
      return;
    }
    let uploaded: Attachment[] = attachments;
    if (attachments.some((a) => !a.url)) {
      if (!conn) {
        setUploadError("No active connection for upload");
        return;
      }
      setUploading(true);
      setUploadError(null);
      try {
        uploaded = await Promise.all(
          attachments.map(async (a) => {
            if (a.url) return a;
            const res = await uploadAttachment(conn, a.file);
            return { ...a, url: res.url };
          }),
        );
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Upload failed");
        setUploading(false);
        return;
      }
      setUploading(false);
    }
    onSubmit(trimmed, uploaded);
    setValue("");
    clearAttachments();
  }, [value, attachments, conn, onSubmit, onSlashCommand, clearAttachments]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMention && mention) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIdx((i) => Math.min(i + 1, mention.results.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const picked = mention.results[mentionIdx];
        if (picked) applyMention(picked);
        return;
      }
    }
    if (showAutocomplete) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAutocompleteIdx((i) => Math.min(i + 1, matches.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAutocompleteIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        const selected = matches[autocompleteIdx];
        if (selected) {
          setValue(`/${selected.name} `);
        }
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const selectAutocomplete = (cmd: SlashCommand) => {
    setValue(`/${cmd.name} `);
    textareaRef.current?.focus();
  };

  const toggleVoice = () => {
    if (listening) {
      if (voiceRef.current) stopListening(voiceRef.current);
      voiceRef.current = null;
      setListening(false);
    } else {
      voiceRef.current = startListening(
        (text, final) => {
          if (final) {
            setValue((v) => v + text + " ");
          }
        },
        (err) => {
          console.error(err);
          setListening(false);
        },
      );
      setListening(true);
    }
  };

  return (
    <div
      className="relative border-t border-border bg-bg-soft"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      onDrop={(e) => { e.preventDefault(); onDrop(e); }}
      onDragOver={(e) => e.preventDefault()}
    >
      <AttachmentBar attachments={attachments} onChange={setAttachments} />
      {uploadError && (
        <div className="px-3 pt-1 text-xs text-red-700 dark:text-red-400">Upload failed: {uploadError}</div>
      )}
      {showAutocomplete && (
        <div className="absolute bottom-full left-0 right-0 px-3 pb-1 z-50">
          <AutocompletePopover
            commands={matches}
            activeIndex={autocompleteIdx}
            onSelect={selectAutocomplete}
            onClose={() => setValue(value.replace(/^\/\S*/, ""))}
          />
        </div>
      )}
      {showMention && mention && (
        <div className="absolute bottom-full left-0 right-0 px-3 pb-1 z-50">
          <FileMentionPopover
            paths={mention.results}
            activeIndex={mentionIdx}
            onSelect={applyMention}
            onClose={() => setMention(null)}
          />
        </div>
      )}
      <div className="flex items-end gap-2 px-3 py-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onPaste={onPaste}
          placeholder={placeholder ?? "Message… (/ for commands, Shift+Enter for newline)"}
          disabled={disabled}
          rows={1}
          className={cx(
            "flex-1 resize-none bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none min-h-[2rem] max-h-40 leading-6",
            disabled && "opacity-50 cursor-not-allowed",
          )}
          style={{ height: "auto", overflowY: value.includes("\n") ? "auto" : "hidden" }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${el.scrollHeight}px`;
          }}
        />
        {voiceEnabled && isVoiceSupported() && (
          <button
            type="button"
            onClick={toggleVoice}
            className={cx(
              "p-1.5 rounded-lg transition-colors",
              listening
                ? "text-red-400 bg-red-900/30 hover:bg-red-900/50"
                : "text-fg-subtle hover:text-fg-muted hover:bg-bg-elev",
            )}
            title={listening ? "Stop recording" : "Start voice input"}
          >
            🎤
          </button>
        )}
        {running && onStop && (
          <button
            type="button"
            onClick={() => void onStop()}
            className="shrink-0 text-xs px-2 py-1 rounded-lg bg-red-100 text-red-800 border border-red-300 hover:bg-red-900/60 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700/40"
            title="Stop the agent (sends stop command)"
          >
            ■ Stop
          </button>
        )}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={disabled || uploading || (!value.trim() && attachments.length === 0)}
          className={cx(
            "btn-primary shrink-0 text-xs",
            (disabled || uploading || (!value.trim() && attachments.length === 0)) && "opacity-50 cursor-not-allowed",
          )}
        >
          {uploading ? "Uploading…" : running ? "Queue" : "Send"}
        </button>
      </div>
      {hint && (
        <div className="px-3 pb-1 text-[10px] text-fg-subtle">{hint}</div>
      )}
    </div>
  );
}

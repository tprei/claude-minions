import { useState, useRef, useCallback, useEffect } from "react";
import { slashCommands } from "./slashCommands.js";
import { AutocompletePopover } from "./autocomplete.js";
import { AttachmentBar, useAttachments, type Attachment } from "./attachments.js";
import { startListening, stopListening, isVoiceSupported, type VoiceSession } from "./voice.js";
import { useFeature } from "../hooks/useFeature.js";
import { cx } from "../util/classnames.js";
import type { SlashCommand } from "./slashCommands.js";

interface Props {
  onSubmit: (text: string, attachments: Attachment[]) => void;
  onSlashCommand: (cmd: SlashCommand, args: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
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

export function ChatInput({ onSubmit, onSlashCommand, disabled, placeholder }: Props) {
  const [value, setValue] = useState("");
  const [autocompleteIdx, setAutocompleteIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const voiceRef = useRef<VoiceSession | null>(null);
  const [listening, setListening] = useState(false);
  const voiceEnabled = useFeature("voice-input");
  const { attachments, setAttachments, onPaste, onDrop, clear: clearAttachments } = useAttachments();

  const matches = matchSlash(value) ?? [];
  const showAutocomplete = matches.length > 0;

  useEffect(() => {
    setAutocompleteIdx(0);
  }, [value]);

  const submit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && attachments.length === 0) return;
    const parsed = parseSlashCommand(trimmed);
    if (parsed) {
      onSlashCommand(parsed.cmd, parsed.args);
      setValue("");
      clearAttachments();
      return;
    }
    onSubmit(trimmed, attachments);
    setValue("");
    clearAttachments();
  }, [value, attachments, onSubmit, onSlashCommand, clearAttachments]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      submit();
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
      onDrop={(e) => { e.preventDefault(); onDrop(e); }}
      onDragOver={(e) => e.preventDefault()}
    >
      <AttachmentBar attachments={attachments} onChange={setAttachments} />
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
      <div className="flex items-end gap-2 px-3 py-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={onPaste}
          placeholder={placeholder ?? "Message… (/ for commands, Shift+Enter for newline)"}
          disabled={disabled}
          rows={1}
          className={cx(
            "flex-1 resize-none bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none min-h-[2rem] max-h-40 leading-6",
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
                : "text-zinc-500 hover:text-zinc-300 hover:bg-bg-elev",
            )}
            title={listening ? "Stop recording" : "Start voice input"}
          >
            🎤
          </button>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={disabled || (!value.trim() && attachments.length === 0)}
          className={cx(
            "btn-primary shrink-0 text-xs",
            (disabled || (!value.trim() && attachments.length === 0)) && "opacity-50 cursor-not-allowed",
          )}
        >
          Send
        </button>
      </div>
    </div>
  );
}

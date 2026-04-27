type OnTranscript = (text: string, final: boolean) => void;
type OnError = (err: string) => void;

export interface VoiceSession {
  stop: () => void;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  start: () => void;
  stop: () => void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (w["SpeechRecognition"] ?? w["webkitSpeechRecognition"] ?? null) as SpeechRecognitionConstructor | null;
}

export function isVoiceSupported(): boolean {
  return getSpeechRecognition() !== null;
}

export function startListening(onTranscript: OnTranscript, onError: OnError): VoiceSession {
  const SR = getSpeechRecognition();
  if (!SR) {
    onError("Speech recognition is not supported in this browser.");
    return { stop: () => undefined };
  }

  const recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language ?? "en-US";

  recognition.onresult = (rawEvent: Event) => {
    const event = rawEvent as Event & {
      resultIndex: number;
      results: { length: number; isFinal: boolean; [index: number]: { transcript: string }[] };
    };
    let interim = "";
    let finalText = "";
    for (let i = event.resultIndex; i < (event.results as unknown as { length: number }).length; i++) {
      const results = event.results as unknown as Array<{ isFinal: boolean; 0: { transcript: string } }>;
      const result = results[i];
      if (result && result[0]) {
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }
    }
    if (finalText) onTranscript(finalText, true);
    else if (interim) onTranscript(interim, false);
  };

  recognition.onerror = (rawEvent: Event) => {
    const event = rawEvent as Event & { error: string };
    onError(`Speech recognition error: ${event.error}`);
  };

  recognition.start();

  return {
    stop: () => {
      try {
        recognition.stop();
      } catch {
        // Already stopped.
      }
    },
  };
}

export function stopListening(session: VoiceSession): void {
  session.stop();
}

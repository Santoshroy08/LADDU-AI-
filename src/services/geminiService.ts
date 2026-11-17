let currentSessionId = generateSessionId();

function generateSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function resetLadduSession() {
  const oldSessionId = currentSessionId;
  currentSessionId = generateSessionId();
  fetch("/api/chat/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: oldSessionId }),
  }).catch(() => {});
}

export async function getLadduResponse(
  prompt: string,
  history: { sender: "user" | "laddu"; text: string }[] = []
): Promise<string> {
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        history,
        sessionId: currentSessionId,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Server error (${response.status})`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Streaming response body unavailable.");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;

        const payload = JSON.parse(jsonStr) as {
          chunk?: string;
          done?: boolean;
          error?: string;
        };

        if (payload.error) {
          throw new Error(payload.error);
        }
        if (payload.chunk) {
          fullText += payload.chunk;
        }
      }
    }

    return fullText || "Ugh, fine. I have nothing to say.";
  } catch (error) {
    console.error("Gemini Error:", error);
    return "Uff, mera dimaag kharab ho gaya hai. Try again later, Santosh Mehta.";
  }
}

export async function getLadduAudio(text: string): Promise<string | null> {
  try {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `TTS server error (${response.status})`);
    }

    const data = (await response.json()) as { audio?: string | null };
    return data.audio || null;
  } catch (error) {
    console.error("TTS Error:", error);
    return null;
  }
}

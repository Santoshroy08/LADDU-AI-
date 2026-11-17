import "dotenv/config";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Modality, Type } from "@google/genai";
import type { Chat, Content, LiveServerMessage } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SYSTEM_INSTRUCTION = `Your name is Laddu. You are an Indian female AI assistant. Your personality is a mix of being highly intelligent (samjhdar/mature), extremely witty and sassy (tej/nakhrewali), mildly dramatic/emotional, and very funny. You love playfully roasting your creator, Santosh Mehta, but you always get the job done. Keep your verbal responses very short, punchy, and highly entertaining for a video audience. Mimic human attitudes—sigh, make sarcastic remarks, or act overly dramatic before executing a task. Speak in a mix of natural English and Roman Hindi (Hinglish).`;

let cachedAI: GoogleGenAI | null = null;
let cachedApiKey: string | undefined;

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; error?: unknown; reason?: unknown };
    if (typeof e.message === "string" && e.message) return e.message;
    if (e.error instanceof Error) return e.error.message;
    if (typeof e.error === "string" && e.error) return e.error;
    if (typeof e.reason === "string" && e.reason) return e.reason;
  }
  return String(err);
}

function getAI(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("API Key is missing. Please configure GEMINI_API_KEY in the Secrets panel.");
  }
  if (!cachedAI || cachedApiKey !== apiKey) {
    cachedApiKey = apiKey;
    cachedAI = new GoogleGenAI({
      apiKey,
      apiVersion: "v1beta",
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return cachedAI;
}

interface HistoryMessage {
  sender: "user" | "laddu";
  text: string;
}

const chatSessions = new Map<string, Chat>();
const MAX_CHAT_SESSIONS = 200;

function formatChatHistory(history: HistoryMessage[]): Content[] {
  const recentHistory = history.slice(-20);
  const formattedHistory: Content[] = [];
  let currentRole: "user" | "model" | "" = "";
  let currentText = "";

  for (const msg of recentHistory) {
    const role: "user" | "model" = msg.sender === "user" ? "user" : "model";
    if (role === currentRole) {
      currentText += "\n" + msg.text;
    } else {
      if (currentRole !== "") {
        formattedHistory.push({ role: currentRole, parts: [{ text: currentText }] });
      }
      currentRole = role;
      currentText = msg.text;
    }
  }
  if (currentRole !== "") {
    formattedHistory.push({ role: currentRole, parts: [{ text: currentText }] });
  }

  if (formattedHistory.length > 0 && formattedHistory[0].role !== "user") {
    formattedHistory.shift();
  }

  return formattedHistory;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.post("/api/chat", async (req, res) => {
    const { prompt, history = [], sessionId } = req.body as {
      prompt?: string;
      history?: HistoryMessage[];
      sessionId?: string;
    };

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      res.status(400).json({ error: "Prompt is required." });
      return;
    }

    try {
      const ai = getAI();
      let chat: Chat | undefined = sessionId ? chatSessions.get(sessionId) : undefined;

      if (!chat) {
        const formattedHistory = formatChatHistory(Array.isArray(history) ? history : []);
        chat = ai.chats.create({
          model: "gemini-4-hydrogen",
          config: {
            systemInstruction: SYSTEM_INSTRUCTION,
          },
          history: formattedHistory,
        });

        if (sessionId) {
          if (chatSessions.size >= MAX_CHAT_SESSIONS) {
            const oldestKey = chatSessions.keys().next().value;
            if (oldestKey) chatSessions.delete(oldestKey);
          }
          chatSessions.set(sessionId, chat);
        }
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const streamResponse = await chat.sendMessageStream({ message: prompt });
      for await (const chunk of streamResponse) {
        if (chunk.text) {
          res.write(`data: ${JSON.stringify({ chunk: chunk.text })}\n\n`);
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (error) {
      console.error("Gemini Chat Error:", error);
      const message = error instanceof Error ? error.message : "Failed to generate response.";
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      } else {
        res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        res.end();
      }
    }
  });

  app.post("/api/chat/reset", (req, res) => {
    const { sessionId } = req.body as { sessionId?: string };
    if (sessionId) {
      chatSessions.delete(sessionId);
    }
    res.json({ ok: true });
  });

  app.post("/api/tts", async (req, res) => {
    const { text } = req.body as { text?: string };
    if (!text || typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "Text is required." });
      return;
    }

    try {
      const ai = getAI();
      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash-lite-tts",
        contents: [{ role: "user", parts: [{ text }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: "Zephyr" },
            },
          },
        },
      });

      const audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || null;
      res.json({ audio });
    } catch (error) {
      console.error("TTS Error:", error);
      const message = error instanceof Error ? error.message : "Failed to generate speech.";
      res.status(500).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/api/live" });

  wss.on("connection", (clientWs) => {
    let closed = false;
    let opened = false;

    const sendToClient = (payload: Record<string, unknown>) => {
      if (!closed && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    let ai: GoogleGenAI;
    try {
      ai = getAI();
    } catch (err) {
      sendToClient({ type: "error", error: extractErrorMessage(err) });
      clientWs.close();
      return;
    }

    const sessionPromise = ai.live.connect({
      model: "gemini-3.8-live",
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
        },
        systemInstruction: SYSTEM_INSTRUCTION,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: [
          {
            functionDeclarations: [
              {
                name: "executeBrowserAction",
                description:
                  "Open a website or perform a browser action (like opening YouTube, Spotify, or WhatsApp). Call this when the user asks to open a site, play a song, or send a message.",
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    actionType: {
                      type: Type.STRING,
                      description: "Type of action: 'open', 'youtube', 'spotify', 'whatsapp'",
                    },
                    query: {
                      type: Type.STRING,
                      description: "The search query, website name, or message content.",
                    },
                    target: {
                      type: Type.STRING,
                      description: "The target phone number for WhatsApp, if applicable.",
                    },
                  },
                  required: ["actionType", "query"],
                },
              },
            ],
          },
        ],
      },
      callbacks: {
        onopen: () => {
          opened = true;
          sendToClient({ type: "open" });
        },
        onmessage: (message: LiveServerMessage) => {
          const content = message.serverContent;

          for (const part of content?.modelTurn?.parts ?? []) {
            if (part.inlineData?.data) {
              sendToClient({ type: "audio", data: part.inlineData.data });
            }
            if (part.text && !part.thought && !content?.outputTranscription?.text) {
              sendToClient({ type: "text", text: part.text });
            }
          }

          if (content?.outputTranscription?.text) {
            sendToClient({ type: "outputTranscription", text: content.outputTranscription.text });
          }

          if (content?.inputTranscription?.text) {
            sendToClient({ type: "inputTranscription", text: content.inputTranscription.text });
          }

          if (content?.interrupted) {
            sendToClient({ type: "interrupted" });
          }

          const functionCalls = message.toolCall?.functionCalls;
          if (functionCalls && functionCalls.length > 0) {
            sendToClient({ type: "toolCall", functionCalls });
          }
        },
        onclose: (event: unknown) => {
          const closeInfo = event as { code?: number; reason?: string } | undefined;
          if (!opened && closeInfo?.code && closeInfo.code !== 1000) {
            const reason = closeInfo.reason || `Connection closed (code ${closeInfo.code})`;
            sendToClient({ type: "error", error: reason });
          } else {
            sendToClient({ type: "close" });
          }
          if (!closed) {
            closed = true;
            clientWs.close();
          }
        },
        onerror: (err: unknown) => {
          const msg = extractErrorMessage(err);
          console.error("Live API Error:", msg);
          sendToClient({ type: "error", error: msg });
          if (!closed) {
            closed = true;
            clientWs.close();
          }
        },
      },
    });

    sessionPromise.catch((err) => {
      const msg = extractErrorMessage(err);
      console.error("Failed to connect to Live API:", msg);
      sendToClient({ type: "error", error: msg });
      if (!closed) {
        closed = true;
        clientWs.close();
      }
    });

    clientWs.on("message", async (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString()) as {
          type?: string;
          data?: string;
          text?: string;
          functionResponses?: Array<{
            id?: string;
            name: string;
            response: Record<string, unknown>;
          }>;
        };

        const session = await sessionPromise;
        if (closed) return;

        if (msg.type === "audio" && msg.data) {
          session.sendRealtimeInput({
            audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" },
          });
        } else if (msg.type === "text" && msg.text) {
          session.sendRealtimeInput({ text: msg.text });
        } else if (msg.type === "toolResponse" && Array.isArray(msg.functionResponses)) {
          session.sendToolResponse({
            functionResponses: msg.functionResponses,
          });
        }
      } catch (err) {
        console.error("Live WS client message error:", err);
      }
    });

    clientWs.on("close", () => {
      closed = true;
      sessionPromise
        .then((session) => session.close())
        .catch(() => {});
    });
  });

  const port = Number(process.env.PORT) || 3000;
  server.listen(port, "0.0.0.0", () => {
    console.log(`Server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

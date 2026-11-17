export class LiveSessionManager {
  private ws: WebSocket | null = null;
  private isSessionOpen: boolean = false;
  private isStopping: boolean = false;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  // Audio playback state
  private playbackContext: AudioContext | null = null;
  private nextPlayTime: number = 0;
  private isPlaying: boolean = false;
  public isMuted: boolean = false;

  public onStateChange: (state: "idle" | "listening" | "processing" | "speaking") => void = () => {};
  public onMessage: (sender: "user" | "laddu", text: string) => void = () => {};
  public onCommand: (url: string) => void = () => {};
  public onError: (error: string) => void = () => {};
  public onPermissionDenied: () => void = () => {};

  async start() {
    try {
      this.isStopping = false;
      this.isSessionOpen = false;
      this.onStateChange("processing");

      if (!navigator.mediaDevices?.getUserMedia) {
        this.stop();
        this.onPermissionDenied();
        return;
      }

      // Get Microphone before initializing audio contexts or WebSocket
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      // Initialize Audio Contexts
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioContext = new AudioContextClass({ sampleRate: 16000 });
      this.playbackContext = new AudioContextClass({ sampleRate: 24000 });
      this.nextPlayTime = this.playbackContext.currentTime;

      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      this.processor.onaudioprocess = (e) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isSessionOpen) return;
        const inputData = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        // Convert to base64
        const buffer = new ArrayBuffer(pcm16.length * 2);
        const view = new DataView(buffer);
        for (let i = 0; i < pcm16.length; i++) {
          view.setInt16(i * 2, pcm16[i], true);
        }

        let binary = "";
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64Data = btoa(binary);

        this.ws.send(JSON.stringify({ type: "audio", data: base64Data }));
      };

      this.source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      // Connect to Server Live WebSocket Proxy
      const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${wsProtocol}//${window.location.host}/api/live`;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as {
            type?: string;
            data?: string;
            text?: string;
            error?: string;
            functionCalls?: Array<{
              id?: string;
              name?: string;
              args?: {
                actionType?: string;
                query?: string;
                target?: string;
              };
            }>;
          };

          if (msg.type === "open") {
            console.log("Live API Connected");
            this.isSessionOpen = true;
            this.onStateChange("listening");
          } else if (msg.type === "audio" && msg.data) {
            this.onStateChange("speaking");
            this.playAudioChunk(msg.data);
          } else if (msg.type === "interrupted") {
            this.stopPlayback();
            this.onStateChange("listening");
          } else if ((msg.type === "text" || msg.type === "outputTranscription") && msg.text) {
            this.onMessage("laddu", msg.text);
          } else if (msg.type === "toolCall" && Array.isArray(msg.functionCalls)) {
            for (const call of msg.functionCalls) {
              if (call.name === "executeBrowserAction") {
                const args = call.args || {};
                const query = args.query || "";
                let url = "";
                if (args.actionType === "youtube") {
                  url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
                } else if (args.actionType === "spotify") {
                  url = `https://open.spotify.com/search/${encodeURIComponent(query)}`;
                } else if (args.actionType === "whatsapp") {
                  url = `https://web.whatsapp.com/send?phone=${args.target || ""}&text=${encodeURIComponent(query)}`;
                } else {
                  let website = query.replace(/\s+/g, "");
                  if (!website.includes(".")) website += ".com";
                  url = `https://www.${website}`;
                }

                this.onCommand(url);

                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                  this.ws.send(
                    JSON.stringify({
                      type: "toolResponse",
                      functionResponses: [
                        {
                          name: call.name,
                          id: call.id,
                          response: { result: "Action executed successfully in the browser." },
                        },
                      ],
                    })
                  );
                }
              }
            }
          } else if (msg.type === "error") {
            const errMsg = msg.error || "Live session error";
            console.error("Live API Error:", errMsg);
            this.onError(errMsg);
            this.stop();
          } else if (msg.type === "close") {
            console.log("Live API Closed");
            this.stop();
          }
        } catch (e) {
          console.error("Failed to parse Live message", e);
        }
      };

      ws.onerror = () => {
        if (!this.isStopping) {
          console.error("Live WebSocket Error");
          this.onError("WebSocket connection error");
          this.stop();
        }
      };

      ws.onclose = () => {
        if (!this.isStopping) {
          console.log("Live WebSocket Closed");
          this.stop();
        }
      };
    } catch (error) {
      const isPermissionError =
        (error instanceof DOMException &&
          (error.name === "NotAllowedError" ||
            error.name === "PermissionDeniedError" ||
            error.name === "SecurityError")) ||
        (error instanceof Error && /permission denied|notallowederror/i.test(error.message));

      if (isPermissionError) {
        console.warn("Microphone permission denied:", error);
        this.stop();
        this.onPermissionDenied();
        return;
      }

      console.error("Failed to start Live Session:", error);
      this.onError(error instanceof Error ? error.message : String(error));
      this.stop();
    }
  }

  private playAudioChunk(base64Data: string) {
    if (!this.playbackContext || this.isMuted) return;

    try {
      const binaryString = atob(base64Data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const buffer = new Int16Array(bytes.buffer);
      const audioBuffer = this.playbackContext.createBuffer(1, buffer.length, 24000);
      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < buffer.length; i++) {
        channelData[i] = buffer[i] / 32768.0;
      }

      const source = this.playbackContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.playbackContext.destination);

      const currentTime = this.playbackContext.currentTime;
      if (this.nextPlayTime < currentTime) {
        this.nextPlayTime = currentTime;
      }

      source.start(this.nextPlayTime);
      this.nextPlayTime += audioBuffer.duration;
      this.isPlaying = true;

      source.onended = () => {
        if (this.playbackContext && this.playbackContext.currentTime >= this.nextPlayTime - 0.1) {
          this.isPlaying = false;
          this.onStateChange("listening");
        }
      };
    } catch (e) {
      console.error("Error playing chunk", e);
    }
  }

  private stopPlayback() {
    if (this.playbackContext) {
      this.playbackContext.close().catch(() => {});
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.playbackContext = new AudioContextClass({ sampleRate: 24000 });
      this.nextPlayTime = this.playbackContext.currentTime;
      this.isPlaying = false;
    }
  }

  stop() {
    if (this.isStopping) return;
    this.isStopping = true;
    this.isSessionOpen = false;

    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    if (this.playbackContext) {
      this.playbackContext.close().catch(() => {});
      this.playbackContext = null;
      this.isPlaying = false;
    }

    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }

    this.onStateChange("idle");
  }

  sendText(text: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.isSessionOpen) {
      this.ws.send(JSON.stringify({ type: "text", text }));
    }
  }
}

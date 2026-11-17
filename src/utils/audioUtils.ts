export async function playPCM(base64Data: string): Promise<void> {
  try {
    const AudioContextClass =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) {
      console.warn("AudioContext not supported");
      return;
    }

    const binaryString = atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const audioCtx = new AudioContextClass({ sampleRate: 24000 });
    let audioBuffer: AudioBuffer;

    // Gemini 3.8 unary TTS returns a complete WAV file (RIFF header)
    const isWav =
      bytes.length >= 44 &&
      bytes[0] === 0x52 && // R
      bytes[1] === 0x49 && // I
      bytes[2] === 0x46 && // F
      bytes[3] === 0x46;   // F

    if (isWav) {
      audioBuffer = await audioCtx.decodeAudioData(bytes.buffer.slice(0));
    } else {
      const buffer = new Int16Array(bytes.buffer);
      audioBuffer = audioCtx.createBuffer(1, buffer.length, 24000);
      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < buffer.length; i++) {
        channelData[i] = buffer[i] / 32768.0;
      }
    }

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);
    source.start();

    return new Promise<void>((resolve) => {
      source.onended = () => {
        audioCtx.close().catch(() => {});
        resolve();
      };
    });
  } catch (error) {
    console.error("Error playing audio:", error);
  }
}

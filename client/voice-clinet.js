/**
 * voice-client.js — capacitor-ai-voice-proxy client
 *
 * Drop-in JS client for Capacitor hybrid apps (iOS + Android).
 * Works entirely with Web APIs — no native plugins required.
 *
 * Usage:
 *   KashraVoice.init({ workerUrl, getIdToken, language });
 *   await KashraVoice.startRecording();
 *   const transcript = await KashraVoice.stopAndTranscribe();
 *   await KashraVoice.speak("Your response text here");
 *   KashraVoice.stopSpeaking();
 *
 * MIT License © 2026 Kishore Penmetsa
 * https://github.com/yourusername/capacitor-ai-voice-proxy
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();           // CommonJS / Node
  } else {
    root.KashraVoice = factory();         // Browser global
  }
}(typeof self !== 'undefined' ? self : this, function () {

  // ── State ───────────────────────────────────────────────────────────────
  let _workerUrl   = '';
  let _getIdToken  = null;
  let _language    = 'en-US';
  let _recording   = false;
  let _stream      = null;
  let _recorder    = null;
  let _chunks      = [];
  let _ttsAudio    = null;   // Persistent <audio> element — iOS gesture requirement

  // ── Init ────────────────────────────────────────────────────────────────
  /**
   * Initialise the voice client.
   * @param {Object} options
   * @param {string}   options.workerUrl   - Base URL of your Cloudflare Worker
   * @param {Function} options.getIdToken  - Async fn returning a Firebase ID token
   * @param {string}   [options.language]  - BCP-47 language code (default: 'en-US')
   */
  function init(options) {
    if (!options.workerUrl)  throw new Error('[KashraVoice] workerUrl is required');
    if (!options.getIdToken) throw new Error('[KashraVoice] getIdToken function is required');
    _workerUrl  = options.workerUrl.replace(/\/$/, '');
    _getIdToken = options.getIdToken;
    _language   = options.language || 'en-US';

    // Pre-create the <audio> element now, during a synchronous init call.
    // This satisfies iOS WKWebView's requirement that audio elements be
    // created in a user-gesture context before .play() is called later.
    _ttsAudio = document.getElementById('_kv_tts_audio');
    if (!_ttsAudio) {
      _ttsAudio = document.createElement('audio');
      _ttsAudio.id = '_kv_tts_audio';
      _ttsAudio.setAttribute('playsinline', '');
      document.body.appendChild(_ttsAudio);
    }
  }

  // ── Recording ───────────────────────────────────────────────────────────

  /**
   * Start recording from the microphone.
   * @returns {Promise<void>}
   */
  async function startRecording() {
    if (_recording) throw new Error('[KashraVoice] Already recording');
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('[KashraVoice] getUserMedia not supported on this device');
    }

    _stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _chunks = [];

    // Detect best supported MIME type
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find(t => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) || '';

    _recorder = new MediaRecorder(_stream, mimeType ? { mimeType } : {});
    _recorder.ondataavailable = e => { if (e.data?.size > 0) _chunks.push(e.data); };

    // ⚠️ Critical: pass timeslice=250 to avoid iOS WKWebView 3s audio truncation bug.
    // Without this, ondataavailable only fires on stop(), and WKWebView silently
    // discards audio data after ~3 seconds.
    _recorder.start(250);
    _recording = true;
  }

  /**
   * Stop recording and transcribe via the Worker.
   * @param {string} [language] - Override the language for this request
   * @returns {Promise<{ transcript: string, language: string }>}
   */
  async function stopAndTranscribe(language) {
    if (!_recording || !_recorder) throw new Error('[KashraVoice] Not recording');

    return new Promise(async (resolve, reject) => {
      _recorder.onstop = async () => {
        // Stop mic stream
        _stream?.getTracks().forEach(t => t.stop());
        _stream   = null;
        _recording = false;

        if (!_chunks.length) {
          return reject(new Error('No audio captured'));
        }

        try {
          // Convert recorded audio to LINEAR16 WAV (Google STT requirement)
          const mimeType = _recorder.mimeType || 'audio/webm';
          const blob = new Blob(_chunks, { type: mimeType });
          _chunks = [];

          const base64Audio = await _audioToLinear16Base64(blob);
          const idToken     = await _getIdToken();

          const resp = await fetch(`${_workerUrl}/transcribe`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${idToken}`,
            },
            body: JSON.stringify({
              audio:    base64Audio,
              language: language || _language,
            }),
          });

          const data = await resp.json();
          if (!resp.ok || !data.ok) {
            return reject(new Error(data.error || 'Transcription failed'));
          }

          resolve({ transcript: data.transcript, language: data.language });
        } catch (e) {
          reject(e);
        }
      };

      if (_recorder.state !== 'inactive') _recorder.stop();
    });
  }

  /**
   * Cancel recording without transcribing.
   */
  function cancelRecording() {
    if (!_recording) return;
    if (_recorder && _recorder.state !== 'inactive') {
      _recorder.onstop = null; // Prevent transcription
      _recorder.stop();
    }
    _stream?.getTracks().forEach(t => t.stop());
    _stream    = null;
    _recording = false;
    _chunks    = [];
  }

  // ── Text-to-Speech ───────────────────────────────────────────────────────

  /**
   * Synthesise text to speech via the Worker and play on device.
   * @param {string} text
   * @param {Object} [options]
   * @param {string}   [options.language] - BCP-47 language code
   * @param {string}   [options.gender]   - 'female' (default) or 'male'
   * @returns {Promise<void>} Resolves when audio finishes playing
   */
  async function speak(text, options = {}) {
    if (!text) return;
    if (!_ttsAudio) throw new Error('[KashraVoice] Not initialised — call init() first');

    const idToken = await _getIdToken();
    const resp = await fetch(`${_workerUrl}/speak`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        text:     text.slice(0, 1000),
        language: options.language || _language,
        gender:   options.gender   || 'female',
      }),
    });

    const data = await resp.json();
    if (!resp.ok || !data.ok || !data.audio) {
      throw new Error(data.error || 'TTS failed');
    }

    return new Promise((resolve, reject) => {
      _ttsAudio.src = `data:audio/mp3;base64,${data.audio}`;
      _ttsAudio.onended = () => resolve();
      _ttsAudio.onerror = () => reject(new Error('Audio playback failed'));
      _ttsAudio.play().catch(reject);
    });
  }

  /**
   * Stop speech playback immediately.
   */
  function stopSpeaking() {
    if (_ttsAudio && !_ttsAudio.paused) {
      _ttsAudio.pause();
      _ttsAudio.currentTime = 0;
    }
  }

  // ── Utilities ────────────────────────────────────────────────────────────

  /** @returns {boolean} */
  function isRecording()  { return _recording; }

  /** @returns {boolean} */
  function isSpeaking()   { return _ttsAudio ? !_ttsAudio.paused : false; }

  /**
   * Set the active BCP-47 language code.
   * @param {string} langCode
   */
  function setLanguage(langCode) { _language = langCode; }

  // ── Audio conversion ──────────────────────────────────────────────────────
  // Converts any audio blob to a 16kHz mono LINEAR16 WAV base64 string.
  // Google STT requires LINEAR16 PCM — this conversion runs in-browser
  // using Web Audio API with no native dependencies.

  async function _audioToLinear16Base64(blob) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('Web Audio API not supported');

    const ctx = new AudioCtx({ sampleRate: 16000 });
    let audioBuffer;
    try {
      audioBuffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    } catch (e) {
      ctx.close();
      throw new Error(`Audio decode failed: ${e.message}`);
    }

    // Downmix to mono (channel 0) and convert float32 → int16
    const channelData = audioBuffer.getChannelData(0);
    const pcmData = new Int16Array(channelData.length);
    for (let i = 0; i < channelData.length; i++) {
      const s = Math.max(-1, Math.min(1, channelData[i]));
      pcmData[i] = s < 0
        ? Math.max(-32768, Math.round(s * 32768))
        : Math.min(32767,  Math.round(s * 32767));
    }
    ctx.close();

    // Build 44-byte WAV header
    const wavLen = 44 + pcmData.byteLength;
    const wav    = new Uint8Array(wavLen);
    const view   = new DataView(wav.buffer);

    const ws = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    ws(0, 'RIFF'); view.setUint32(4,  wavLen - 8, true);
    ws(8, 'WAVE'); ws(12, 'fmt ');
    view.setUint32(16, 16,    true);  // PCM chunk size
    view.setUint16(20, 1,     true);  // PCM format
    view.setUint16(22, 1,     true);  // Mono
    view.setUint32(24, 16000, true);  // Sample rate
    view.setUint32(28, 32000, true);  // Byte rate (16000 * 1 * 2)
    view.setUint16(32, 2,     true);  // Block align
    view.setUint16(34, 16,    true);  // Bits per sample
    ws(36, 'data'); view.setUint32(40, pcmData.byteLength, true);
    wav.set(new Uint8Array(pcmData.buffer), 44);

    // Convert to base64
    let binary = '';
    const bytes = new Uint8Array(wav.buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  // ── Public API ───────────────────────────────────────────────────────────
  return {
    init,
    startRecording,
    stopAndTranscribe,
    cancelRecording,
    speak,
    stopSpeaking,
    isRecording,
    isSpeaking,
    setLanguage,
  };

}));

# ADR-001: Serverless AI Voice Proxy for Capacitor Hybrid Applications

 Status:  Accepted  
 Date:  2026-05-22  
 Author:  Naga Raghu Kishore, Penujuri 
 Project:  KashRA — Privacy-first Personal Finance App  
 Repository:  capacitor-ai-voice-proxy (MIT License)

---

**Context**

KashRA is a Capacitor 8 hybrid application targeting iOS and Android. The app required a full-duplex AI voice interface — users speak financial questions, receive spoken AI responses — with the following hard constraints:

-  Zero server infrastructure  — no Express/Node backend, no cloud functions to maintain
-  API key security  — Google STT/TTS and Anthropic keys must never be exposed to the client
-  Per-user quota enforcement  — AI voice calls must be gated by Firebase Auth and usage limits
-  Cross-platform parity  — identical behaviour on iOS (WKWebView) and Android (WebView)
-  Multilingual  — English, Hindi, Telugu, Tamil, Kannada, Malayalam (NRI user base)

  # The Problem with Existing Approaches

| Approach | Problem |
|----------|---------|
| @capacitor-community/speech-recognition | Uses `SFSpeechRecognizer` on iOS — does not bridge reliably into WKWebView JS context; permission prompts broken in Capacitor 8 |
| Native Capacitor plugin (Swift/Kotlin) | Platform-specific code for every API; maintenance burden; cannot enforce per-user server-side quota |
| Direct Google STT/TTS API calls from JS | Exposes API keys in client bundle — trivially extractable from APK/IPA |
| Backend server (Node/Express) | Infrastructure cost, cold starts, ops burden — incompatible with zero-server architecture |
| WebSpeech API (`window.speechSynthesis`) | Robotic voice quality; no multilingual NLP accuracy; unavailable in some WKWebView configurations |

None of these solved all constraints simultaneously.

---

 **Decision**

Implement a  Cloudflare Worker as a stateless authenticated proxy  that:

1. Verifies Firebase ID tokens using Google's public JWK endpoint (no SDK dependency)
2. Proxies Google Cloud Speech-to-Text (STT) for voice transcription
3. Proxies Google Cloud Text-to-Speech (TTS) for Neural2/WaveNet voice synthesis
4. Enforces per-user quota via Firestore without exposing credentials

The client-side implementation uses  standard Web APIs only  — `navigator.mediaDevices.getUserMedia`, `MediaRecorder`, `Web Audio API`, and `fetch` — requiring zero native plugins.

---

  ** Architecture**


┌─────────────────────────────────────────────────┐
│           Capacitor App (WKWebView / WebView)    │
│                                                  │
│  getUserMedia() → MediaRecorder(timeslice:250)   │
│       ↓                                          │
│  Web Audio API → LINEAR16 WAV → base64           │
│       ↓                                          │
│  fetch('/transcribe', { Bearer: idToken })       │
│       ↓                          ↑               │
│  transcript → Claude AI → response               │
│       ↓                                          │
│  fetch('/speak', { text, language })             │
│       ↓                                          │
│  base64 MP3 → <audio>.play()                     │
└──────────────────┬──────────────────────────────┘
                   │ HTTPS
┌──────────────────▼──────────────────────────────┐
│         Cloudflare Worker (Edge, ~0ms cold)      │
│                                                  │
│  verifyFirebaseToken(idToken)                    │
│       ↓  (RS256 via crypto.subtle)               │
│  checkQuota(uid, feature, plan)  ← Firestore     │
│       ↓                                          │
│  Google STT API  ←→  /transcribe route           │
│  Google TTS API  ←→  /speak route                │
│                                                  │
│  Secrets: GOOGLE_SPEECH_API_KEY (never exposed)  │
└─────────────────────────────────────────────────┘


---

  ** Implementation Details**

  # 1. Audio Capture (Client)

javascript
// Critical: timeslice=250 required on iOS WKWebView
// Without it, MediaRecorder buffers only ~3s before data loss
_voiceMediaRecorder.start(250);

// Convert to LINEAR16 WAV at 16kHz (Google STT requirement)
async function _audioToLinear16Base64(blob) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  const audioBuffer = await ctx.decodeAudioData(await blob.arrayBuffer());
  const channelData = audioBuffer.getChannelData(0);
  const pcmData = new Int16Array(channelData.length);
  for (let i = 0; i < channelData.length; i++) {
    const s = Math.max(-1, Math.min(1, channelData[i]));
    pcmData[i] = s < 0 ? Math.max(-32768, Math.round(s * 32768))
                       : Math.min(32767,  Math.round(s * 32767));
  }
  // Build WAV header + PCM data, return base64
  // ... (44-byte WAV header construction)
  return btoa(binary);
}


 Key finding:  `MediaRecorder.start()` without a timeslice argument causes WKWebView on iOS to buffer only the first 2–3 seconds of audio before silently discarding subsequent data. Passing `timeslice: 250` forces `ondataavailable` to fire every 250ms, ensuring continuous chunk collection regardless of recording duration.

  # 2. Firebase Token Verification (Worker)

The Worker verifies tokens using only the Web Crypto API — no Firebase Admin SDK, no Node.js:

javascript
async function verifyFirebaseToken(idToken, env) {
  const [header, payload, sig] = idToken.split('.');
  const { kid } = jsonFromB64(header);
  // Fetch Google's public JWK set (cached 1hr at edge)
  const jwkSet = await fetch(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
    { cf: { cacheTtl: 3600 } }
  ).then(r => r.json());
  const jwk = jwkSet.keys.find(k => k.kid === kid);
  const cryptoKey = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    b64urlToBuffer(sig),
    new TextEncoder().encode(`${header}.${payload}`)
  );
  return valid ? { ok: true, uid: jsonFromB64(payload).user_id } : { ok: false };
}


  # 3. STT Route (Worker)

javascript
if (request.method === 'POST' && url.pathname === '/transcribe') {
  const { ok, uid } = await verifyFirebaseToken(idToken, env);
  if (!ok) return error(401, 'auth_invalid');

  const { audio, language } = await request.json();
  const sttResp = await fetch(
    `https://speech.googleapis.com/v1/speech:recognize?key=${env.GOOGLE_SPEECH_API_KEY}`,
    {
      method: 'POST',
      body: JSON.stringify({
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: 16000,
          languageCode: language || 'en-US',
          alternativeLanguageCodes: ['hi-IN','ta-IN','te-IN','kn-IN','ml-IN'],
          enableAutomaticPunctuation: true,
          model: 'latest_short'
        },
        audio: { content: audio }
      })
    }
  );
  const { results } = await sttResp.json();
  return json({ transcript: results?.[0]?.alternatives?.[0]?.transcript || '' });
}


  # 4. TTS Route (Worker)

javascript
// Voice selection: Neural2 for English, WaveNet for Indian languages
// Note: Google Neural2 voices are NOT available for Indian languages as of 2026
const voiceMap = {
  'en-US': 'en-US-Neural2-F',   // Neural2 — highest quality
  'hi-IN': 'hi-IN-Wavenet-A',   // WaveNet — best available for Hindi
  'ta-IN': 'ta-IN-Wavenet-A',
  'te-IN': 'te-IN-Wavenet-A',
  'kn-IN': 'kn-IN-Wavenet-A',
  'ml-IN': 'ml-IN-Wavenet-A'
};

// Audio optimised for mobile earphones
audioConfig: {
  audioEncoding: 'MP3',
  speakingRate: 1.05,
  pitch: -1.0,
  effectsProfileId: ['headphone-class-device']
}


  # 5. iOS Audio Playback (Client)

iOS WKWebView requires a user gesture before `HTMLAudioElement.play()` is permitted. The solution is to reuse a single persistent `<audio>` element created during a user interaction (the TTS toggle button tap), rather than creating a `new Audio()` programmatically:

javascript
// Created once during user gesture (TTS toggle tap)
const audio = document.createElement('audio');
audio.id = 'kashra-tts-audio';
document.body.appendChild(audio);

// Reused for every TTS response — iOS gesture requirement satisfied
audio.src = 'data:audio/mp3;base64,' + data.audio;
audio.play(); // permitted because element was created during gesture

---

   Consequences

  # Positive

-  Zero infrastructure  — Cloudflare Workers run at edge, ~0ms cold start, free tier covers ~100K requests/day
-  API keys never exposed  — stored as Cloudflare Worker secrets, inaccessible to client
-  Cross-platform parity  — identical JS code path on iOS and Android
-  Multilingual out of the box  — Google STT auto-detects language from alternativeLanguageCodes
-  Per-user quota  — enforced server-side via Firestore, not bypassable client-side
-  No native plugins  — no Swift/Kotlin maintenance, no plugin compatibility matrix

  # Negative

-  Latency  — record → upload → STT → AI → TTS pipeline adds ~2–4s vs streaming STT
-  No streaming transcription  — word-by-word display requires WebSocket (gRPC bridge), not implemented
-  Google TTS Neural2 unavailable for Indian languages  — WaveNet used as fallback; quality gap noticeable
-  Cloudflare dependency  — Worker pricing changes could affect cost model at scale

  # Neutral

- `GOOGLE_SPEECH_API_KEY` serves both STT and TTS — simplifies secret management but requires both APIs enabled on the same GCP project

---

   Alternatives Considered

  # WebSocket Streaming (Deepgram)
Deepgram's API supports WebSocket-based streaming STT with word-by-word results. This would enable real-time transcription display. Rejected for initial implementation due to additional vendor dependency and pricing uncertainty at scale. Viable future upgrade path.

  # OpenAI Whisper
High accuracy, language-agnostic. No streaming. Similar latency to Google STT. Rejected because OpenAI TTS has no Indian language support — splitting STT and TTS vendors adds complexity.

  # Native Capacitor Plugin
A custom Swift plugin using `SFSpeechRecognizer` + `AVSpeechSynthesizer` would provide the best iOS performance. Rejected because: (a) equivalent Android plugin required separately, (b) quota enforcement still requires server-side component, (c) maintenance burden for a solo developer.

---

   Known Issues & Mitigations

| Issue | Root Cause | Mitigation |
|-------|-----------|------------|
| iOS records only first 3s | `MediaRecorder.start()` without timeslice | `start(250)` — chunks collected every 250ms |
| `new Audio().play()` blocked on iOS | WKWebView autoplay policy | Persistent `<audio id="kashra-tts-audio">` created on user gesture |
| Google Neural2 unavailable for Indian languages | Google product limitation | WaveNet fallback with tuned `speakingRate` and `pitch` |
| Firebase token verification without SDK | Workers runtime has no Node modules | `crypto.subtle` RS256 verification against Google JWK endpoint |

---

   Related Work

- Capacitor community plugin `@capacitor-community/speech-recognition` — native bridge approach, iOS reliability issues in WKWebView
- Cloudflare Workers documentation: [Service Worker API](https://developers.cloudflare.com/workers/)
- Google Cloud Speech-to-Text: [REST API v1](https://cloud.google.com/speech-to-text/docs/reference/rest)
- Google Cloud Text-to-Speech: [Neural2 voices](https://cloud.google.com/text-to-speech/docs/neural2)
- Firebase Authentication: [ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens)

---

   Future Work

- [ ] WebSocket streaming STT via Deepgram for word-by-word transcription
- [ ] Voice Activity Detection (VAD) — auto-stop recording on silence
- [ ] Refresh token persistence in iOS Keychain (currently memory-only)
- [ ] npm package: `capacitor-ai-voice-proxy-client` — JS client wrapper
- [ ] OpenAPI spec for Worker routes

---

*This ADR is published as part of the `capacitor-ai-voice-proxy` open source project. See [GitHub repository](#) for the full implementation.*

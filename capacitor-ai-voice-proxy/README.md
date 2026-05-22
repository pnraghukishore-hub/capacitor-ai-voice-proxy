# capacitor-ai-voice-proxy

> **Multilingual AI voice (STT + TTS) for Capacitor hybrid apps — no backend server, no exposed API keys, no native plugins.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare)](https://workers.cloudflare.com)
[![Capacitor](https://img.shields.io/badge/Capacitor-8-119EFF?logo=capacitor)](https://capacitorjs.com)
[![Google STT](https://img.shields.io/badge/Google-Speech--to--Text-4285F4?logo=google)](https://cloud.google.com/speech-to-text)
[![Google TTS](https://img.shields.io/badge/Google-Text--to--Speech-4285F4?logo=google)](https://cloud.google.com/text-to-speech)

---

## The Problem

Every Capacitor developer building a voice feature hits the same wall:

- `@capacitor-community/speech-recognition` breaks in WKWebView on iOS
- Calling Google STT/TTS directly from JS exposes your API keys in the app bundle
- A full backend server is overkill for a mobile-first app
- Per-user quota enforcement needs a server-side component anyway

This repo solves all four problems with a single **Cloudflare Worker** acting as an authenticated edge proxy.

---

## What's Inside

```
capacitor-ai-voice-proxy/
├── worker/
│   └── voice-proxy.js        # Cloudflare Worker — deploy as-is
├── client/
│   └── voice-client.js       # Drop-in JS client for your Capacitor app
├── docs/
│   └── adr/
│       └── ADR-001.md        # Architecture Decision Record
└── README.md
```

---

## How It Works

```
Capacitor App (iOS WKWebView / Android WebView)
        │
        │  getUserMedia() → MediaRecorder(timeslice: 250)
        │  Web Audio API → LINEAR16 WAV → base64
        │
        ▼
Cloudflare Worker  (api.yourdomain.com)
        │
        ├── verifyFirebaseToken()   ← RS256 via crypto.subtle, no SDK
        ├── checkQuota(uid)         ← Firestore, per-user limits
        │
        ├── POST /transcribe  →  Google Cloud Speech-to-Text
        └── POST /speak       →  Google Cloud Text-to-Speech Neural2/WaveNet
        │
        ▼
MP3 base64 → <audio> element → plays on device
```

**No Express server. No Firebase Functions. No native Swift/Kotlin. Zero cold starts.**

---

## Supported Languages

| Language | STT | TTS Voice | Quality |
|----------|-----|-----------|---------|
| English (US) | ✅ | `en-US-Neural2-F` | Neural2 — best |
| Hindi | ✅ auto-detect | `hi-IN-Wavenet-A` | WaveNet |
| Telugu | ✅ auto-detect | `te-IN-Wavenet-A` | WaveNet |
| Tamil | ✅ auto-detect | `ta-IN-Wavenet-A` | WaveNet |
| Kannada | ✅ auto-detect | `kn-IN-Wavenet-A` | WaveNet |
| Malayalam | ✅ auto-detect | `ml-IN-Wavenet-A` | WaveNet |
| English (GB) | ✅ | `en-GB-Neural2-A` | Neural2 |

> **Note:** Google Neural2 voices are not available for Indian languages as of 2026. WaveNet is the best available alternative and significantly outperforms browser `speechSynthesis`.

---

## Quick Start

### 1. Prerequisites

- Cloudflare account (free tier sufficient — 100K requests/day)
- Google Cloud project with **Cloud Speech-to-Text API** and **Cloud Text-to-Speech API** enabled
- Firebase project with Authentication enabled
- Capacitor 5+ app

### 2. Deploy the Worker

```bash
# Clone the repo
git clone https://github.com/yourusername/capacitor-ai-voice-proxy
cd capacitor-ai-voice-proxy

# Install Wrangler
npm install -g wrangler
wrangler login

# Set your secrets (never committed to git)
wrangler secret put GOOGLE_SPEECH_API_KEY
wrangler secret put FIREBASE_PROJECT_ID
wrangler secret put FIREBASE_CLIENT_EMAIL
wrangler secret put FIREBASE_PRIVATE_KEY

# Deploy
wrangler deploy worker/voice-proxy.js
```

Your Worker is live at `https://voice-proxy.<your-subdomain>.workers.dev`

### 3. Add a custom domain (recommended)

In Cloudflare dashboard → Workers → your worker → Triggers → Add Custom Domain.  
Point `api.yourdomain.com` at the Worker.

### 4. Drop the client into your Capacitor app

```html
<!-- In your index.html -->
<script src="client/voice-client.js"></script>
```

```javascript
// Initialise once after Firebase auth
KashraVoice.init({
  workerUrl: 'https://api.yourdomain.com',
  getIdToken: () => firebase.auth().currentUser.getIdToken(),
  language: 'en-US'   // or 'hi-IN', 'te-IN' etc.
});

// Start recording
await KashraVoice.startRecording();

// Stop and get transcript
const transcript = await KashraVoice.stopAndTranscribe();
console.log(transcript); // "Hey, I need insights on buying a house"

// Speak a response
await KashraVoice.speak("Here are three things to consider...");

// Stop speaking
KashraVoice.stopSpeaking();
```

---

## Worker Routes

### `POST /transcribe`

Transcribe audio to text.

**Headers:**
```
Authorization: Bearer <Firebase ID Token>
Content-Type: application/json
```

**Body:**
```json
{
  "audio": "<base64 LINEAR16 WAV>",
  "language": "en-US"
}
```

**Response:**
```json
{
  "ok": true,
  "transcript": "Hey I need some insights into buying a new house",
  "language": "en-US"
}
```

---

### `POST /speak`

Synthesise text to speech.

**Headers:**
```
Authorization: Bearer <Firebase ID Token>
Content-Type: application/json
```

**Body:**
```json
{
  "text": "Here are three things to consider when buying a house...",
  "language": "en-US",
  "gender": "female"
}
```

**Response:**
```json
{
  "ok": true,
  "audio": "<base64 MP3>"
}
```

---

## Key Implementation Notes

### iOS: MediaRecorder timeslice

**Critical.** Always call `mediaRecorder.start(250)` — not `start()`.

Without the 250ms timeslice, WKWebView on iOS silently discards audio data after ~3 seconds. This is a WebKit bug. Passing a timeslice forces `ondataavailable` to fire every 250ms, accumulating chunks correctly for recordings of any length.

```javascript
// ❌ Wrong — truncates to ~3s on iOS
mediaRecorder.start();

// ✅ Correct — works for any duration on iOS and Android
mediaRecorder.start(250);
```

### iOS: Audio playback gesture requirement

WKWebView blocks `new Audio().play()` unless called within a user gesture. The fix is to create and reuse a persistent `<audio>` element that was first created during a user interaction:

```javascript
// Create once during a button tap (user gesture)
const audio = document.createElement('audio');
audio.id = 'voice-tts-audio';
document.body.appendChild(audio);

// Reuse for every TTS response — gesture requirement satisfied
audio.src = 'data:audio/mp3;base64,' + responseAudio;
await audio.play(); // ✅ works on iOS
```

### Firebase token verification without SDK

The Worker verifies Firebase ID tokens using only the **Web Crypto API** — no `firebase-admin`, no Node.js, no npm dependencies:

```javascript
// RS256 verification using crypto.subtle
const cryptoKey = await crypto.subtle.importKey(
  'jwk', googlePublicJwk,
  { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  false, ['verify']
);
const valid = await crypto.subtle.verify(
  'RSASSA-PKCS1-v1_5', cryptoKey, signature, signingInput
);
```

This keeps the Worker bundle tiny (~15KB) and free of dependency vulnerabilities.

---

## Cost Estimate

At typical voice usage in a personal finance app (~10 voice queries/user/day):

| Service | Usage | Cost |
|---------|-------|------|
| Cloudflare Workers | 100K req/day | Free tier |
| Google STT | 1M chars/month per 1K users | ~$1.44 |
| Google TTS (WaveNet) | 1M chars/month per 1K users | ~$4.00 |
| Google TTS (Neural2) | 1M chars/month per 1K users | ~$16.00 |
| **Total (1K users)** | | **~$5–20/month** |

> Neural2 is English-only. WaveNet is used for Indian languages at lower cost.

---

## Architecture Decision Record

See [`docs/adr/ADR-001.md`](docs/adr/ADR-001.md) for the full rationale behind this architecture, alternatives considered, known trade-offs, and future work.

---

## Comparison with Existing Approaches

| Approach | iOS Works | No Exposed Keys | No Server | Multilingual | Per-user Quota |
|----------|-----------|-----------------|-----------|--------------|----------------|
| **This repo** | ✅ | ✅ | ✅ | ✅ | ✅ |
| `@cap-community/speech-recognition` | ⚠️ Unreliable | ✅ | ✅ | ❌ | ❌ |
| Direct Google API from JS | ✅ | ❌ | ✅ | ✅ | ❌ |
| Firebase Cloud Functions | ✅ | ✅ | ❌ | ✅ | ✅ |
| Custom native plugin | ✅ | ✅ | ✅ | ⚠️ Limited | ❌ |
| WebSpeech API | ✅ | ✅ | ✅ | ⚠️ Limited | ❌ |

---

## Real-World Usage

This pattern was developed for **[KashRA](https://kashra.app)** — a privacy-first personal finance app for NRI users. KashRA uses this voice stack to power its AI Financial Advisor: users ask financial questions in English, Hindi, or Telugu and receive spoken responses using Claude AI.

The implementation handles:
- Recordings up to 60 seconds
- Automatic language detection across 6 Indian languages
- Per-user AI quota enforcement (free / smart / pro tiers)
- iOS 16+ and Android 10+ via Capacitor 8

---

## Contributing

PRs welcome. Priority areas:

- [ ] WebSocket streaming STT (Deepgram) for word-by-word transcription
- [ ] Voice Activity Detection — auto-stop on silence
- [ ] OpenAPI spec for Worker routes
- [ ] Jest tests for Worker routes
- [ ] React Native port

---

## License

MIT © 2026 Kishore Penmetsa

---

## Citation

If you use this in your project or research, please cite:

```bibtex
@misc{penmetsa2026capacitorvoice,
  author = {Naga Raghu Kishore, Penujuri},
  title  = {capacitor-ai-voice-proxy: Serverless AI Voice for Capacitor Hybrid Applications},
  year   = {2026},
  url    = {https://github.com/yourusername/capacitor-ai-voice-proxy},
  note   = {MIT License}
}
```

---

*Built with 🎙️ for the Capacitor community.*

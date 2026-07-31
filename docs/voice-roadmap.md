# Voice roadmap — the phone front door

The SMS lanes are live; voice is the next module. The design goal is the same one that shapes the whole system: **the voice layer is the mouth and ears, never the brain.** Whatever answers the phone captures intent and hands structured data to the same state machine that runs SMS — one brain, every channel.

## Architecture

```
caller ──> phone number (Twilio, under BAA)
              │  Media Streams (websocket audio)
              ▼
        voice runtime (Pipecat, self-hosted)
        ├── STT: Whisper (faster-whisper / whisper.cpp)
        ├── LLM: same brain as SMS (local or BAA-covered cloud)
        └── TTS: Chatterbox-Turbo (MIT) or Kokoro (Apache 2.0)
              │  webhooks / function calls
              ▼
        n8n state machine (queue, booking, audit log)
```

## Why self-hosted voice for healthcare

Patient calls are PHI the moment a caller mentions their treatment. Most hosted voice-AI platforms only sign BAAs at enterprise tiers; self-serve tiers explicitly prohibit PHI. Running STT/LLM/TTS on owned compute (a practice's VM, or an on-prem box) means **there is no AI vendor in the PHI path at all** — the only remaining vendor is the telephony carrier, which does sign BAAs. For a privacy-sensitive buyer, "the voice answering your patients runs on a computer you own" is an architecture, not a slogan.

Hosted platforms (ElevenLabs Agents and peers) remain the right call in two situations: an organization already holding an enterprise BAA with the vendor, or deployments where the voice vendor's platform is wrapped by an integrator who carries the agreement — and their voice quality is genuinely excellent (notably, hosted TTS voices can also be consumed *through* telephony providers' BAA-covered pipelines, which composes the best voices with an owned brain).

## Behavior rules (same as SMS, spoken)

- Introduces itself honestly as the after-hours assistant; never pretends to be human.
- Captures three things: who's calling, what they need, when to call back. No clinical advice, ever.
- Urgent/emergency phrases trigger the practice's emergency script verbatim.
- Every call produces a transcript-backed task in the same queue the SMS lane uses; a human closes it.
- Latency budget: sub-second turn-taking target — streaming STT, streaming LLM tokens, streaming TTS, with barge-in (interruption) support from the runtime.

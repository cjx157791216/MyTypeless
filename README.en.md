# MyTypeless

English · [中文](README.md)

An AI voice dictation tool for macOS: **hold `Fn`, speak, release — polished text is typed at your cursor.** Speech recognition runs locally by default, AI polishing uses your own API key (BYOK), and history never leaves your Mac.

It also has a **meeting mode**: record in-person meetings, tell speakers apart on-device, remember voices, and generate per-speaker summaries and minutes afterwards.

> MyTypeless is an independent personal open-source project and is not affiliated with Typeless or its developers. All code, prompts, UI text and icons are original.

## Features

- **Dictation**: hold `Fn` to talk, release to insert; tap `Fn` for hands-free mode. Mixed Chinese/English, automatic punctuation, filler words and self-corrections removed.
- **Rewrite selection**: select text, press `Fn` and say "shorter", "in English", … — the result replaces the selection.
- **Ask** (`Fn` + `Space`) and **Translate** (`Fn` + `Shift`).
- **Personal dictionary**: add terms manually; it also learns from your corrections and frequently used proper nouns.
- **Meeting mode**: sentence-by-sentence transcript, on-device speaker diarization and voiceprints, editable minutes with Markdown export.
- **Auto update**: notifies you of new versions; downloads in-app after you confirm, then restart to apply.

The UI is currently in Chinese. Built-in recognition defaults to FireRedASR2 for Chinese/English and Whisper for other languages.

## Install

1. Download the latest `MyTypeless-<version>-<build>-arm64.dmg` from [Releases](https://github.com/cjx157791216/MyTypeless/releases/latest) (Apple Silicon only).
2. Drag MyTypeless into Applications. The app is not notarized: **right-click → Open** the first time.
3. Follow the onboarding on the home page: download a speech model, grant Accessibility and Microphone permissions, and set *System Settings → Keyboard → Press 🌐 key to* "Do Nothing". For AI polishing, fill in any OpenAI-compatible base URL and API key.

## Privacy

Only registered shortcuts are matched (no keylogging); audio is discarded after recognition and never written to disk (meeting audio is kept temporarily until the meeting is processed); no screen text or URLs are collected; history, dictionary and voiceprints stay local; API keys are encrypted in the macOS Keychain; there is no central server. See [D-002](docs/decisions/domains/general.md).

## Build from source

Requires an Apple Silicon Mac, Xcode Command Line Tools, Node.js 24 (or 22.18+), and `brew install cmake`.

```bash
npm install
npm run native     # Swift helpers
npm run whisper    # whisper.cpp engine
npm run diarize    # sherpa-onnx helper (downloads ~230MB of prebuilt libraries on first run)
npm run dev
npm run typecheck && npm run test && npm run build && npm run docs:check
npm run dist       # package into release/
```

In dev mode, Accessibility and Microphone permissions belong to the terminal app that runs `npm run dev`.

## Contributing

Issues and pull requests are welcome — a **Windows port** especially. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first. Project documentation (requirements, decisions, contracts) lives in [docs/](docs/AGENTS.md) and is written in Chinese; issues and PRs in English are fine.

## License

[MIT](LICENSE). Third-party components and downloadable models are listed in [build/THIRD_PARTY_NOTICES.md](build/THIRD_PARTY_NOTICES.md).

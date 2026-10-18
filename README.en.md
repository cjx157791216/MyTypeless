# MyTypeless

English · [中文](README.md)

An AI voice dictation tool for macOS and Windows: **hold a shortcut, speak, release — polished text is typed at your cursor.** Speech recognition runs locally by default, AI polishing uses your own API key (BYOK), and history never leaves your computer.

It also has a **meeting mode**: record in-person or online meetings, tell speakers apart on-device, remember voices, and generate per-speaker summaries and minutes afterwards.

> MyTypeless is an independent personal open-source project and is not affiliated with Typeless or its developers. All code, prompts, UI text and icons are original.

## Features

- **Dictation**: hold the main key to talk, release to insert; tap it for hands-free mode and tap again to finish. Mixed Chinese/English, automatic punctuation, filler words and self-corrections removed.
- **Rewrite selection**: select text, press the main key and say "shorter", "in English", … — the result replaces the selection.
- **Translate**: speak in your own language; text in the target language set in Settings is inserted.
- **Ask**: speak a question; the answer appears in a floating card and can be inserted at the cursor.
- **Personal dictionary**: add terms manually; it also learns from your corrections and frequently used proper nouns.
- **Meeting mode**: live sentence-by-sentence transcript, on-device speaker diarization and voiceprints, editable minutes with Markdown export. For online meetings it can also capture the meeting app's audio, diarize in-room and remote speakers separately, and remove speaker echo.
- **On-device recognition**: FireRedASR2 for Chinese/English, Whisper for other languages; fully offline after a one-time model download.
- **Auto update**: notifies you of new versions; downloads in-app after you confirm, then restart to apply.

The UI is currently in Chinese.

### Default shortcuts

| Action | macOS | Windows |
| --- | --- | --- |
| Dictation (hold to talk / tap for hands-free) | `Fn` | Right `Ctrl` |
| Rewrite | Select text, then press the main key | Select text, then press the main key |
| Translate | `Fn` + `Shift` | Right `Ctrl` + `Shift` |
| Ask | `Fn` + `Space` | Right `Ctrl` + `Space` |

Shortcuts can be changed in Settings. Windows cannot read the Fn key, so the main key defaults to Right Ctrl; keyboards without it can use Right Shift or Right Alt.

## Install

Download the latest release for your platform from [Releases](https://github.com/cjx157791216/MyTypeless/releases/latest):

| Platform | File | Notes |
| --- | --- | --- |
| macOS (Apple Silicon) | `MyTypeless-<version>-<build>-arm64.dmg` | Drag MyTypeless into Applications. Not notarized: **right-click → Open** the first time |
| Windows 10/11 (x64) | `MyTypeless-<version>-<build>-win-x64.exe` | Installs for the current user, no admin rights needed. Not code-signed: if SmartScreen says "Windows protected your PC", click *More info → Run anyway* |
| Windows portable | `MyTypeless-<version>-<build>-win-x64.zip` | Unzip and run `MyTypeless.exe`; shares data with the installed version. New versions are announced only — download the new zip manually |

### First run

Follow the onboarding on the home page:

1. **Download a speech model**: "中文高精度" (high-accuracy Chinese, ~1.3GB, one-time) is recommended for Chinese and English.
2. **Grant permissions**:
   - macOS: Accessibility and Microphone. Also set *System Settings → Keyboard → Press 🌐 key to* "Do Nothing", otherwise releasing Fn opens the emoji picker.
   - Windows: allow desktop apps to access the microphone in *Settings → Privacy & security → Microphone*.
3. **(Optional) AI polishing**: fill in any OpenAI-compatible base URL and API key to enable polishing, translation, rewriting and asking; without one, only local cleanup is applied.

### Platform differences

| | macOS | Windows |
| --- | --- | --- |
| Requirements | Apple Silicon | Windows 10/11 x64 |
| Whisper (languages other than Chinese/English) | GPU | CPU only, slower |
| Capturing meeting app audio | macOS 14.2+ | Windows 11 |

## Privacy

- Only registered shortcuts are matched — no keylogging.
- Audio is discarded after recognition and never written to disk; meeting audio is kept temporarily and deleted once the meeting is processed.
- No screen text or URLs are collected; history, dictionary and voiceprints stay local; API keys are encrypted by the OS (macOS Keychain, Windows Data Protection API).
- Two opt-in features, both off by default: "use text before the cursor" sends up to 300 characters before the cursor with the polishing request to your configured model (not stored, password fields are never read); "learn my edits" stores your edited dictation results locally (up to 50, deletable) and sends a few as examples when polishing.
- There is no central server: cloud features only use services you configure; update checks only read the public release notes and send none of your data (can be turned off).

See [D-002](docs/decisions/domains/general.md) for the full rules.

## Build from source

### macOS

Requires an Apple Silicon Mac, Xcode Command Line Tools, Node.js 24 (or 22.18+), and `brew install cmake`.

```bash
npm install
npm run native     # Swift helpers
npm run whisper    # whisper.cpp engine
npm run diarize    # sherpa-onnx helper (downloads ~230MB of prebuilt libraries on first run)
npm run dev
```

In dev mode, Accessibility and Microphone permissions belong to the terminal app that runs `npm run dev`.

### Windows

Requires Windows 10/11 x64, Node.js 24, git, and Visual Studio 2022 Build Tools ("Desktop development with C++").

```bash
npm run setup:win    # use instead of npm install (see CONTRIBUTING.md)
npm run native:win   # C++ helpers
npm run diarize:win  # sherpa-onnx helper (downloads ~120MB of static libraries on first run)
npm run whisper:win  # whisper.cpp engine (CPU only)
npm run dev
```

### Checks and packaging

```bash
npm run typecheck && npm run test && npm run build && npm run docs:check
npm run dist       # package into release/: DMG + zip on macOS, installer + zip on Windows
```

Self-built packages are not signed with the publisher's certificate, so they cannot auto-update from or to official releases.

## Contributing

Issues and pull requests are welcome for both macOS and Windows. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first. Project documentation (requirements, decisions, contracts) lives in [docs/](docs/AGENTS.md) and is written in Chinese; issues and PRs in English are fine.

## License

[MIT](LICENSE). Third-party components and downloadable models are listed in [build/THIRD_PARTY_NOTICES.md](build/THIRD_PARTY_NOTICES.md).

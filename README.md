<!-- Copyright 2026 SeohoKim
SPDX-License-Identifier: Apache-2.0
-->

# SeohoKim Loop

**Bring your own AI. Let them work together.**

One request. Multiple AI providers. One collaborative workflow.

A Windows desktop application for natural-language tasks, provider connections and staged draft/review/improvement.
[English](README.md) | [한국어](README.ko.md)

Keep a task and its intermediate results in one place instead of copying replies between AI windows.
Use a simple desktop interface, separate provider adapters, visible step results, cancellation, local history and Markdown export.
This project coordinates existing AI services and local models; it does not train a new model.

**Windows x64 · source preview · Apache-2.0 · no AI account needed for the default Mock demo**

This is an early open-source preview, not a Windows installer. Identified project-owned source, configuration and documentation
are licensed under the [Apache License 2.0](LICENSE). Copyright 2026 SeohoKim. Third-party terms remain separate.
See [NOTICE](NOTICE) for scope; applicable files carry SPDX comments or adjacent `.license` files. Third-party binary redistribution requires separate compliance review.

## Quick Start (Windows)

Use Windows x64 and [official Node.js 24.22.1](https://nodejs.org/dist/v24.22.1/) with its bundled npm.
The tested version is pinned in .node-version; the supported package engine range is >=24.22.1 and <25.
On GitHub, choose **Code → Download ZIP**, extract the source ZIP and open PowerShell in the folder containing package.json. Git is needed only if you choose to clone.
Internet access is required for dependency installation and the first Electron binary download. No AI account or model is needed for this setup.

```powershell
node --version
npm --version
npm ci
npm run dev
```

For EBADENGINE, install the required Node version and check it in a new terminal. If the Electron download fails, check approved network/proxy access
to npm and GitHub distribution files. Do not disable security checks or substitute untrusted binaries. A fresh installation on a separate clean Windows PC has not been verified.
`npm start` runs a source build, not an installer. No Windows installer is offered.

## Try the Mock demo

Choose Single AI, select Mock AI, enter a fictional reading-club announcement request and press Start Loop.
The five demo steps cover request understanding, planning, drafting, review and final organization. Inspect the step outputs and Final Result.
The final output explicitly identifies itself as a Mock demonstration with no real research, analysis or AI call.
This demonstrates execution flow, not real-model quality improvement. No promotional video or real-model demo recording is included. The current UI is primarily Korean; select **단일 AI** for Single AI.

## Verification

```powershell
npm test
npm run typecheck
npm run build
npm run test:desktop
```

Desktop tests run in the background with isolated profiles. Default tests use fake providers and fictional data.
Internal evaluations, actual model output, history and their dedicated tests are excluded. The test count differs from the private repository.
Relevant CLI-event and writing-constraint regressions use explicitly synthetic data.

## Current scope

These features are implemented; this is not a guarantee of compatibility with every service version or of model answer quality.

Single AI; API-based Auto; selected draft/review/improvement; bounded retry/fallback and parallel execution;
cancellation and failure handling; text/PDF attachments and previews; encrypted local history; Markdown export; optional length diagnostics.
OpenAI-compatible Chat Completions and Claude Messages require the user's API account and key.
Ollama connects to a separately installed local server at 127.0.0.1:11434. General Auto/Fallback restrictions remain unchanged.
Install [official Ollama](https://ollama.com/download/windows) and a suitable model only if using that connection; check model terms, storage and RAM/VRAM requirements.
Ollama and Codex CLI are unnecessary for API-only use.
Codex CLI source is a development-only adapter, disabled by default and in packaged builds.
Models, third-party CLI executables, authentication files and dependency binaries are not bundled.

Free application plans do not imply free API calls or compatibility with every AI subscription.
Connection checks can create real requests. Live-generation npm shortcuts are omitted; some developer smoke scripts retain explicit live options,
which default tests do not use. Collaboration does not guarantee correctness or improved quality.
Scanned/OCR and encrypted PDFs are unsupported. Binary redistribution is a separate approval and compliance process.

## Connect your AI

Open **Connections** after trying the Mock demo:

- **OpenAI-compatible API:** choose **연결 설정** (connection settings), enter your server base URL, supported model ID and your own API key, then save. The adapter uses Chat Completions, not every vendor-specific endpoint.
- **Claude API:** choose connection settings, enter a supported model ID and your own Anthropic API key, then save.
- **Ollama:** separately install Ollama and a model whose terms you accept, disable its cloud features with `OLLAMA_NO_CLOUD=1`, and run its local server at `127.0.0.1:11434`. In Connections, refresh, select an installed model and save the selection. This preview supports local text-only Single AI; general Auto/Fallback participation remains disabled.

Return to Single AI, select the configured provider and submit your request. API connection-check buttons send a real request and may incur charges; Ollama refresh only reads server/model metadata. Do not paste keys into GitHub issues, source files or screenshots.
Saved API keys are protected through Electron's main-process storage. A ChatGPT or Claude consumer subscription does not automatically provide API access.

## Plans and verification

The prepared source passed 1,091 deterministic tests, Typecheck and Build; Mock Desktop execution was checked in development and production modes.
These checks do not certify real-model accuracy. The next product design topic is deterministic sales/inventory number diagnostics.
Official OAuth, additional CLI adapters and automatic model-role enablement remain future considerations.
Installers, automatic updates, user accounts, billing and Team features are not advertised as current functionality.

## Privacy and contribution

Provider execution and protected storage use the Electron main process. Attachments may be sent to the selected provider;
quoted content may remain in saved or exported results. Do not disclose keys or personal records in issues.
See [third-party notices](THIRD_PARTY_NOTICES.md), [contribution guide](CONTRIBUTING.md) and [security reporting status](SECURITY.md).
Use the private reporting route in SECURITY.md for vulnerabilities; never post sensitive details in public issues.
This application is not officially affiliated with or endorsed by the AI providers.

Consider starring the project if it is useful, or sharing a reproducible example with fictional data.
No invented usage metrics or improvement claims are presented, and Stars are not a condition of use.

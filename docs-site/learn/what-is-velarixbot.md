# What is VelarixBot?

VelarixBot is a desktop app that presents AI agents as a team you message. Each bot in the sidebar has its own name, personality, engine and model, memory, permissions, and — optionally — its own computer. You talk to them like teammates: one-on-one threads, A⇄B sidebar DMs, and routines that run on a schedule.

Everything is local-first. Transcripts, keys, routines, and memory live in `~/.velarixbot` on your machine. The app collects no analytics, telemetry, account, name, or email. There is no cloud scheduler and no proxy between you and your model providers: bots run on the `claude`, `codex`, `grok`, and `gemini` CLIs already installed and signed in on your machine, or on API keys you paste (OpenRouter and compatible providers).

## The shape of the app

An Electron client talks to a small local harness server bound to `127.0.0.1:8799`. The harness owns the SQLite store, spawns engine CLI sessions per thread, brokers permissions, runs routines, and streams events back over SSE. Since v0.2 the harness can also run as a background service (a macOS LaunchAgent or a per-user Windows service), so routines and long tasks continue while the app window is closed.

## What bots can do

Bots answer in chat, run tools behind a permission broker, drive a real computer (a cloud Linux desktop you watch, or the local machine), connect to 500+ apps through Composio, message and delegate to each other, learn taught skills from demonstrations, and remember durable facts and preferences per bot.

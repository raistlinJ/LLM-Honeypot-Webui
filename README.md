# 🍯 LLM-Honeypot-Webui

**AI-Powered SSH Honeypot Management System**  
**Author: Jaime Acosta**

A complete SSH/Telnet honeypot solution using [Cowrie](https://github.com/cowrie/cowrie) with LLM-powered response generation, managed through a premium web dashboard.

## Features

- **AI-Powered Responses**: Use OpenAI (GPT-4o, GPT-4o-mini) or Ollama (Llama 3, Mistral, etc.) to generate realistic shell responses
- **Web Dashboard**: Real-time monitoring, statistics, and log viewer
- **Easy Management**: Start/stop/restart the honeypot from the WebUI
- **Session Tracking**: View individual attacker sessions and their commands
- **Flexible Config**: Configure everything from the UI — backend mode, SSH version strings, credentials, and LLM parameters
- **Dockerized**: Single `docker-compose up` to get everything running

## Architecture

```
┌─────────────────────────────────────────┐
│            Docker Compose               │
│                                         │
│  ┌──────────┐  ┌──────┐  ┌──────────┐ │
│  │  Cowrie   │  │ Flask │  │  Nginx   │ │
│  │ Honeypot  │←→│  API  │←→│  WebUI   │ │
│  │  :2222    │  │ :5000 │  │  :8080   │ │
│  └──────────┘  └──────┘  └──────────┘ │
│       ↕                                 │
│  ┌──────────┐                          │
│  │  OpenAI / │                          │
│  │  Ollama   │                          │
│  └──────────┘                          │
└─────────────────────────────────────────┘
```

## Quick Start

1. **Clone and configure:**
   ```bash
   git clone <your-repo-url>
   cd LLM-Honeypot-Webui
   cp .env.example .env
   # Edit .env with your settings (API keys, ports, etc.)
   ```

2. **Start everything:**
   ```bash
   docker-compose up -d --build
   ```

   Cowrie runtime state and JSON logs are persisted in Docker volumes (`cowrie-state` and `cowrie-logs`) so the stack does not depend on host file permissions.

3. **Open the dashboard:**
   ```
   http://localhost:8080
   ```

4. **Test the honeypot:**
   ```bash
   ssh root@localhost -p 2222
   ```

## Configuration

### Environment Variables (`.env`)

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `openai` | LLM provider: `openai` or `ollama` |
| `OPENAI_API_KEY` | — | Your OpenAI API key |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model to use |
| `OLLAMA_HOST` | `http://ollama:11434` | Ollama endpoint URL |
| `OLLAMA_MODEL` | `llama3` | Ollama model name |
| `LLM_TEMPERATURE` | `0.7` | Response randomness (0.0-2.0) |
| `COWRIE_SSH_PORT` | `2222` | Host port for SSH honeypot |
| `COWRIE_TELNET_PORT` | `2223` | Host port for Telnet honeypot |
| `WEBUI_PORT` | `8080` | Host port for web dashboard |

### Using Ollama (Local LLM)

To use a local LLM instead of OpenAI:

1. Uncomment the `ollama` service in `docker-compose.yml`
2. Start the stack: `docker-compose up -d --build`
3. Pull a model: `docker exec llm-honey-ollama ollama pull llama3`
4. In the WebUI, go to **LLM Settings** → select **Ollama** → set model to `llama3`
5. In **Configuration**, set backend to **LLM** and save

## Ports

| Service | Port | Protocol |
|---------|------|----------|
| SSH Honeypot | 2222 | SSH |
| Telnet Honeypot | 2223 | Telnet |
| Web Dashboard | 8080 | HTTP |

## License

GPL-3.0

"""
LLM-Honeypot-Webui
@author Jaime Acosta
Flask backend for managing the Cowrie SSH honeypot.
"""

import configparser
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import docker
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# Paths
COWRIE_CONFIG_PATH = os.environ.get("COWRIE_CONFIG_PATH", "/cowrie-etc/cowrie.cfg")
COWRIE_LOG_PATH = os.environ.get("COWRIE_LOG_PATH", "/cowrie-logs/cowrie.json")
COWRIE_CONTAINER_NAME = os.environ.get("COWRIE_CONTAINER_NAME", "llm-honeypot-cowrie")
SETTINGS_PATH = os.environ.get("SETTINGS_PATH", "/app/data/settings.json")

# Default settings
DEFAULT_SETTINGS = {
    "llm_provider": "openai",
    "openai_api_key": "",
    "openai_host": "https://api.openai.com",
    "openai_host_history": ["https://api.openai.com"],
    "openai_model": "gpt-4o-mini",
    "ollama_host": "http://host.docker.internal:11434",
    "ollama_host_history": ["http://host.docker.internal:11434", "http://ollama:11434"],
    "ollama_model": "llama3",
    "llm_temperature": 0.7,
    "llm_max_tokens": 500,
    "cowrie_backend": "shell",
    "cowrie_hostname": "svr04",
    "ssh_enabled": True,
    "ssh_version": "SSH-2.0-OpenSSH_6.0p1 Debian-4+deb7u2",
    "telnet_enabled": True,
    "ssh_port": 2222,
    "telnet_port": 2223,
    "llm_debug": False,
}


def get_docker_client():
    """Get Docker client, trying socket first then environment."""
    try:
        return docker.DockerClient(base_url="unix:///var/run/docker.sock")
    except Exception:
        return docker.from_env()


def get_cowrie_container():
    """Get the Cowrie container object."""
    client = get_docker_client()
    try:
        return client.containers.get(COWRIE_CONTAINER_NAME)
    except docker.errors.NotFound:
        # Try alternative names
        for container in client.containers.list(all=True):
            if "cowrie" in container.name.lower():
                return container
        return None
    except Exception:
        return None


def load_settings():
    """Load application settings from JSON file."""
    os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
    if os.path.exists(SETTINGS_PATH):
        try:
            with open(SETTINGS_PATH, "r") as f:
                saved = json.load(f)
                settings = DEFAULT_SETTINGS.copy()
                settings.update(saved)
                return settings
        except (json.JSONDecodeError, IOError):
            pass
    return DEFAULT_SETTINGS.copy()


def save_settings(settings):
    """Save application settings to JSON file."""
    os.makedirs(os.path.dirname(SETTINGS_PATH), exist_ok=True)
    with open(SETTINGS_PATH, "w") as f:
        json.dump(settings, f, indent=2)


def read_cowrie_config():
    """Read and parse cowrie.cfg into a dictionary."""
    config = configparser.ConfigParser()
    if os.path.exists(COWRIE_CONFIG_PATH):
        config.read(COWRIE_CONFIG_PATH)
    result = {}
    for section in config.sections():
        result[section] = dict(config[section])
    return result


def write_cowrie_config(settings):
    """Write settings back to cowrie.cfg."""
    config = configparser.ConfigParser()

    # Read existing config to preserve unmanaged sections
    if os.path.exists(COWRIE_CONFIG_PATH):
        config.read(COWRIE_CONFIG_PATH)

    # Apply honeypot settings
    if not config.has_section("honeypot"):
        config.add_section("honeypot")
    config.set("honeypot", "hostname", settings.get("cowrie_hostname", "svr04"))
    config.set("honeypot", "backend", settings.get("cowrie_backend", "shell"))
    config.set("honeypot", "log_path", "var/log/cowrie")
    config.set("honeypot", "download_path", "${honeypot:state_path}/downloads")
    config.set("honeypot", "share_path", "share/cowrie")
    config.set("honeypot", "state_path", "var/lib/cowrie")
    config.set("honeypot", "etc_path", "etc")
    config.set("honeypot", "contents_path", "honeyfs")
    config.set("honeypot", "txtcmds_path", "txtcmds")
    config.set("honeypot", "sensor_name", "honeypot-01")

    # Apply SSH settings
    if not config.has_section("ssh"):
        config.add_section("ssh")
    config.set("ssh", "enabled", str(settings.get("ssh_enabled", True)).lower())
    config.set(
        "ssh",
        "version",
        settings.get("ssh_version", "SSH-2.0-OpenSSH_6.0p1 Debian-4+deb7u2"),
    )
    config.set("ssh", "listen_endpoints", "tcp:2222:interface=0.0.0.0")

    # Apply Telnet settings
    if not config.has_section("telnet"):
        config.add_section("telnet")
    config.set("telnet", "enabled", str(settings.get("telnet_enabled", True)).lower())
    config.set("telnet", "listen_endpoints", "tcp:2223:interface=0.0.0.0")

    # Apply LLM settings
    if not config.has_section("llm"):
        config.add_section("llm")

    provider = settings.get("llm_provider", "openai")
    if provider == "openai":
        config.set("llm", "api_key", settings.get("openai_api_key", ""))
        config.set("llm", "model", settings.get("openai_model", "gpt-4o-mini"))
        config.set("llm", "host", settings.get("openai_host", "https://api.openai.com"))
    else:
        config.set("llm", "api_key", "")
        config.set("llm", "model", settings.get("ollama_model", "llama3"))
        config.set(
            "llm", "host", settings.get("ollama_host", "http://ollama:11434")
        )

    config.set("llm", "path", "/v1/chat/completions")
    config.set("llm", "temperature", str(settings.get("llm_temperature", 0.7)))
    config.set("llm", "max_tokens", str(settings.get("llm_max_tokens", 500)))
    config.set(
        "llm", "debug", str(settings.get("llm_debug", False)).lower()
    )

    # Ensure JSON logging is enabled
    if not config.has_section("output_jsonlog"):
        config.add_section("output_jsonlog")
    config.set("output_jsonlog", "enabled", "true")
    config.set("output_jsonlog", "logfile", "var/log/cowrie/cowrie.json")
    config.set("output_jsonlog", "epoch_timestamp", "false")

    with open(COWRIE_CONFIG_PATH, "w") as f:
        config.write(f)


def parse_log_lines(max_lines=500, search=None, event_filter=None):
    """Parse the Cowrie JSON log file and return structured entries."""
    entries = []
    if not os.path.exists(COWRIE_LOG_PATH):
        return entries

    try:
        with open(COWRIE_LOG_PATH, "r") as f:
            lines = f.readlines()

        # Process from latest first
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue

            # Apply event type filter
            event_id = entry.get("eventid", "")
            if event_filter:
                if event_filter == "cowrie.llm":
                    if not event_id.startswith("cowrie.llm"):
                        continue
                elif event_id != event_filter:
                    continue

            # Apply search filter
            if search:
                search_lower = search.lower()
                searchable = json.dumps(entry).lower()
                if search_lower not in searchable:
                    continue

            entries.append(entry)
            if len(entries) >= max_lines:
                break
    except IOError:
        pass

    return entries


def get_log_stats():
    """Calculate aggregated statistics from logs."""
    stats = {
        "total_events": 0,
        "login_attempts": 0,
        "successful_logins": 0,
        "commands_entered": 0,
        "unique_ips": set(),
        "top_usernames": {},
        "top_passwords": {},
        "top_ips": {},
        "top_commands": {},
        "events_by_hour": {},
        "recent_sessions": [],
    }

    if not os.path.exists(COWRIE_LOG_PATH):
        return _serialize_stats(stats)

    try:
        with open(COWRIE_LOG_PATH, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                stats["total_events"] += 1
                event_id = entry.get("eventid", "")
                src_ip = entry.get("src_ip", "unknown")

                stats["unique_ips"].add(src_ip)

                # Count by IP
                stats["top_ips"][src_ip] = stats["top_ips"].get(src_ip, 0) + 1

                # Login attempts
                if event_id in (
                    "cowrie.login.success",
                    "cowrie.login.failed",
                ):
                    stats["login_attempts"] += 1
                    username = entry.get("username", "")
                    password = entry.get("password", "")
                    if username:
                        stats["top_usernames"][username] = (
                            stats["top_usernames"].get(username, 0) + 1
                        )
                    if password:
                        stats["top_passwords"][password] = (
                            stats["top_passwords"].get(password, 0) + 1
                        )

                if event_id == "cowrie.login.success":
                    stats["successful_logins"] += 1

                # Commands
                if event_id == "cowrie.command.input":
                    stats["commands_entered"] += 1
                    cmd_input = entry.get("input", "")
                    if cmd_input:
                        stats["top_commands"][cmd_input] = (
                            stats["top_commands"].get(cmd_input, 0) + 1
                        )

                # Events by hour
                timestamp = entry.get("timestamp", "")
                if timestamp:
                    try:
                        hour = timestamp[:13]  # YYYY-MM-DDTHH
                        stats["events_by_hour"][hour] = (
                            stats["events_by_hour"].get(hour, 0) + 1
                        )
                    except (IndexError, ValueError):
                        pass

    except IOError:
        pass

    return _serialize_stats(stats)


def _serialize_stats(stats):
    """Convert stats to JSON-serializable format with sorted top-N lists."""

    def top_n(d, n=10):
        return sorted(d.items(), key=lambda x: x[1], reverse=True)[:n]

    return {
        "total_events": stats["total_events"],
        "login_attempts": stats["login_attempts"],
        "successful_logins": stats["successful_logins"],
        "commands_entered": stats["commands_entered"],
        "unique_ips": len(stats["unique_ips"]),
        "top_usernames": top_n(stats["top_usernames"]),
        "top_passwords": top_n(stats["top_passwords"]),
        "top_ips": top_n(stats["top_ips"]),
        "top_commands": top_n(stats["top_commands"]),
        "events_by_hour": dict(
            sorted(stats["events_by_hour"].items())[-48:]
        ),  # Last 48 hours
    }


# ===== API ROUTES =====


@app.route("/api/status", methods=["GET"])
def get_status():
    """Get Cowrie container status and basic info."""
    container = get_cowrie_container()
    if container is None:
        return jsonify(
            {
                "status": "not_found",
                "message": "Cowrie container not found",
                "uptime": None,
                "container_name": COWRIE_CONTAINER_NAME,
            }
        )

    container.reload()
    state = container.attrs.get("State", {})
    status = state.get("Status", "unknown")

    # Calculate uptime
    uptime = None
    if status == "running":
        started_at = state.get("StartedAt", "")
        if started_at:
            try:
                start_time = datetime.fromisoformat(
                    started_at.replace("Z", "+00:00")
                )
                uptime_seconds = (
                    datetime.now(timezone.utc) - start_time
                ).total_seconds()
                uptime = int(uptime_seconds)
            except (ValueError, TypeError):
                uptime = None

    return jsonify(
        {
            "status": status,
            "container_name": container.name,
            "container_id": container.short_id,
            "uptime": uptime,
            "image": container.image.tags[0] if container.image.tags else "unknown",
        }
    )


@app.route("/api/start", methods=["POST"])
def start_honeypot():
    """Start the Cowrie container."""
    container = get_cowrie_container()
    if container is None:
        return jsonify({"error": "Cowrie container not found"}), 404

    try:
        container.reload()
        if container.status == "running":
            return jsonify({"message": "Cowrie is already running", "status": "running"})
        container.start()
        time.sleep(2)
        container.reload()
        return jsonify(
            {"message": "Cowrie started successfully", "status": container.status}
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/stop", methods=["POST"])
def stop_honeypot():
    """Stop the Cowrie container."""
    container = get_cowrie_container()
    if container is None:
        return jsonify({"error": "Cowrie container not found"}), 404

    try:
        container.reload()
        if container.status != "running":
            return jsonify(
                {"message": "Cowrie is already stopped", "status": container.status}
            )
        container.stop(timeout=10)
        time.sleep(2)
        container.reload()
        return jsonify(
            {"message": "Cowrie stopped successfully", "status": container.status}
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/restart", methods=["POST"])
def restart_honeypot():
    """Restart the Cowrie container."""
    container = get_cowrie_container()
    if container is None:
        return jsonify({"error": "Cowrie container not found"}), 404

    try:
        container.restart(timeout=10)
        time.sleep(3)
        container.reload()
        return jsonify(
            {"message": "Cowrie restarted successfully", "status": container.status}
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/config", methods=["GET"])
def get_config():
    """Get current Cowrie configuration."""
    try:
        config = read_cowrie_config()
        return jsonify(config)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/config", methods=["PUT"])
def update_config():
    """Update Cowrie configuration and optionally restart."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "No data provided"}), 400

        settings = load_settings()
        old_ssh_port = settings.get("ssh_port", 2222)
        old_telnet_port = settings.get("telnet_port", 2223)
        
        settings.update(data)
        
        new_ssh_port = settings.get("ssh_port", 2222)
        new_telnet_port = settings.get("telnet_port", 2223)
        
        # Check if ports are available if changed
        if new_ssh_port != old_ssh_port:
            if is_port_in_use(new_ssh_port):
                return jsonify({"error": f"SSH Port {new_ssh_port} is already in use by another container"}), 400
        if new_telnet_port != old_telnet_port:
            if is_port_in_use(new_telnet_port):
                return jsonify({"error": f"Telnet Port {new_telnet_port} is already in use by another container"}), 400

        save_settings(settings)
        write_cowrie_config(settings)
        
        # Determine if recreation or simple restart is needed
        ports_changed = (new_ssh_port != old_ssh_port) or (new_telnet_port != old_telnet_port)
        
        if data.get("auto_restart", False):
            if ports_changed:
                success, msg = recreate_cowrie_container(settings)
                if not success:
                    return jsonify({"error": f"Failed to recreate container: {msg}"}), 500
            else:
                container = get_cowrie_container()
                if container and container.status == "running":
                    container.restart(timeout=10)
        
        return jsonify({"message": "Configuration updated successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/logs", methods=["GET"])
def get_logs():
    """Get honeypot log entries with optional filtering."""
    max_lines = request.args.get("limit", 200, type=int)
    search = request.args.get("search", None)
    event_filter = request.args.get("event", None)

    entries = parse_log_lines(
        max_lines=min(max_lines, 1000), search=search, event_filter=event_filter
    )

    return jsonify({"entries": entries, "count": len(entries)})


@app.route("/api/logs/stats", methods=["GET"])
def get_stats():
    """Get aggregated log statistics."""
    try:
        stats = get_log_stats()
        return jsonify(stats)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/logs/sessions", methods=["GET"])
def get_sessions():
    """Get unique attack sessions."""
    sessions = {}

    if not os.path.exists(COWRIE_LOG_PATH):
        return jsonify({"sessions": []})

    try:
        with open(COWRIE_LOG_PATH, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                session_id = entry.get("session", "")
                if not session_id:
                    continue

                if session_id not in sessions:
                    sessions[session_id] = {
                        "session_id": session_id,
                        "src_ip": entry.get("src_ip", "unknown"),
                        "start_time": entry.get("timestamp", ""),
                        "end_time": entry.get("timestamp", ""),
                        "events": 0,
                        "commands": [],
                        "username": "",
                        "protocol": entry.get("protocol", "ssh"),
                    }
                else:
                    sessions[session_id]["end_time"] = entry.get("timestamp", "")

                sessions[session_id]["events"] += 1

                event_id = entry.get("eventid", "")
                if event_id == "cowrie.command.input":
                    cmd = entry.get("input", "")
                    if cmd:
                        sessions[session_id]["commands"].append(cmd)

                if event_id in ("cowrie.login.success", "cowrie.login.failed"):
                    sessions[session_id]["username"] = entry.get("username", "")

    except IOError:
        pass

    # Sort by most recent and return top 100
    sorted_sessions = sorted(
        sessions.values(), key=lambda x: x.get("start_time", ""), reverse=True
    )[:100]

    return jsonify({"sessions": sorted_sessions})


@app.route("/api/settings", methods=["GET"])
def get_settings():
    """Get application settings."""
    settings = load_settings()
    # Mask API key for security
    masked = settings.copy()
    if masked.get("openai_api_key"):
        key = masked["openai_api_key"]
        if len(key) > 8:
            masked["openai_api_key_masked"] = key[:4] + "..." + key[-4:]
        else:
            masked["openai_api_key_masked"] = "***"
    else:
        masked["openai_api_key_masked"] = ""
    return jsonify(masked)


@app.route("/api/settings", methods=["PUT"])
def update_settings():
    """Update application settings and sync to cowrie.cfg."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "No data provided"}), 400

        settings = load_settings()
        settings.update(data)
        save_settings(settings)
        write_cowrie_config(settings)

        return jsonify({"message": "Settings saved successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/llm/models", methods=["GET"])
def fetch_llm_models():
    """Fetch available models from the configured LLM provider."""
    provider = request.args.get("provider", "openai")
    host = request.args.get("host")
    api_key = request.args.get("api_key", "")

    if not host:
        return jsonify({"error": "Host URL is required"}), 400

    import requests

    headers = {}
    if provider == "openai":
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        
        try:
            # OpenAI compatible /v1/models
            url = f"{host.rstrip('/')}/v1/models"
            resp = requests.get(url, headers=headers, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            # Extract model IDs
            models = [m["id"] for m in data.get("data", [])]
            return jsonify({"models": sorted(models)})
        except Exception as e:
            return jsonify({"error": f"Failed to fetch OpenAI models: {str(e)}"}), 500
            
    elif provider == "ollama":
        try:
            # Ollama /api/tags
            url = f"{host.rstrip('/')}/api/tags"
            resp = requests.get(url, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            # Extract model names
            models = [m["name"] for m in data.get("models", [])]
            return jsonify({"models": sorted(models)})
        except Exception as e:
            return jsonify({"error": f"Failed to fetch Ollama models: {str(e)}"}), 500

    return jsonify({"error": "Invalid provider"}), 400


@app.route("/api/health", methods=["GET"])
def health():
    """Health check endpoint."""
    return jsonify({"status": "ok", "timestamp": datetime.now(timezone.utc).isoformat()})

def is_port_in_use(port):
    """Check if any other container is using the specified port on the host."""
    client = get_docker_client()
    try:
        containers = client.containers.list(all=True)
        for container in containers:
            if container.name == COWRIE_CONTAINER_NAME:
                continue
            
            ports = container.attrs.get('HostConfig', {}).get('PortBindings', {})
            for p_binding in ports.values():
                if p_binding:
                    for b in p_binding:
                        if b.get('HostPort') == str(port):
                            return True
    except Exception:
        pass
    return False

def recreate_cowrie_container(settings):
    """Recreate the Cowrie container with updated port mappings."""
    client = get_docker_client()
    try:
        old_container = get_cowrie_container()
        if not old_container:
            return False, "Container not found"
        
        # Store original config
        image = old_container.attrs['Config']['Image']
        name = old_container.name
        
        # Prepare new port bindings
        ssh_port = settings.get("ssh_port", 2222)
        telnet_port = settings.get("telnet_port", 2223)
        
        port_bindings = {
            '2222/tcp': ssh_port,
            '2223/tcp': telnet_port
        }
        
        # Stop and remove
        old_container.stop(timeout=10)
        old_container.remove()
        
        # Re-create with same volumes and networks from the docker-compose context
        # Note: We rely on the fact that the initial container was created by compose
        # with these specific volumes.
        volumes = {
            os.path.abspath("./cowrie/etc"): {'bind': '/cowrie/cowrie-git/etc', 'mode': 'rw'},
            # Other volumes are usually managed by compose, we might need to be careful here
            # But since we are inside a compose setup, we'll try to find the project volumes
        }
        
        # For simplicity and robustness during this specific task, we will try to use
        # a safer approach: identify the volumes from the original container.
        orig_volumes = old_container.attrs.get('HostConfig', {}).get('Binds', [])
        
        # Create new one
        new_container = client.containers.run(
            image,
            name=name,
            detach=True,
            ports=port_bindings,
            volumes=orig_volumes,
            restart_policy={"Name": "unless-stopped"},
            network="llm-honey_honeypot-net" # Use the projected name from compose
        )
        
        return True, "Recreated"
    except Exception as e:
        return False, str(e)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)

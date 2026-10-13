#!/usr/bin/env python3
"""Run an isolated Synapse + fake-backend acceptance test. No real WeChat traffic."""
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
SYNAPSE = os.environ.get("MATRIX_WECHAT_TEST_SYNAPSE", "matrixdotorg/synapse:v1.162.0")


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def request(base, method, path, body=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=10) as response:
        payload = response.read()
        return json.loads(payload) if payload else {}


def wait_for(check, description, timeout=90):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        try:
            value = check()
            if value:
                return value
        except (OSError, ValueError, sqlite3.Error):
            pass
        time.sleep(0.3)
    raise AssertionError("Timed out: " + description)


def room_events(base, token, room):
    return request(base, "GET", "/_matrix/client/v3/rooms/" + urllib.parse.quote(room, safe="") +
                   "/messages?dir=b&limit=100", token=token)["chunk"]


def main():
    binary = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "build/matrix-wechat").resolve()
    name = "matrix-wechat-smoke-" + uuid.uuid4().hex[:10]
    hs_port, as_port = port(), port()
    base = "http://127.0.0.1:" + str(hs_port)
    process = None
    with tempfile.TemporaryDirectory(prefix="matrix-wechat-smoke-") as tmp:
        data = Path(tmp)
        # Synapse uses UID 991; this directory holds only disposable test data.
        os.chmod(data, 0o777)
        config_path, registration = data / "config.yaml", data / "registration.yaml"
        log = open(data / "bridge.log", "w+")
        try:
            run(str(binary), "-e", "-c", str(config_path), stdout=subprocess.DEVNULL)
            # JSON is valid YAML, avoiding an extra Python YAML dependency.
            config = {
                "network": {"backend": "fake", "fake_fixtures": [str(ROOT / "fixtures/demo.json")],
                            "max_media_size": 52428800},
                "homeserver": {"address": base, "domain": "matrix.test"},
                "appservice": {"address": "http://host.docker.internal:" + str(as_port),
                               "hostname": "0.0.0.0", "port": as_port, "id": "wechat",
                               "bot": {"username": "wechatbot", "displayname": "WeChat bridge bot", "avatar": ""},
                               "username_template": "wechat_{{.}}"},
                "database": {"type": "sqlite3-fk-wal", "uri": "file:" + str(data / "bridge.db") +
                             "?_txlock=immediate", "max_open_conns": 1},
                "bridge": {"permissions": {"@tester:matrix.test": "admin"}, "split_portals": True},
                "encryption": {"allow": True, "default": True,
                               "verification_levels": {"receive": "unverified", "send": "unverified",
                                                       "share": "unverified"}},
            }
            # Feed these values through the framework upgrader to get its defaults.
            config_path.write_text(json.dumps(config))
            run(str(binary), "-g", "-c", str(config_path), "-r", str(registration),
                stdout=subprocess.DEVNULL)
            os.chmod(registration, 0o644)
            synapse = {
                "server_name": "matrix.test", "report_stats": False,
                "public_baseurl": base, "pid_file": "/data/homeserver.pid",
                "listeners": [{"port": 8008, "type": "http", "tls": False,
                               "resources": [{"names": ["client"], "compress": False}]}],
                "database": {"name": "sqlite3", "args": {"database": "/data/homeserver.db"}},
                "media_store_path": "/data/media_store",
                "signing_key_path": "/data/matrix.test.signing.key",
                "trusted_key_servers": [],
                "app_service_config_files": ["/data/registration.yaml"],
                "enable_registration": True, "enable_registration_without_verification": True,
                "rc_registration": {"per_second": 10, "burst_count": 100},
                "rc_message": {"per_second": 100, "burst_count": 1000},
                "rc_joins": {"local": {"per_second": 100, "burst_count": 1000},
                             "remote": {"per_second": 100, "burst_count": 1000}},
                "rc_joins_per_room": {"per_second": 100, "burst_count": 1000},
            }
            (data / "homeserver.yaml").write_text(json.dumps(synapse))
            os.chmod(data / "homeserver.yaml", 0o644)
            run("docker", "run", "-d", "--name", name, "--add-host", "host.docker.internal:host-gateway",
                "--user", f"{os.getuid()}:{os.getgid()}",
                "-p", f"127.0.0.1:{hs_port}:8008", "-v", str(data) + ":/data:z", SYNAPSE,
                stdout=subprocess.DEVNULL)
            wait_for(lambda: request(base, "GET", "/_matrix/client/versions"), "Synapse startup")
            user = request(base, "POST", "/_matrix/client/v3/register",
                           {"username": "tester", "password": "disposable-test-password",
                            "auth": {"type": "m.login.dummy"}})
            token = user["access_token"]
            (data / "client.json").write_text(json.dumps(user))
            env = os.environ | {"MATRIX_WECHAT_TEST_HOMESERVER": base,
                                "MATRIX_WECHAT_TEST_STATE": str(data)}
            run("go", "test", "-tags", "goolm", "./integration", "-run", "^TestMatrixSetup$", "-count=1", env=env, cwd=ROOT)
            process = subprocess.Popen([str(binary), "-c", str(config_path)], stdout=log, stderr=log)
            wait_for(lambda: request(base, "GET", "/_matrix/client/v3/profile/@wechatbot:matrix.test"),
                     "bot registration")
            management = request(base, "POST", "/_matrix/client/v3/createRoom",
                                 {"preset": "private_chat", "invite": ["@wechatbot:matrix.test"],
                                  "is_direct": True}, token)["room_id"]

            def send(text):
                return request(base, "PUT", "/_matrix/client/v3/rooms/" +
                               urllib.parse.quote(management, safe="") + "/send/m.room.message/" +
                               uuid.uuid4().hex, {"msgtype": "m.text", "body": text}, token)

            wait_for(lambda: request(base, "GET", "/_matrix/client/v3/rooms/" +
                                     urllib.parse.quote(management, safe="") +
                                     "/state/m.room.member/%40wechatbot%3Amatrix.test", token=token).get("membership") == "join",
                     "bot joined management room")
            send("!wechat login")
            wait_for(lambda: any("account reference" in evt.get("content", {}).get("body", "").lower()
                                for evt in room_events(base, token, management)), "account login prompt")
            send("demo")
            wait_for(lambda: any("Account connected" in evt.get("content", {}).get("body", "")
                                for evt in room_events(base, token, management)), "fixture login")

            def checkpoint():
                with sqlite3.connect(data / "bridge.db") as db:
                    row = db.execute("SELECT metadata FROM user_login WHERE id='demo'").fetchone()
                    return row and json.loads(row[0]).get("cursor") == "6"

            wait_for(checkpoint, "all fake events committed")
            with sqlite3.connect(data / "bridge.db") as db:
                rows = db.execute("SELECT id,mxid FROM portal WHERE mxid IS NOT NULL").fetchall()
                assert len(rows) == 2, rows
                assert db.execute("SELECT COUNT(*) FROM message").fetchone()[0] == 6
            for _, room in rows:
                request(base, "POST", "/_matrix/client/v3/join/" + urllib.parse.quote(room, safe=""), {}, token)
                events = room_events(base, token, room)
                assert any(e["type"] == "m.room.encrypted" for e in events), "unencrypted portal message"
            # A crypto-enabled Matrix test client decrypts rich content, checks
            # authenticated attachments, and sends an encrypted reply.
            env = os.environ | {"MATRIX_WECHAT_TEST_HOMESERVER": base,
                                "MATRIX_WECHAT_TEST_STATE": str(data)}
            run("go", "test", "-tags", "goolm", "./integration", "-run", "^TestMatrix$", "-count=1", env=env, cwd=ROOT)
            process.terminate()
            process.wait(timeout=15)
            process = subprocess.Popen([str(binary), "-c", str(config_path)], stdout=log, stderr=log)
            wait_for(checkpoint, "checkpoint restored")
            time.sleep(2)
            with sqlite3.connect(data / "bridge.db") as db:
                assert db.execute("SELECT COUNT(*) FROM message WHERE sender_id != 'wx_demo'").fetchone()[0] == 6
            print("Matrix acceptance passed: encrypted DM/group events, rich cards, media, outgoing messages, restart.")
        except Exception:
            log.flush()
            output = (data / "bridge.log").read_text()
            focused = [line for line in output.splitlines() if " WRN " in line or " ERR " in line or
                       " INF " in line or "command" in line.lower()]
            print("\n".join(focused[-60:]), file=sys.stderr)
            if "management" in locals() and "token" in locals():
                for evt in room_events(base, token, management):
                    if evt.get("type") == "m.room.message":
                        print("Management message:", evt.get("content", {}).get("body", ""), file=sys.stderr)
            subprocess.run(["docker", "logs", "--tail", "10", name], check=False)
            raise
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            log.close()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Local WeChat instrumentation service. Run with uv run --project helper."""
import argparse
import base64
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import queue
import re
import signal
import socket
import struct
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import frida
from PIL import Image
import zxingcpp
from storage import Storage, StorageError

HERE = Path(__file__).resolve().parent
LOG = logging.getLogger("wechatlinux")
MAX_FRAME = 8 * 1024 * 1024


class HelperError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def private_write(path, data):
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(data)
    os.replace(tmp, path)


def convert_blobs(value):
    if isinstance(value, dict):
        if set(value) == {"bytes"}:
            return {"base64": base64.b64encode(bytes(value["bytes"])).decode("ascii")}
        return {key: convert_blobs(item) for key, item in value.items()}
    if isinstance(value, list):
        return [convert_blobs(item) for item in value]
    return value


class NativeBridge:
    def __init__(self, service):
        self.service = service

    def databases(self):
        return [d for d in self.service.native_call("databases") if d["readable"]]

    def query(self, database_id, sql, max_rows=1000):
        return convert_blobs(self.service.native_call("query", database_id, sql, max_rows))


class Service:
    def __init__(self, options):
        self.options = options
        self.data = Path(options.data_dir).expanduser().resolve()
        self.data.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.profile = json.loads((HERE / "storage_profile.json").read_text())
        self.expected_hash = self.profile["artifact"]["sha256"]
        self.stop = threading.Event()
        self.hints = threading.Event()
        self.native_lock = threading.RLock()
        self.clients = set()
        self.clients_lock = threading.Lock()
        self.qr_lock = threading.Lock()
        self.qr_png = None
        self.qr_text = None
        self.qr_updated = 0
        self.verified = set()
        self.native_errors = []
        self.xvfb = None
        self.session = None
        self.script = None
        self.owned = not bool(options.attach)
        self.pid = options.attach or 0
        self.alive = False
        self.account_id = ""
        self.server = None
        self.http = None
        self.store = Storage(NativeBridge(self), lambda: self.account_id)

    def executable(self):
        if self.options.attach:
            return Path(os.readlink(f"/proc/{self.pid}/exe"))
        if self.options.extracted_dir:
            root = Path(self.options.extracted_dir).expanduser().resolve()
        else:
            if not self.options.appimage:
                raise HelperError("invalid_argument", "--appimage or --extracted-dir is required")
            image = Path(self.options.appimage).expanduser().resolve()
            image_hash = sha256(image)
            root = self.data / ("app-" + image_hash[:16])
            if not (root / "opt/wechat/wechat").is_file():
                import mmap
                with image.open("rb") as f:
                    with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as data:
                        start = 0
                        while True:
                            start = data.find(b"hsqs", start)
                            if start < 0:
                                raise HelperError("unsupported_build", "No supported SquashFS image found")
                            if start + 32 < len(data) and struct.unpack_from("<H", data, start + 28)[0] == 4:
                                break
                            start += 4
                subprocess.run(["unsquashfs", "-no-progress", "-d", str(root), "-o", str(start), str(image)], check=True, stdout=subprocess.DEVNULL)
        return root / "opt/wechat/wechat"

    def start(self):
        executable = self.executable()
        if sha256(executable) != self.expected_hash:
            raise HelperError("unsupported_build", "The executable does not match the pinned WeChat 4.1.13 build")
        device = frida.get_local_device()
        env = {}
        if self.options.headless and self.owned:
            self.xvfb = subprocess.Popen(["Xvfb", "-displayfd", "1", "-screen", "0", "1280x900x24", "-nolisten", "tcp"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            display = self.xvfb.stdout.readline().strip()
            if not display:
                raise HelperError("launch_failed", "Xvfb did not provide a display")
            env = {"DISPLAY": ":" + display, "QT_QPA_PLATFORM": "xcb"}
        if self.owned:
            self.pid = device.spawn([str(executable)], env=env, stdio="pipe")
        self.session = device.attach(self.pid)
        self.session.on("detached", self.on_detached)
        # An explicitly attached process may already have Frida-owned detours.
        # The full on-disk executable digest is still required in either mode.
        self.profile["allow_existing_hooks"] = False
        source = "const PROFILE=" + json.dumps(self.profile) + ";\n" + (HERE / "instrument.js").read_text()
        self.script = self.session.create_script(source)
        self.script.on("message", self.on_native_message)
        self.script.load()
        self.alive = True
        if self.owned:
            device.resume(self.pid)
        self.device = device
        threading.Thread(target=self.monitor, daemon=True).start()
        self.start_http()
        self.start_socket()

    def native_call(self, name, *args):
        with self.native_lock:
            if not self.alive or not self.script:
                raise HelperError("disconnected", "The instrumented WeChat process is not running")
            try:
                return getattr(self.script.exports_sync, name)(*args)
            except (frida.InvalidOperationError, frida.ProcessNotFoundError) as exc:
                raise HelperError("disconnected", "The instrumented process disconnected") from exc
            except frida.RPCException as exc:
                raise HelperError("native_error", str(exc)) from exc

    def on_native_message(self, message, data):
        if message.get("type") == "send":
            payload = message["payload"]
            if payload.get("type") == "change_hint":
                self.hints.set()
            elif payload.get("type") == "ready":
                LOG.info("Native SQLite %s ready", payload.get("sqlite_version"))
        elif message.get("type") == "error":
            # Log source/stack only: never statement contents or keys.
            detail = str(message.get("description", "Native script failed"))
            self.native_errors.append(detail)
            LOG.error("Instrumentation error: %s", detail)

    def on_detached(self, *args):
        self.alive = False
        self.broadcast({"type": "connection.closed", "data": {"reason": "native_process_detached"}})
        self.hints.set()

    def update_account(self, databases):
        accounts = set()
        for d in databases:
            if not d.get("readable"):
                continue
            match = re.search(r"/xwechat_files/([^/]+)/db_storage/", d["path"])
            if match:
                accounts.add(re.sub(r"_[0-9a-f]{4}$", "", match.group(1)))
        if len(accounts) == 1:
            self.account_id = next(iter(accounts))
        elif len(accounts) != 1:
            self.account_id = ""

    def status(self):
        if not self.alive:
            return {"state": "disconnected", "pid": self.pid, "build_hash": self.expected_hash}
        state = self.native_call("status")
        dbs = self.native_call("databases")
        self.update_account(dbs)
        result = {"state": "logged_in" if self.account_id and not state["login_view_active"] else "awaiting_scan", "pid": self.pid, "build_hash": self.expected_hash,
                  "native": {**state, "meaning": "logged_in means account databases unlocked; remote presence is unverified"}}
        if self.account_id:
            result["account"] = {"id": self.account_id}
        return result

    def refresh_qr(self):
        if self.account_id:
            return None
        scan = self.native_call("scanqr")
        matches = []
        for candidate in scan["candidates"]:
            raw = bytes(candidate["bytes"])
            try:
                codes = zxingcpp.read_barcodes(Image.open(io.BytesIO(raw)))
                for code in codes:
                    from urllib.parse import urlsplit
                    host = (urlsplit(code.text).hostname or "").lower()
                    if host in {"weixin.qq.com", "login.weixin.qq.com", "login.wechat.com"}:
                        matches.append((raw, code.text))
            except (ValueError, OSError):
                continue
        # Ambiguity must not silently serve an old credential.
        unique = {text: raw for raw, text in matches}
        if len(unique) != 1:
            raise HelperError("qr_unavailable", "No unique current WeChat login QR is available; wait for the native client")
        text, raw = next(iter(unique.items()))
        with self.qr_lock:
            self.qr_png, self.qr_text, self.qr_updated = raw, text, time.time()
            private_write(self.data / "login-qr.png", raw)
        self.verified.add(("login.qr", "local"))
        return {"path": str(self.data / "login-qr.png"), "png_base64": base64.b64encode(raw).decode("ascii")}

    def monitor(self):
        last = 0
        while not self.stop.is_set():
            self.hints.wait(2)
            self.hints.clear()
            if not self.alive:
                continue
            try:
                state = self.status()
                if state["state"] == "awaiting_scan":
                    self.refresh_qr()
                else:
                    with self.qr_lock:
                        self.qr_png = None
                    if time.monotonic() - last >= 2:
                        events = self.store.poll()
                        self.verified.add(("database.read", "local"))
                        for event in events:
                            self.broadcast(event)
                            if event.get("message"):
                                self.verified.add(("messages." + event["message"]["kind"], "receive"))
                        last = time.monotonic()
            except (HelperError, StorageError) as exc:
                if exc.code not in {"qr_unavailable", "unverified"}:
                    LOG.debug("Reconciliation pending: %s", exc.code)
            except Exception:
                LOG.exception("Reconciliation failed")

    def capabilities(self):
        result = []
        for name, direction in [("login.qr", "local"), ("login.password", "local"), ("database.read", "local"), ("contacts", "receive"), ("groups", "receive"), ("conversations", "receive")]:
            result.append({"name": name, "direction": direction, "status": "verified" if (name, direction) in self.verified else "unverified"})
        for kind in ["text", "image", "sticker", "video", "audio", "file", "mention", "reply", "location", "redaction"]:
            for direction in ["receive", "send"]:
                name = "messages." + kind
                result.append({"name": name, "direction": direction, "status": "verified" if (name, direction) in self.verified else "unverified", "reason": "Requires authenticated operation and payload validation"})
        for name in ["presence", "group.join", "group.invite", "group.leave", "group.kick", "group.mute", "room.name", "room.avatar", "room.topic", "user.name", "user.avatar"]:
            for direction in ["receive", "send"]:
                result.append({"name": name, "direction": direction, "status": "unverified"})
        for name in ["portals.after_login", "portals.on_join", "portals.on_message", "double_puppeting"]:
            result.append({"name": name, "status": "bridge_required", "reason": "Matrix bridge orchestration consumes backend events and identity"})
        return {"build_hash": self.expected_hash, "capabilities": result}

    def dispatch(self, method, params):
        if method == "status":
            return self.status()
        if method == "capabilities":
            return self.capabilities()
        if method == "login":
            state = self.status()
            if state["state"] == "logged_in":
                return {"state": "logged_in", "account": state["account"]}
            return {"state": "awaiting_scan", "qr": self.refresh_qr(), "native": {"source": "native_png_memory", "refresh": "client_controls_rotation"}}
        if method == "inspect_db":
            raw = self.native_call("databases")
            self.update_account(raw)
            readable = self.store.inspect() if any(d["readable"] for d in raw) else {"databases": []}
            readable["databases"].extend({"path": d["path"], "encrypted": d["encrypted"], "readable": False, "native": {"error": d["error"]}} for d in raw if not d["readable"])
            if raw:
                self.verified.add(("database.read", "local"))
            return readable
        if method in {"contacts", "groups", "conversations"}:
            result = getattr(self.store, method)()
            self.verified.add((method, "receive"))
            return result
        if method == "history":
            return self.store.history(params)
        if method == "media":
            return self.store.media(params)
        if method in {"send", "chat_action", "profile_action"}:
            raise HelperError("unverified", "The requested native mutation has not been validated", {"method": method, "kind": params.get("kind"), "action": params.get("action")})
        raise HelperError("unknown_method", "Unknown helper method: " + method)

    def broadcast(self, event):
        record = {"event": event}
        with self.clients_lock:
            for client in list(self.clients):
                try:
                    client.put_nowait(record)
                except queue.Full:
                    # Close this subscriber rather than silently losing events.
                    try:
                        client.get_nowait()
                        client.put_nowait(None)
                    except queue.Empty:
                        pass

    def start_socket(self):
        path = Path(self.options.socket).expanduser().resolve()
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.exists():
            raise HelperError("socket_in_use", "Socket path exists; stop the previous helper before starting another")
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(path))
        os.chmod(path, 0o600)
        self.server.listen(16)
        self.server.settimeout(1)
        LOG.info("API socket: %s", path)

    def handle_client(self, connection):
        outgoing = queue.Queue(maxsize=256)
        with self.clients_lock:
            self.clients.add(outgoing)
        def writer():
            try:
                while True:
                    item = outgoing.get()
                    if item is None:
                        break
                    data = json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
                    if len(data) > MAX_FRAME:
                        break
                    connection.sendall(data)
            except OSError:
                pass
            finally:
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        threading.Thread(target=writer, daemon=True).start()
        try:
            reader = connection.makefile("rb")
            while not self.stop.is_set():
                data = reader.readline(MAX_FRAME + 1)
                if not data or len(data) > MAX_FRAME or not data.endswith(b"\n"):
                    break
                request = json.loads(data)
                request_id = request.get("id")
                if not isinstance(request_id, str) or not isinstance(request.get("method"), str) or not isinstance(request.get("params", {}), dict):
                    break
                try:
                    response = {"id": request_id, "result": self.dispatch(request["method"], request.get("params", {}))}
                except (HelperError, StorageError) as exc:
                    response = {"id": request_id, "error": {"code": exc.code, "message": exc.message, "details": exc.details}}
                except Exception:
                    LOG.exception("RPC failed")
                    response = {"id": request_id, "error": {"code": "internal_error", "message": "The helper operation failed"}}
                outgoing.put(response, timeout=5)
        except (OSError, ValueError, queue.Full):
            pass
        finally:
            with self.clients_lock:
                self.clients.discard(outgoing)
            try:
                outgoing.put_nowait(None)
            except queue.Full:
                pass
            connection.close()

    def start_http(self):
        if not self.options.qr_port:
            return
        service = self
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/":
                    data = b'<!doctype html><meta charset="utf-8"><title>WeChat demo login</title><body style="font:20px system-ui;text-align:center;padding:32px"><h1>WeChat demo login</h1><p id="state">Scan and confirm on your phone.</p><img id="qr" style="width:370px;image-rendering:pixelated"><script>async function refresh(){let r=await fetch("/state");let s=await r.json();document.getElementById("state").textContent=s.state==="logged_in"?"Login confirmed":"Scan and confirm on your phone";document.getElementById("qr").style.display=s.state==="logged_in"?"none":"inline";document.getElementById("qr").src="/qr.png?t="+Date.now()}refresh();setInterval(refresh,3000)</script>'
                    content_type = "text/html; charset=utf-8"
                elif self.path == "/state":
                    data = json.dumps({"state": "logged_in" if service.account_id else "awaiting_scan"}).encode()
                    content_type = "application/json"
                elif self.path.startswith("/qr.png"):
                    with service.qr_lock:
                        data = service.qr_png
                    if not data or time.time() - service.qr_updated > 8:
                        self.send_error(503, "Current QR is not available")
                        return
                    content_type = "image/png"
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            def log_message(self, *args):
                pass
        self.http = ThreadingHTTPServer(("127.0.0.1", self.options.qr_port), Handler)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        LOG.info("QR page: http://127.0.0.1:%d/", self.options.qr_port)

    def run(self):
        while not self.stop.is_set():
            try:
                client, _ = self.server.accept()
                if hasattr(socket, "SO_PEERCRED"):
                    pid, uid, gid = struct.unpack("3i", client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                    if uid != os.getuid():
                        client.close()
                        continue
                threading.Thread(target=self.handle_client, args=(client,), daemon=True).start()
            except socket.timeout:
                continue

    def close(self):
        self.stop.set()
        self.hints.set()
        if self.server:
            self.server.close()
            try:
                Path(self.options.socket).unlink()
            except FileNotFoundError:
                pass
        if self.http:
            self.http.shutdown()
        if self.script and self.alive:
            try:
                self.native_call("dispose")
            except Exception:
                pass
        if self.session:
            try:
                self.session.detach()
            except frida.InvalidOperationError:
                pass
        if self.owned and self.alive:
            try:
                self.device.kill(self.pid)
            except frida.ProcessNotFoundError:
                pass
        if self.xvfb:
            self.xvfb.terminate()


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", default=str(Path(os.environ.get("XDG_RUNTIME_DIR", Path.home()/".cache"))/"wechatlinux/agent.sock"))
    parser.add_argument("--appimage")
    parser.add_argument("--extracted-dir")
    parser.add_argument("--data-dir", default=str(Path.home()/".cache/wechatlinux"))
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--attach", type=int, default=0)
    parser.add_argument("--qr-port", type=int, default=18742)
    return parser.parse_args()


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    service = Service(parse_args())
    for signum in [signal.SIGINT, signal.SIGTERM]:
        signal.signal(signum, lambda *_: service.stop.set())
    try:
        service.start()
        service.run()
    except (HelperError, OSError, subprocess.SubprocessError) as exc:
        LOG.error("%s", exc)
        return 1
    finally:
        service.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

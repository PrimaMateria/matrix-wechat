"""Read-only native SQLite schema adapters and committed-state reconciliation.

This module never opens databases, obtains keys, writes rows, or loads Frida.
Schema recognition is not proof of live capability: callers must record actual
successful authenticated reads separately. Native WCDB scalar decoding is used
only when the verified column/marker pair is present; raw values stay preserved.
"""
import base64
import hashlib
import json
import os
import threading
import xml.etree.ElementTree as ET


class StorageError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


def identifier(value):
    return '"' + str(value).replace('"', '""') + '"'


def _alias(columns, *names):
    lowered = {name.lower(): name for name in columns}
    return next((lowered[name.lower()] for name in names if name.lower() in lowered), None)


def _integer(value, default=0):
    try:
        return int(value)
    except (ValueError, TypeError):
        return default


class Storage:
    SCAN_LIMIT = 50000
    KINDS = {1: "text", 3: "image", 34: "audio", 43: "video", 47: "sticker", 48: "location"}

    def __init__(self, native, account_id=""):
        self.native = native
        self.account_id = account_id
        self._snapshot = None
        self._snapshot_account = None
        self._revoke_snapshot = None
        self._database_paths = set()
        self._lock = threading.RLock()

    def _account(self):
        return self.account_id() if callable(self.account_id) else self.account_id

    def reset(self):
        """Drop the reconciliation baseline after an explicit session reset."""
        with self._lock:
            self._snapshot = None
            self._snapshot_account = None
            self._revoke_snapshot = None
            self._database_paths = set()

    def _databases(self):
        databases = self.native.databases()
        if not databases:
            raise StorageError("unverified", "No readable native database connections discovered")
        return databases

    def _query(self, database, sql, limit=None):
        limit = limit or self.SCAN_LIMIT
        result = self.native.query(database["id"], sql, max_rows=limit + 1)
        columns, rows = result.get("columns", []), result.get("rows", [])
        if result.get("truncated") or len(rows) > limit:
            raise StorageError("scan_limit", "Read was truncated; refusing incomplete state", {"database": database.get("path"), "limit": limit})
        if any(len(row) != len(columns) for row in rows):
            raise StorageError("unsupported_schema", "Native query returned inconsistent columns")
        return [dict(zip(columns, row)) for row in rows]

    def _tables(self, database):
        rows = self._query(database, "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        tables = {}
        for row in rows:
            name = row["name"]
            # FTS virtual tables and their shadow tables are not message stores.
            if "virtual table" in (row.get("sql") or "").lower() or "fts" in name.lower():
                continue
            info = self._query(database, "PRAGMA table_info(" + identifier(name) + ")")
            tables[name] = {item["name"]: item.get("type", "") for item in info}
        return tables

    def inspect(self):
        with self._lock:
            result = []
            for database in self._databases():
                tables = self._tables(database)
                result.append({"path": database.get("path", ""), "encrypted": bool(database.get("encrypted", False)), "readable": True,
                               "tables": [{"name": name, "columns": [{"name": col, "type": typ} for col, typ in cols.items()]} for name, cols in tables.items()],
                               "native": {"id": database["id"], "encryption_known": "encrypted" in database}})
            return {"databases": result}

    def _contacts(self):
        output, recognized = {}, False
        for database in self._databases():
            if not os.path.basename(database.get("path", "")).lower().startswith("contact"):
                continue
            for table, columns in self._tables(database).items():
                username = _alias(columns, "username", "user_name")
                nickname, remark = _alias(columns, "nick_name"), _alias(columns, "remark")
                if not username or not (nickname or remark):
                    continue
                recognized = True
                for row in self._query(database, "SELECT * FROM " + identifier(table)):
                    name = row.get(remark) or row.get(nickname) or ""
                    user = row.get(username)
                    if isinstance(user, str) and user:
                        output[user] = {"id": user, "name": name if isinstance(name, str) else "", "native": row}
                        avatar = row.get(_alias(columns, "big_head_url")) or row.get(_alias(columns, "small_head_url"))
                        if isinstance(avatar, str) and avatar:
                            output[user]["avatar"] = avatar
        if not recognized:
            raise StorageError("unsupported_schema", "No supported contact table discovered")
        return list(output.values())

    def contacts(self):
        with self._lock:
            return {"contacts": self._contacts()}

    def groups(self):
        with self._lock:
            contacts = self._contacts()
            groups = {row["id"]: dict(row) for row in contacts if row["id"].endswith("@chatroom")}
            contacts_by_row = {str(row["native"]["id"]): row for row in contacts if "id" in row["native"]}
            for database in self._databases():
                if not os.path.basename(database.get("path", "")).lower().startswith("contact"):
                    continue
                tables = self._tables(database)
                rooms = {}
                if "chat_room" in tables and {"id", "username"}.issubset(tables["chat_room"]):
                    for row in self._query(database, 'SELECT * FROM "chat_room"'):
                        user = row.get("username")
                        if isinstance(user, str) and user:
                            rooms[str(row["id"])] = user
                            groups.setdefault(user, {"id": user, "name": ""})["native_room"] = row
                if "chat_room_info_detail" in tables and {"username_", "announcement_"}.issubset(tables["chat_room_info_detail"]):
                    for row in self._query(database, 'SELECT * FROM "chat_room_info_detail"'):
                        user = row.get("username_")
                        if user in groups:
                            if isinstance(row.get("announcement_"), str):
                                groups[user]["topic"] = row["announcement_"]
                            groups[user]["native_room_detail"] = row
                if "chatroom_member" in tables and {"room_id", "member_id"}.issubset(tables["chatroom_member"]):
                    for group in groups.values():
                        group.setdefault("members", [])
                    for row in self._query(database, 'SELECT * FROM "chatroom_member"'):
                        user = rooms.get(str(row["room_id"]))
                        member = contacts_by_row.get(str(row["member_id"]))
                        if user in groups and member is not None:
                            groups[user]["members"].append(member)
                        elif user in groups:
                            groups[user].setdefault("unresolved_members", []).append(row)
            # Additional native room metadata belongs under the public raw field.
            for group in groups.values():
                for field in ("native_room", "native_room_detail", "unresolved_members"):
                    if field in group:
                        group.setdefault("native", {})[field] = group.pop(field)
            return {"groups": list(groups.values())}

    def conversations(self):
        with self._lock:
            rows, recognized = [], False
            for database in self._databases():
                if not os.path.basename(database.get("path", "")).lower().startswith("session"):
                    continue
                for table, columns in self._tables(database).items():
                    if table != "SessionTable" or "username" not in columns:
                        continue
                    recognized = True
                    for row in self._query(database, "SELECT * FROM " + identifier(table)):
                        user = row.get("username")
                        if isinstance(user, str) and user:
                            rows.append({"id": user, "chat_type": "group" if user.endswith("@chatroom") else "direct", "unread_count": _integer(row.get("unread_count")),
                                         "last_timestamp": _integer(row.get("last_timestamp")), "native": row})
            if not recognized:
                raise StorageError("unsupported_schema", "No supported session table discovered")
            return {"conversations": rows}

    def _name_map(self, database, tables):
        for table, columns in tables.items():
            if table.lower() != "name2id":
                continue
            username = _alias(columns, "username", "user_name")
            if not username:
                continue
            rows = self._query(database, 'SELECT rowid AS "__storage_rowid", * FROM ' + identifier(table))
            id_column = _alias(columns, "id")
            return {str(row.get(id_column) if id_column else row["__storage_rowid"]): row[username] for row in rows if isinstance(row.get(username), str)}
        return {}

    def _message_schema(self, columns):
        schema = {
            "local": _alias(columns, "message_local_id", "msg_local_id", "local_id"),
            "server": _alias(columns, "message_server_id", "msg_svr_id", "server_id"),
            "time": _alias(columns, "create_time"),
            "sender": _alias(columns, "real_sender_id", "sender_id"),
            "type": _alias(columns, "message_type", "local_type"),
            "content": _alias(columns, "message_content"),
            "compressed": _alias(columns, "compress_content"),
            "compression_type": _alias(columns, "WCDB_CT_message_content"),
            "source": _alias(columns, "source"),
            "source_compression_type": _alias(columns, "WCDB_CT_source"),
            "chat": _alias(columns, "username", "user_name"),
        }
        return schema if all(schema[key] for key in ("local", "time", "sender", "type", "content")) else None

    @staticmethod
    def _xml(content):
        if not isinstance(content, str) or len(content) > 2 * 1024 * 1024 or "<!DOCTYPE" in content.upper() or "<!ENTITY" in content.upper():
            return None
        try:
            return ET.fromstring(content)
        except ET.ParseError:
            return None

    def _normalize(self, database, table, row, schema, names, chat):
        row = dict(row)
        decoded = row.pop("__helper_decoded_content", None)
        decoded_source = row.pop("__helper_decoded_source", None)
        if _integer(row[schema["local"]], None) is None or _integer(row[schema["time"]], None) is None:
            raise StorageError("unsupported_schema", "Message identity or timestamp is invalid", {"table": table})
        local = str(row[schema["local"]])
        server = str(row.get(schema["server"]) or "0")
        locator = (database.get("path", str(database["id"])), table, local)
        local_id = "local:" + hashlib.sha256(json.dumps(locator).encode()).hexdigest()
        identity = server if server not in ("0", "", "None") else local_id
        sender_value = row.get(schema["sender"])
        sender = names.get(str(sender_value), "")
        if isinstance(sender_value, str) and not sender_value.isdigit():
            sender = sender_value
        kind = self.KINDS.get(_integer(row[schema["type"]]), "unknown")
        content = decoded if isinstance(decoded, str) else row.get(schema["content"])
        compressed = _integer(row.get(schema["compression_type"])) != 0 and not isinstance(decoded, str)
        message = {"id": identity, "account_id": self._account(), "chat_id": chat, "chat_type": "group" if chat.endswith("@chatroom") else "direct",
                   "sender_id": sender, "kind": kind, "timestamp": _integer(row[schema["time"]]), "own": bool(sender and sender == self._account()),
                   "native": {"database": database.get("path"), "table": table, "row": row, "local_id": local, "content_decoded": isinstance(content, str) and not compressed,
                              "sender_resolved": bool(sender)}}
        if kind == "text" and isinstance(content, str) and not compressed:
            message["text"] = content
        source_value = decoded_source if isinstance(decoded_source, str) else row.get(schema["source"])
        if not isinstance(decoded_source, str) and _integer(row.get(schema["source_compression_type"])) != 0:
            source_value = None
        source_xml = self._xml(source_value)
        if source_xml is not None:
            mentions = source_xml.findtext(".//atuserlist")
            if mentions:
                message["mentions"] = [user for user in mentions.split(",") if user]
        root = self._xml(content) if not compressed else None
        if _integer(row[schema["type"]]) == 49 and root is not None:
            app = root if root.tag == "appmsg" else root.find(".//appmsg")
            if app is not None:
                subtype = app.findtext("type")
                if subtype == "6":
                    message["kind"] = "file"
                elif subtype == "57":
                    message["kind"] = "text"
                    message["text"] = app.findtext("title") or ""
                    target = app.findtext("refermsg/svrid")
                    if target:
                        message["reply_to"] = target
        if message["kind"] == "location" and root is not None:
            location = root if root.tag == "location" else root.find(".//location")
            if location is not None:
                try:
                    latitude, longitude = float(location.attrib["x"]), float(location.attrib["y"])
                    if -90 <= latitude <= 90 and -180 <= longitude <= 180:
                        message["location"] = {"latitude": latitude, "longitude": longitude, "label": location.get("label", "")}
                except (KeyError, ValueError):
                    pass
        if message["kind"] in ("image", "sticker", "video", "audio", "file"):
            message["media"] = {"id": identity, "kind": message["kind"], "state": "pending"}
        return locator, message

    def _messages(self):
        output, recognized, paths = {}, False, set()
        unresolved = []
        for database in self._databases():
            if not os.path.basename(database.get("path", "")).lower().startswith("message"):
                continue
            paths.add(database.get("path", str(database["id"])))
            tables = self._tables(database)
            names = self._name_map(database, tables)
            chats = {"msg_" + hashlib.md5(user.encode()).hexdigest(): user for user in names.values()}
            for table, columns in tables.items():
                schema = self._message_schema(columns)
                if not schema:
                    continue
                projections = ["*"]
                if schema["compression_type"]:
                    projections.append("wcdb_decompress(" + identifier(schema["content"]) + "," + identifier(schema["compression_type"]) + ') AS "__helper_decoded_content"')
                source, source_type = _alias(columns, "source"), _alias(columns, "WCDB_CT_source")
                if source and source_type:
                    projections.append("wcdb_decompress(" + identifier(source) + "," + identifier(source_type) + ') AS "__helper_decoded_source"')
                rows = self._query(database, "SELECT " + ",".join(projections) + " FROM " + identifier(table))
                chat = chats.get(table.lower())
                if not chat and not schema["chat"]:
                    unresolved.append(table)
                    continue
                recognized = True
                for row in rows:
                    row_chat = row.get(schema["chat"]) if schema["chat"] else chat
                    if not isinstance(row_chat, str) or not row_chat:
                        raise StorageError("unsupported_schema", "Message has no resolved conversation", {"table": table})
                    key, message = self._normalize(database, table, row, schema, names, row_chat)
                    output[key] = message
        if unresolved:
            raise StorageError("unsupported_schema", "Message conversation mapping unavailable", {"tables": unresolved})
        if not recognized:
            raise StorageError("unsupported_schema", "No supported message table discovered")
        return output, paths

    def _revokes(self):
        rows = {}
        for database in self._databases():
            if os.path.basename(database.get("path", "")).lower() != "general.db":
                continue
            tables = self._tables(database)
            if "revokemessage" not in tables or not {"to_user_name", "svr_id", "revoke_time"}.issubset(tables["revokemessage"]):
                continue
            for row in self._query(database, 'SELECT * FROM "revokemessage"'):
                chat, target = row.get("to_user_name"), str(row.get("svr_id") or "")
                if isinstance(chat, str) and chat and target not in ("", "0"):
                    key = (chat, target, str(row.get("revoke_time")))
                    rows[key] = row
        return rows

    @staticmethod
    def _deduplicate(messages):
        by_identity = {}
        for message in messages:
            by_identity[(message["chat_id"], message["id"])] = message
        return list(by_identity.values())

    def history(self, params):
        with self._lock:
            chat = params.get("chat_id")
            if not isinstance(chat, str) or not chat:
                raise StorageError("invalid_params", "chat_id is required")
            limit = params.get("limit", 50)
            if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 500:
                raise StorageError("invalid_params", "limit must be between 1 and 500")
            messages, _ = self._messages()
            rows = self._deduplicate(row for row in messages.values() if row["chat_id"] == chat)
            rows.sort(key=lambda row: (row["timestamp"], row["id"]), reverse=True)
            if params.get("cursor"):
                try:
                    cursor = json.loads(base64.b64decode(params["cursor"], validate=True))
                    if cursor["chat_id"] != chat or not isinstance(cursor["timestamp"], int) or not isinstance(cursor["id"], str):
                        raise ValueError()
                    rows = [row for row in rows if (row["timestamp"], row["id"]) < (cursor["timestamp"], cursor["id"])]
                except (ValueError, TypeError, KeyError, UnicodeError) as exc:
                    raise StorageError("invalid_params", "Invalid history cursor") from exc
            page = rows[:limit]
            result = {"messages": page}
            if len(rows) > limit:
                last = page[-1]
                result["next_cursor"] = base64.b64encode(json.dumps({"chat_id": chat, "timestamp": last["timestamp"], "id": last["id"]}).encode()).decode()
            return result

    def poll(self):
        with self._lock:
            current, paths = self._messages()
            revokes = self._revokes()
            previous = self._snapshot
            previous_revokes = self._revoke_snapshot
            if self._snapshot_account != self._account():
                previous = None
                previous_revokes = None
            if previous is not None and not self._database_paths.issubset(paths):
                raise StorageError("unverified", "A previous message shard is unavailable; refusing deletion inference")
            events = []
            if previous is not None:
                known_server = {(row["chat_id"], row["id"]): row for row in previous.values() if not row["id"].startswith("local:")}
                emitted = set()
                for key, row in current.items():
                    old = previous.get(key) or known_server.get((row["chat_id"], row["id"]))
                    identity = (row["chat_id"], row["id"])
                    if identity in emitted or old == row:
                        continue
                    event = {"type": "message.updated" if old else "message", "account_id": self._account(), "chat_id": row["chat_id"], "message": row}
                    if old and old["id"] != row["id"]:
                        event["data"] = {"previous_id": old["id"]}
                    events.append(event)
                    emitted.add(identity)
                current_ids = {(row["chat_id"], row["id"]) for row in current.values()}
                removed = set()
                for key, row in previous.items():
                    identity = (row["chat_id"], row["id"])
                    if key not in current and identity not in current_ids and identity not in removed:
                        events.append({"type": "message.deleted", "account_id": self._account(), "chat_id": row["chat_id"], "data": {"message_id": row["id"], "reason": "storage_disappearance"}})
                        removed.add(identity)
            if previous_revokes is not None:
                for key, row in revokes.items():
                    if key not in previous_revokes:
                        chat, target, timestamp = key
                        message = {"id": "revoke:" + hashlib.sha256(json.dumps(key).encode()).hexdigest(), "chat_id": chat, "account_id": self._account(),
                                   "sender_id": "", "kind": "redaction", "timestamp": _integer(timestamp), "revoke_target": target, "native": row}
                        events.append({"type": "message.revoked", "account_id": self._account(), "chat_id": chat, "message": message, "data": {"message_id": target}})
            self._snapshot, self._database_paths = current, paths
            self._revoke_snapshot = revokes
            self._snapshot_account = self._account()
            return events

    def media(self, params):
        with self._lock:
            identity = params.get("message_id") or params.get("media_id")
            if not isinstance(identity, str) or not identity:
                raise StorageError("invalid_params", "message_id or media_id is required")
            messages, _ = self._messages()
            for message in messages.values():
                if message["id"] == identity and "media" in message:
                    # Resource records and native media decoding are not yet
                    # verified. Never interpret arbitrary XML paths as files.
                    return dict(message["media"])
            raise StorageError("not_found", "Media message not found")

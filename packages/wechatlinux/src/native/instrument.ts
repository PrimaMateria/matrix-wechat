/* Injected into the exact pinned WeChat image. Keys remain in target memory. */

const base = Process.mainModule.base;
const nullPtr = ptr(0);
const connections = new Map(),
  retained = new Map(),
  statements = new Map(),
  internalHandles = new Set();
let connectionSequence = 0;
const internalThreads = new Map();
function enterInternal() {
  const tid = Process.getCurrentThreadId();
  internalThreads.set(tid, (internalThreads.get(tid) || 0) + 1);
}
function leaveInternal() {
  const tid = Process.getCurrentThreadId();
  const n = (internalThreads.get(tid) || 1) - 1;
  if (n) internalThreads.set(tid, n);
  else internalThreads.delete(tid);
}
let loginModel = nullPtr,
  revision = 0,
  switchRequested = false,
  loginOwnerThread = 0;
const native = {};
const signatures = {
  libversion: ["pointer", []],
  open_v2: ["int", ["pointer", "pointer", "int", "pointer"]],
  close_v2: ["int", ["pointer"]],
  prepare_v2: ["int", ["pointer", "pointer", "int", "pointer", "pointer"]],
  prepare_v3: ["int", ["pointer", "pointer", "int", "uint", "pointer", "pointer"]],
  step: ["int", ["pointer"]],
  finalize: ["int", ["pointer"]],
  reset: ["int", ["pointer"]],
  db_handle: ["pointer", ["pointer"]],
  get_autocommit: ["int", ["pointer"]],
  db_filename: ["pointer", ["pointer", "pointer"]],
  db_mutex: ["pointer", ["pointer"]],
  mutex_enter: ["void", ["pointer"]],
  mutex_leave: ["void", ["pointer"]],
  column_count: ["int", ["pointer"]],
  column_name: ["pointer", ["pointer", "int"]],
  column_type: ["int", ["pointer", "int"]],
  column_int64: ["int64", ["pointer", "int"]],
  column_double: ["double", ["pointer", "int"]],
  column_text: ["pointer", ["pointer", "int"]],
  column_blob: ["pointer", ["pointer", "int"]],
  column_bytes: ["int", ["pointer", "int"]],
  errmsg: ["pointer", ["pointer"]],
  stmt_readonly: ["int", ["pointer"]],
  key: ["int", ["pointer", "pointer", "int"]],
  key_v2: ["int", ["pointer", "pointer", "pointer", "int"]],
  create_function: [
    "int",
    ["pointer", "pointer", "int", "int", "pointer", "pointer", "pointer", "pointer"],
  ],
};
for (const [name, sig] of Object.entries(signatures)) {
  const address = base.add(PROFILE.functions[name]);
  const expected = PROFILE.validation_bytes[name];
  if (expected) {
    const actual = Array.from(new Uint8Array(address.readByteArray(expected.length / 2)))
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    if (actual !== expected) throw Error("Unsupported native function bytes: " + name);
  }
  native[name] = new NativeFunction(address, sig[0], sig[1], {
    exceptions: "steal",
  });
}
function text(p) {
  return p.isNull() ? "" : p.readUtf8String();
}
function hint(kind, data) {
  revision++;
  send({ type: "change_hint", kind, revision, ...data });
}
function recognized(path) {
  return (
    /\/db_storage\//.test(path) &&
    /\.db$/.test(path) &&
    !/\/(sns|favorite|solitaire|chatbot|third_app_icon)\//.test(path) &&
    !/(?:_fts|weclaw)\.db$/.test(path)
  );
}
function discover(db, path) {
  if (db.isNull() || internalHandles.has(db.toString())) return null;
  const id = db.toString();
  let c = connections.get(id);
  if (!path) {
    try {
      path = text(native.db_filename(db, Memory.allocUtf8String("main")));
    } catch (_) {
      return null;
    }
  }
  if (!recognized(path)) return null;
  if (!c) {
    c = {
      id: id + "#" + ++connectionSequence,
      db,
      path,
      key: null,
      keyLength: 0,
      cipher: [],
      reader: null,
      readable: false,
      error: null,
    };
    connections.set(id, c);
    hint("database_open", { id, path });
  }
  return c;
}
function closeReader(c) {
  if (c.reader) {
    const p = c.reader;
    c.reader = null;
    enterInternal();
    try {
      native.close_v2(p);
    } finally {
      leaveInternal();
      internalHandles.delete(p.toString());
    }
  }
}
for (const name of ["open_v2", "open"]) {
  if (!PROFILE.functions[name]) continue;
  Interceptor.attach(base.add(PROFILE.functions[name]), {
    onEnter(a) {
      if (internalThreads.has(this.threadId)) return;
      this.output = a[1];
      this.path = text(a[0]);
    },
    onLeave(ret) {
      if (this.output && ret.toInt32() === 0) discover(this.output.readPointer(), this.path);
    },
  });
}
for (const name of ["key", "key_v2"])
  Interceptor.attach(base.add(PROFILE.functions[name]), {
    onEnter(a) {
      if (internalThreads.has(this.threadId)) return;
      const c = discover(a[0]);
      if (!c) return;
      const k = name === "key" ? 1 : 2,
        n = k + 1;
      const length = a[n].toInt32();
      if (length > 0 && length <= 1024) {
        if (c.key) c.key.writeByteArray(new Uint8Array(c.keyLength));
        c.key = Memory.alloc(length);
        c.key.writeByteArray(a[k].readByteArray(length));
        c.keyLength = length;
        closeReader(c);
        hint("database_configured", { id: c.id, path: c.path });
      }
    },
  });
for (const name of ["prepare_v2", "prepare_v3"])
  Interceptor.attach(base.add(PROFILE.functions[name]), {
    onEnter(a) {
      if (internalThreads.has(this.threadId)) return;
      this.db = a[0];
      this.output = a[name === "prepare_v2" ? 3 : 4];
      let sql = "";
      try {
        sql = text(a[1]);
      } catch (_) {}
      this.transactionEnd = /^\s*(COMMIT|END|ROLLBACK)\b/i.test(sql);
      this.cipher = sql.match(
        /^\s*PRAGMA\s+(cipher_[a-z_]+|kdf_iter|fast_kdf_iter)\s*=\s*([a-zA-Z0-9_'"-]+)\s*;?\s*$/i,
      )
        ? sql
        : null;
    },
    onLeave(ret) {
      if (!this.output || ret.toInt32() !== 0) return;
      const c = discover(this.db);
      if (!c) return;
      const statement = this.output.readPointer();
      if (!statement.isNull()) {
        statements.set(statement.toString(), {
          connection: c,
          write: !native.stmt_readonly(statement),
          cipher: this.cipher,
          transactionEnd: this.transactionEnd,
        });
      }
    },
  });
Interceptor.attach(base.add(PROFILE.functions.step), {
  onEnter(a) {
    if (internalThreads.has(this.threadId)) return;
    this.statement = statements.get(a[0].toString());
  },
  onLeave(ret) {
    const s = this.statement;
    if (!s) return;
    const rc = ret.toInt32();
    if (rc === 101 && s.cipher && !s.connection.cipher.includes(s.cipher)) {
      s.connection.cipher.push(s.cipher);
      closeReader(s.connection);
    }
    if ((s.write || s.transactionEnd) && rc === 101) {
      let committed = false;
      try {
        committed = native.get_autocommit(s.connection.db) !== 0;
      } catch (_) {}
      hint(committed ? "committed_write" : "transaction_write", {
        id: s.connection.id,
        path: s.connection.path,
      });
    }
  },
});
Interceptor.attach(base.add(PROFILE.functions.finalize), {
  onEnter(a) {
    if (!internalThreads.has(this.threadId)) statements.delete(a[0].toString());
  },
});
for (const name of ["close", "close_v2"])
  Interceptor.attach(base.add(PROFILE.functions[name]), {
    onEnter(a) {
      if (internalThreads.has(this.threadId)) return;
      this.dbId = a[0].toString();
      this.c = connections.get(this.dbId);
    },
    onLeave(ret) {
      if (this.c && ret.toInt32() === 0) {
        const old = retained.get(this.c.path);
        if (old && old !== this.c) {
          closeReader(old);
          if (old.key) old.key.writeByteArray(new Uint8Array(old.keyLength));
        }
        retained.set(this.c.path, this.c);
        connections.delete(this.dbId);
        hint("database_closed", { id: this.c.id, path: this.c.path });
      }
    },
  });
const loginVtable = base.add(0xa6f0ac8);
const nativeNew = new NativeFunction(base.add(0xa674ee0), "pointer", ["ulong"]);
const queueSlot = new NativeFunction(
  base.add(0xa50af00),
  "void",
  ["int", "int", "pointer", "pointer"],
  { exceptions: "steal" },
);
function loginState() {
  if (loginModel.isNull() || !loginModel.readPointer().equals(loginVtable))
    return { active: false };
  return {
    active: true,
    view: loginModel.add(0x40).readU32(),
    phase: loginModel.add(0x44).readU32(),
    request: loginModel.add(0x4c).readU32(),
    can_resume: loginModel.add(0x338).readU8() !== 0,
  };
}
function queueLogin(mode) {
  if (loginModel.isNull() || !loginModel.readPointer().equals(loginVtable))
    return { queued: false };
  if (mode !== "qr" && mode !== "saved") throw Error("Invalid login action");
  if (mode === "saved" && !loginState().can_resume) return { queued: false, reason: "qr_required" };
  const window = loginModel.sub(0x278);
  if (!window.readPointer().equals(base.add(0xa6f0b50))) throw Error("Invalid login window");
  const slot = nativeNew(24);
  slot.writeU32(1);
  slot.add(4).writeU32(0);
  slot.add(8).writePointer(base.add(mode === "qr" ? 0x4874550 : 0x4874710));
  slot.add(16).writePointer(window);
  queueSlot(0, 0, window, slot);
  return { queued: true };
}
Interceptor.attach(base.add(0x487f250), {
  onEnter(a) {
    this.self = a[0];
  },
  onLeave() {
    loginModel = this.self;
    loginOwnerThread = this.threadId;
    hint("login_view_open", {});
  },
});
Interceptor.attach(base.add(0x48808e0), {
  onEnter(a) {
    if (loginModel.equals(a[0])) {
      loginModel = nullPtr;
      hint("login_view_closed", {});
    }
  },
});
Interceptor.attach(base.add(0x4882e50), {
  onEnter(a) {
    if (a[0].equals(loginModel)) send({ type: "login_state", state: loginState() });
  },
});
function sqlQuery(db, sql, maxRows, allowWrite = false) {
  const holder = Memory.alloc(Process.pointerSize);
  holder.writePointer(nullPtr);
  const tail = Memory.alloc(Process.pointerSize);
  let statement = nullPtr;
  // SQLite's tail points into this buffer; retain it until tail validation.
  const sqlBuffer = Memory.allocUtf8String(sql);
  const rc = native.prepare_v2(db, sqlBuffer, -1, holder, tail);
  if (rc !== 0) throw Error("SQLite prepare " + rc + ": " + text(native.errmsg(db)));
  statement = holder.readPointer();
  if (statement.isNull()) throw Error("Empty SQL statement");
  try {
    const remainder = tail.readPointer();
    if (
      remainder.isNull() ||
      remainder.compare(sqlBuffer) < 0 ||
      remainder.compare(sqlBuffer.add(unescape(encodeURIComponent(sql)).length)) > 0
    )
      throw Error("Invalid SQL tail");
    if (text(remainder).trim()) throw Error("Only one SQL statement allowed");
    if (!allowWrite && !native.stmt_readonly(statement)) throw Error("Query is not read-only");
    const count = native.column_count(statement),
      columns = [],
      rows = [];
    let truncated = false;
    for (let i = 0; i < count; i++) columns.push(text(native.column_name(statement, i)));
    while (true) {
      const status = native.step(statement);
      if (status === 101) break;
      if (status !== 100) throw Error("SQLite step " + status + ": " + text(native.errmsg(db)));
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      const row = [];
      for (let i = 0; i < count; i++) {
        const type = native.column_type(statement, i);
        if (type === 1) row.push(native.column_int64(statement, i).toString());
        else if (type === 2) row.push(native.column_double(statement, i));
        else if (type === 3) row.push(text(native.column_text(statement, i)));
        else if (type === 4) {
          const n = native.column_bytes(statement, i);
          if (n > 8 * 1024 * 1024) throw Error("Blob exceeds read limit");
          const p = native.column_blob(statement, i);
          row.push({
            bytes: Array.from(new Uint8Array(n ? p.readByteArray(n) : new ArrayBuffer(0))),
          });
        } else row.push(null);
      }
      rows.push(row);
    }
    return { columns, rows, truncated };
  } finally {
    native.finalize(statement);
  }
}
function reader(c) {
  if (c.reader) return c.reader;
  const out = Memory.alloc(Process.pointerSize);
  out.writePointer(nullPtr);
  const rc = native.open_v2(Memory.allocUtf8String(c.path), out, 0x10001, nullPtr);
  const db = out.readPointer();
  if (rc !== 0) {
    if (!db.isNull()) native.close_v2(db);
    throw Error("Read-only open failed: " + rc);
  }
  internalHandles.add(db.toString());
  try {
    if (c.key) {
      const kr = native.key(db, c.key, c.keyLength);
      if (kr !== 0) throw Error("Native cipher setup failed: " + kr);
    }
    for (const pragma of c.cipher) sqlQuery(db, pragma, 1, true);
    const compression = PROFILE.compression;
    if (compression) {
      const cr = native.create_function(
        db,
        Memory.allocUtf8String(compression.scalar_name),
        compression.argument_count,
        compression.sqlite_encoding_flags,
        nullPtr,
        base.add(compression.scalar_callback_rva),
        nullPtr,
        nullPtr,
      );
      if (cr !== 0) throw Error("Native decompression registration failed: " + cr);
    }
    sqlQuery(db, "SELECT name FROM sqlite_master LIMIT 1", 1);
    c.reader = db;
    c.readable = true;
    c.error = null;
    return db;
  } catch (e) {
    internalHandles.delete(db.toString());
    native.close_v2(db);
    c.readable = false;
    c.error = String(e);
    throw e;
  }
}
function scanQR() {
  const candidates = [];
  let bytesScanned = 0;
  for (const range of Process.enumerateRanges({
    protection: "rw-",
    coalesce: true,
  })) {
    if (
      range.size > 100 * 1024 * 1024 ||
      range.size < 512 ||
      (range.file && !range.file.path.includes("wechat"))
    )
      continue;
    bytesScanned += range.size;
    let hits = [];
    try {
      hits = Memory.scanSync(range.base, range.size, "89 50 4e 47 0d 0a 1a 0a");
    } catch (_) {}
    for (const hit of hits) {
      try {
        const p = hit.address;
        const width =
          ((p.add(16).readU8() << 24) |
            (p.add(17).readU8() << 16) |
            (p.add(18).readU8() << 8) |
            p.add(19).readU8()) >>>
          0;
        const height =
          ((p.add(20).readU8() << 24) |
            (p.add(21).readU8() << 16) |
            (p.add(22).readU8() << 8) |
            p.add(23).readU8()) >>>
          0;
        if (width !== height || width < 64 || width > 1024) continue;
        const n = Math.min(256000, range.size - p.sub(range.base).toUInt32());
        const end = Memory.scanSync(p, n, "49 45 4e 44 ae 42 60 82");
        if (end.length) {
          const length = end[0].address.sub(p).toUInt32() + 8;
          candidates.push({
            bytes: Array.from(new Uint8Array(p.readByteArray(length))),
            width,
            height,
          });
        }
      } catch (_) {}
    }
  }
  return { candidates, bytes_scanned: bytesScanned };
}
// Executed inside Frida; input and callback lifetimes are retained explicitly.
const outboundPending = new Map();
let outboundSequence = 0;
const outboundQueue = [];
let drainingOutbound = false;
Interceptor.attach(base.add(0x60421e0), {
  onEnter(a) {
    this.out = a[0];
  },
  onLeave() {
    if (drainingOutbound || !outboundQueue.length) return;
    try {
      const ctx = this.out.readPointer();
      if (ctx.isNull() || ctx.add(0x28).readPointer().isNull()) return;
    } catch (_) {
      return;
    }
    const job = outboundQueue.shift();
    drainingOutbound = true;
    try {
      job();
    } finally {
      drainingOutbound = false;
    }
  },
});
function stdString(s) {
  const n = unescape(encodeURIComponent(s)).length,
    object = Memory.alloc(24),
    bytes = Memory.allocUtf8String(s);
  object.writeByteArray(new Uint8Array(24));
  if (n < 23) {
    object.writeU8(n * 2);
    object.add(1).writeUtf8String(s);
  } else {
    object.writeU64((Math.ceil((n + 1) / 16) * 16) | 1);
    object.add(8).writeU64(n);
    object.add(16).writePointer(bytes);
  }
  return { object, bytes };
}
function readStdString(p) {
  if (p.isNull()) return "";
  const long = (p.readU8() & 1) !== 0,
    n = long ? p.add(8).readU64().toNumber() : p.readU8() >>> 1;
  if (n > 2097152) throw Error("Native result exceeds limit");
  return (long ? p.add(16).readPointer() : p.add(1)).readUtf8String(n) || "";
}
function exactJSON(s) {
  return JSON.parse(s.replace(/("(?:message_id|server_id|create_time)"\s*:\s*)(-?\d+)/g, '$1"$2"'));
}
const invokeResult = new NativeCallback(
  (object, success, error) => {
    const job = outboundPending.get(object.toString());
    if (!job) return;
    try {
      const ok = readStdString(success),
        failure = readStdString(error);
      const result = ok
        ? exactJSON(ok)
        : {
            success: false,
            error_message: failure || "Native handler returned no result",
          };
      if (failure && !result.error_message) result.error_message = failure;
      job.resolve(result);
    } catch (e) {
      job.reject(e);
    }
  },
  "void",
  ["pointer", "pointer", "pointer"],
);
const destroyResult = new NativeCallback(
  (object) => {
    const key = object.toString();
    setImmediate(() => outboundPending.delete(key));
  },
  "void",
  ["pointer"],
);
function outboundCall(payload, queued = false) {
  return new Promise((resolve, reject) => {
    const f = OUTBOUND.functions.generic_json_wrapper,
      address = base.add(f.rva);
    const actual = Array.from(new Uint8Array(address.readByteArray(f.validation_bytes.length / 2)))
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    if (actual !== f.validation_bytes) {
      reject(Error("Unsupported send function"));
      return;
    }
    const args = stdString(payload),
      context = stdString("wechat-api-" + ++outboundSequence);
    const callback = Memory.alloc(32),
      owner = Memory.alloc(Process.pointerSize);
    callback.writeByteArray(new Uint8Array(32));
    new NativeFunction(base.add(OUTBOUND.functions.callback_constructor.rva), "void", [
      "pointer",
      "pointer",
      "pointer",
    ])(callback, invokeResult, destroyResult);
    owner.writePointer(callback);
    let invoked = false,
      cancelled = false;
    const timer = setTimeout(() => {
      cancelled = true;
      if (!invoked) outboundPending.delete(callback.toString());
      reject(
        Error(
          invoked
            ? "Send acknowledgement timed out; delivery is uncertain; do not automatically retry"
            : "Timed out waiting for the native account thread; message was not sent",
        ),
      );
    }, 30000);
    outboundPending.set(callback.toString(), {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
      args,
      context,
      callback,
      owner,
    });
    const invoke = () => {
      if (cancelled) return;
      invoked = true;
      try {
        new NativeFunction(address, "void", ["pointer", "pointer", "pointer", "pointer"], {
          exceptions: "steal",
        })(nullPtr, args.object, context.object, owner);
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    };
    if (queued) {
      if (outboundQueue.length >= 16) {
        clearTimeout(timer);
        reject(Error("Send queue full"));
        return;
      }
      outboundQueue.push(invoke);
    } else invoke();
  });
}

rpc.exports = {
  sendprobe() {
    return outboundCall("{}");
  },
  sendtext(chat, content) {
    if (typeof chat !== "string" || !chat || typeof content !== "string" || !content)
      throw Error("Invalid message");
    return outboundCall(
      JSON.stringify({ chat_id: chat, message_type: 1, content_xml: content }),
      true,
    );
  },
  login: queueLogin,
  status() {
    return {
      sqlite_version: text(native.libversion()),
      login_view_active: !loginModel.isNull(),
      login: loginState(),
      revision,
      databases: connections.size,
    };
  },
  scanqr: scanQR,
  databases() {
    enterInternal();
    try {
      const unique = new Map();
      for (const c of [...retained.values(), ...connections.values()]) {
        const old = unique.get(c.path);
        if (!old || c.key) unique.set(c.path, c);
      }
      return Array.from(unique.values()).map((c) => {
        try {
          reader(c);
        } catch (_) {}
        return {
          id: c.id,
          path: c.path,
          encrypted: !!c.key,
          readable: c.readable,
          error: c.error,
          key_captured: !!c.key,
          cipher_settings: c.cipher,
        };
      });
    } finally {
      leaveInternal();
    }
  },
  query(id, sql, maxRows) {
    if (typeof sql !== "string" || sql.length > 65536) throw Error("Invalid SQL");
    const c = [...connections.values(), ...retained.values()].find((c) => c.id === id);
    if (!c) throw Error("Unknown or closed database handle");
    enterInternal();
    try {
      return sqlQuery(reader(c), sql, Math.max(1, Math.min(maxRows || 1000, 50001)));
    } finally {
      leaveInternal();
    }
  },
  dispose() {
    enterInternal();
    try {
      for (const c of new Set([...connections.values(), ...retained.values()])) {
        closeReader(c);
        if (c.key) c.key.writeByteArray(new Uint8Array(c.keyLength));
      }
      connections.clear();
      retained.clear();
      statements.clear();
    } finally {
      leaveInternal();
    }
  },
};
send({ type: "ready", sqlite_version: text(native.libversion()) });

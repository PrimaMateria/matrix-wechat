/* Injected into the exact pinned WeChat image. Keys remain in target memory. */
'use strict';
const base = Process.mainModule.base;
const nullPtr = ptr(0);
const connections = new Map(), statements = new Map(), internalHandles = new Set();
const internalThreads = new Map();
function enterInternal(){const tid=Process.getCurrentThreadId();internalThreads.set(tid,(internalThreads.get(tid)||0)+1);}
function leaveInternal(){const tid=Process.getCurrentThreadId();const n=(internalThreads.get(tid)||1)-1;if(n)internalThreads.set(tid,n);else internalThreads.delete(tid);}
let loginModel = nullPtr, revision = 0;
const native = {};
const signatures = {
 libversion:['pointer',[]], open_v2:['int',['pointer','pointer','int','pointer']],
 close_v2:['int',['pointer']], prepare_v2:['int',['pointer','pointer','int','pointer','pointer']],
 prepare_v3:['int',['pointer','pointer','int','uint','pointer','pointer']],
 step:['int',['pointer']], finalize:['int',['pointer']], reset:['int',['pointer']],
 db_handle:['pointer',['pointer']], get_autocommit:['int',['pointer']], db_filename:['pointer',['pointer','pointer']],
 db_mutex:['pointer',['pointer']], mutex_enter:['void',['pointer']], mutex_leave:['void',['pointer']],
 column_count:['int',['pointer']], column_name:['pointer',['pointer','int']], column_type:['int',['pointer','int']],
 column_int64:['int64',['pointer','int']], column_double:['double',['pointer','int']],
 column_text:['pointer',['pointer','int']], column_blob:['pointer',['pointer','int']], column_bytes:['int',['pointer','int']],
 errmsg:['pointer',['pointer']], stmt_readonly:['int',['pointer']],
 key:['int',['pointer','pointer','int']], key_v2:['int',['pointer','pointer','pointer','int']],
 create_function:['int',['pointer','pointer','int','int','pointer','pointer','pointer','pointer']]
};
for (const [name,sig] of Object.entries(signatures)) {
 const address=base.add(PROFILE.functions[name]);
 const expected=PROFILE.validation_bytes[name];
 if(expected){const actual=Array.from(new Uint8Array(address.readByteArray(expected.length/2))).map(x=>x.toString(16).padStart(2,'0')).join('');if(actual!==expected)throw Error('Unsupported native function bytes: '+name);}
 native[name]=new NativeFunction(address,sig[0],sig[1],{exceptions:'steal'});
}
function text(p){return p.isNull()?'':p.readUtf8String();}
function hint(kind,data){revision++;send({type:'change_hint',kind,revision,...data});}
function recognized(path){return /\/db_storage\//.test(path)&&/\.db$/.test(path)&&!/\/(sns|favorite|solitaire|chatbot|third_app_icon)\//.test(path)&&!/(?:_fts|weclaw)\.db$/.test(path);}
function discover(db,path){
 if(db.isNull()||internalHandles.has(db.toString()))return null;
 const id=db.toString();let c=connections.get(id);
 if(!path){try{path=text(native.db_filename(db,Memory.allocUtf8String('main')));}catch(_){return null;}}
 if(!recognized(path))return null;
 if(!c){c={id,db,path,key:null,keyLength:0,cipher:[],reader:null,readable:false,error:null};connections.set(id,c);hint('database_open',{id,path});}
 return c;
}
function closeReader(c){if(c.reader){const p=c.reader;c.reader=null;enterInternal();try{native.close_v2(p);}finally{leaveInternal();internalHandles.delete(p.toString());}}}
for(const name of ['open_v2','open']) {
 if(!PROFILE.functions[name])continue;
 Interceptor.attach(base.add(PROFILE.functions[name]),{
  onEnter(a){if(internalThreads.has(this.threadId))return;this.output=a[1];this.path=text(a[0]);},
  onLeave(ret){if(this.output&&ret.toInt32()===0)discover(this.output.readPointer(),this.path);}
 });
}
for(const name of ['key','key_v2'])Interceptor.attach(base.add(PROFILE.functions[name]),{
 onEnter(a){if(internalThreads.has(this.threadId))return;const c=discover(a[0]);if(!c)return;const k=name==='key'?1:2,n=k+1;const length=a[n].toInt32();if(length>0&&length<=1024){if(c.key)c.key.writeByteArray(new Uint8Array(c.keyLength));c.key=Memory.alloc(length);c.key.writeByteArray(a[k].readByteArray(length));c.keyLength=length;closeReader(c);hint('database_configured',{id:c.id,path:c.path});}}
});
for(const name of ['prepare_v2','prepare_v3'])Interceptor.attach(base.add(PROFILE.functions[name]),{
 onEnter(a){if(internalThreads.has(this.threadId))return;this.db=a[0];this.output=a[name==='prepare_v2'?3:4];let sql='';try{sql=text(a[1]);}catch(_){}this.cipher=sql.match(/^\s*PRAGMA\s+(cipher_[a-z_]+|kdf_iter|fast_kdf_iter)\s*=\s*([a-zA-Z0-9_'"\-]+)\s*;?\s*$/i)?sql:null;},
 onLeave(ret){if(!this.output||ret.toInt32()!==0)return;const c=discover(this.db);if(!c)return;const statement=this.output.readPointer();if(!statement.isNull()){statements.set(statement.toString(),{connection:c,write:!native.stmt_readonly(statement),cipher:this.cipher});}}
});
Interceptor.attach(base.add(PROFILE.functions.step),{
 onEnter(a){if(internalThreads.has(this.threadId))return;this.statement=statements.get(a[0].toString());},
 onLeave(ret){const s=this.statement;if(!s)return;const rc=ret.toInt32();if(rc===101&&s.cipher&&!s.connection.cipher.includes(s.cipher)){s.connection.cipher.push(s.cipher);closeReader(s.connection);}if(s.write&&rc===101){let committed=false;try{committed=native.get_autocommit(s.connection.db)!==0;}catch(_){}hint(committed?'committed_write':'transaction_write',{id:s.connection.id,path:s.connection.path});}}
});
Interceptor.attach(base.add(PROFILE.functions.finalize),{onEnter(a){if(!internalThreads.has(this.threadId))statements.delete(a[0].toString());}});
for(const name of ['close','close_v2'])Interceptor.attach(base.add(PROFILE.functions[name]),{
 onEnter(a){if(internalThreads.has(this.threadId))return;this.c=connections.get(a[0].toString());if(this.c)closeReader(this.c);},
 onLeave(ret){if(this.c&&ret.toInt32()===0){if(this.c.key)this.c.key.writeByteArray(new Uint8Array(this.c.keyLength));connections.delete(this.c.id);hint('database_closed',{id:this.c.id,path:this.c.path});}}
});
const loginVtable=base.add(0xa6f0ac8);
Interceptor.attach(base.add(0x487f250),{onEnter(a){this.self=a[0];},onLeave(){loginModel=this.self;hint('login_view_open',{});}});
Interceptor.attach(base.add(0x48808e0),{onEnter(a){if(loginModel.equals(a[0])){loginModel=nullPtr;hint('login_view_closed',{});}}});
function sqlQuery(db,sql,maxRows,allowWrite=false){
 const holder=Memory.alloc(Process.pointerSize);holder.writePointer(nullPtr);
 const tail=Memory.alloc(Process.pointerSize);let statement=nullPtr;
 const rc=native.prepare_v2(db,Memory.allocUtf8String(sql),-1,holder,tail);
 if(rc!==0)throw Error('SQLite prepare '+rc+': '+text(native.errmsg(db)));
 statement=holder.readPointer();if(statement.isNull())throw Error('Empty SQL statement');
 try{
  if(text(tail.readPointer()).trim())throw Error('Only one SQL statement allowed');
  if(!allowWrite&&!native.stmt_readonly(statement))throw Error('Query is not read-only');
  const count=native.column_count(statement),columns=[],rows=[];let truncated=false;
  for(let i=0;i<count;i++)columns.push(text(native.column_name(statement,i)));
  while(true){const status=native.step(statement);if(status===101)break;if(status!==100)throw Error('SQLite step '+status+': '+text(native.errmsg(db)));if(rows.length>=maxRows){truncated=true;break;}
   const row=[];for(let i=0;i<count;i++){const type=native.column_type(statement,i);if(type===1)row.push(native.column_int64(statement,i).toString());else if(type===2)row.push(native.column_double(statement,i));else if(type===3)row.push(text(native.column_text(statement,i)));else if(type===4){const n=native.column_bytes(statement,i);if(n>8*1024*1024)throw Error('Blob exceeds read limit');const p=native.column_blob(statement,i);row.push({bytes:Array.from(new Uint8Array(n?p.readByteArray(n):new ArrayBuffer(0)))});}else row.push(null);}rows.push(row);
  }return {columns,rows,truncated};
 }finally{native.finalize(statement);}
}
function reader(c){
 if(c.reader)return c.reader;
 const out=Memory.alloc(Process.pointerSize);out.writePointer(nullPtr);
 const rc=native.open_v2(Memory.allocUtf8String(c.path),out,0x10001,nullPtr);
 const db=out.readPointer();if(rc!==0){if(!db.isNull())native.close_v2(db);throw Error('Read-only open failed: '+rc);}
 internalHandles.add(db.toString());
 try{
  if(c.key){const kr=native.key(db,c.key,c.keyLength);if(kr!==0)throw Error('Native cipher setup failed: '+kr);}
  for(const pragma of c.cipher)sqlQuery(db,pragma,1,true);
  const compression=PROFILE.compression;
  if(compression){const cr=native.create_function(db,Memory.allocUtf8String(compression.scalar_name),compression.argument_count,compression.sqlite_encoding_flags,nullPtr,base.add(compression.scalar_callback_rva),nullPtr,nullPtr);if(cr!==0)throw Error('Native decompression registration failed: '+cr);}
  sqlQuery(db,'SELECT name FROM sqlite_master LIMIT 1',1);
  c.reader=db;c.readable=true;c.error=null;return db;
 }catch(e){internalHandles.delete(db.toString());native.close_v2(db);c.readable=false;c.error=String(e);throw e;}
}
function scanQR(){
 const candidates=[];let bytesScanned=0;
 for(const range of Process.enumerateRanges({protection:'rw-',coalesce:true})){
  if(range.size>100*1024*1024||range.size<512||(range.file&&!range.file.path.includes('wechat')))continue;
  bytesScanned+=range.size;let hits=[];try{hits=Memory.scanSync(range.base,range.size,'89 50 4e 47 0d 0a 1a 0a');}catch(_){}
  for(const hit of hits){try{const p=hit.address;const width=((p.add(16).readU8()<<24)|(p.add(17).readU8()<<16)|(p.add(18).readU8()<<8)|p.add(19).readU8())>>>0;const height=((p.add(20).readU8()<<24)|(p.add(21).readU8()<<16)|(p.add(22).readU8()<<8)|p.add(23).readU8())>>>0;if(width!==height||width<64||width>1024)continue;const n=Math.min(256000,range.size-p.sub(range.base).toUInt32());const end=Memory.scanSync(p,n,'49 45 4e 44 ae 42 60 82');if(end.length){const length=end[0].address.sub(p).toUInt32()+8;candidates.push({bytes:Array.from(new Uint8Array(p.readByteArray(length))),width,height});}}catch(_){} }
 }
 return {candidates,bytes_scanned:bytesScanned};
}
rpc.exports={
 status(){return {sqlite_version:text(native.libversion()),login_view_active:!loginModel.isNull(),revision,databases:connections.size};},
 scanqr:scanQR,
 databases(){enterInternal();try{const unique=new Map();for(const c of connections.values()){const old=unique.get(c.path);if(!old||c.key)unique.set(c.path,c);}return Array.from(unique.values()).map(c=>{try{reader(c);}catch(_){}return {id:c.id,path:c.path,encrypted:!!c.key,readable:c.readable,error:c.error,key_captured:!!c.key,cipher_settings:c.cipher};});}finally{leaveInternal();}},
 query(id,sql,maxRows){if(typeof sql!=='string'||sql.length>65536)throw Error('Invalid SQL');const c=connections.get(id);if(!c)throw Error('Unknown or closed database handle');enterInternal();try{return sqlQuery(reader(c),sql,Math.max(1,Math.min(maxRows||1000,50001)));}finally{leaveInternal();}},
 bootstrap(contexts){enterInternal();let captured=0;try{for(const item of contexts){try{const db=ptr(item.db);const c=discover(db);if(!c)continue;const n=Number(item.len);if(n<1||n>1024)continue;if(c.key)c.key.writeByteArray(new Uint8Array(c.keyLength));c.key=Memory.alloc(n);c.key.writeByteArray(ptr(item.ptr).readByteArray(n));c.keyLength=n;closeReader(c);captured++;}catch(_){}}return {contexts:captured};}finally{leaveInternal(); }},
 dispose(){enterInternal();try{for(const c of connections.values()){closeReader(c);if(c.key)c.key.writeByteArray(new Uint8Array(c.keyLength));}connections.clear();statements.clear();}finally{leaveInternal();}}
};
send({type:'ready',sqlite_version:text(native.libversion())});

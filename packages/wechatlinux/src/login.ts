import {dlopen,FFIType,ptr,toArrayBuffer,CString} from 'bun:ffi';
import type {Pointer} from 'bun:ffi';
import {existsSync} from 'node:fs';
export function savedButton(data:Uint8Array,stride:number){for(const y of [296,318])for(const x of [65,85,210,225]){const offset=y*stride+x*4,b=data[offset],g=data[offset+1],r=data[offset+2];if(!(r<30&&g>=170&&g<=210&&b>=75&&b<=120))return false}return true}
export function resumeSavedAccount(display:string):boolean {
 if(!existsSync('/run/.containerenv')&&!existsSync('/.dockerenv'))throw Error('Container required');
 const p=FFIType.ptr,i=FFIType.i32,u=FFIType.u64;
 const x=dlopen('libX11.so.6',{
  XOpenDisplay:{args:[p],returns:p},XCloseDisplay:{args:[p],returns:i},XDefaultRootWindow:{args:[p],returns:u},
  XQueryTree:{args:[p,u,p,p,p,p],returns:i},XFetchName:{args:[p,u,p],returns:i},XGetGeometry:{args:[p,u,p,p,p,p,p,p,p],returns:i},
  XGetImage:{args:[p,u,i,i,i,i,u,i],returns:p},XDestroyImage:{args:[p],returns:i},XFree:{args:[p],returns:i},XFlush:{args:[p],returns:i}
 });
 const test=dlopen('libXtst.so.6',{XTestFakeMotionEvent:{args:[p,i,i,i,u],returns:i},XTestFakeButtonEvent:{args:[p,i,i,u],returns:i}});
 const d=x.symbols.XOpenDisplay(ptr(Buffer.from(display+'\0')));if(!d){x.close();test.close();return false}
 const root=new BigUint64Array(1),parent=new BigUint64Array(1),children=new BigUint64Array(1),count=new Uint32Array(1);
 try{
  if(!x.symbols.XQueryTree(d,x.symbols.XDefaultRootWindow(d),ptr(root),ptr(parent),ptr(children),ptr(count)))return false;
  if(!children[0])return false;
  const windows=new BigUint64Array(toArrayBuffer(Number(children[0]) as Pointer,0,count[0]*8));
  for(const window of windows){
   const name=new BigUint64Array(1);if(!x.symbols.XFetchName(d,window,ptr(name))||!name[0])continue;
   const title=new CString(Number(name[0])).toString();x.symbols.XFree(Number(name[0]) as Pointer);if(title!=='WeChat')continue;
   const left=new Int32Array(1),top=new Int32Array(1),width=new Uint32Array(1),height=new Uint32Array(1),border=new Uint32Array(1),depth=new Uint32Array(1);
   if(!x.symbols.XGetGeometry(d,window,ptr(root),ptr(left),ptr(top),ptr(width),ptr(height),ptr(border),ptr(depth)))continue;
   if(width[0]!==292||height[0]!==396)continue;
   const image=x.symbols.XGetImage(d,window,0,0,292,396,0xffffffffn,2);if(!image)continue;
   let recognized=false;
   try{const header=new DataView(toArrayBuffer(image,0,64));if(header.getInt32(48,true)!==32)continue;const bytes=Number(header.getBigUint64(16,true)),stride=header.getInt32(44,true);recognized=savedButton(new Uint8Array(toArrayBuffer(bytes as Pointer,0,stride*396)),stride);}finally{x.symbols.XDestroyImage(image)}
   if(recognized){test.symbols.XTestFakeMotionEvent(d,-1,left[0]+146,top[0]+307,0n);test.symbols.XTestFakeButtonEvent(d,1,1,0n);test.symbols.XTestFakeButtonEvent(d,1,0,0n);x.symbols.XFlush(d);return true;}
  }
  return false;
 }finally{if(children[0])x.symbols.XFree(Number(children[0]) as Pointer);x.symbols.XCloseDisplay(d);x.close();test.close();}
}

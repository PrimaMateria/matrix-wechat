import {test,expect} from 'bun:test';
import {savedButton} from '../src/login';
test('saved-account auto-login recognizes the pinned green button, not the QR/confirmation screen',()=>{const stride=292*4,data=new Uint8Array(stride*396);expect(savedButton(data,stride)).toBe(false);for(const y of [296,318])for(const x of [65,85,210,225])data.set([96,193,7,255],y*stride+x*4);expect(savedButton(data,stride)).toBe(true);data[296*stride+65*4+2]=255;expect(savedButton(data,stride)).toBe(false)});

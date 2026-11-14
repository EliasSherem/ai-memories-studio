import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MediaStore } from '../src/media-store.js';
import type { PickedMediaItem } from '../src/google.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=','base64');
const roots:string[]=[];
const stores:MediaStore[]=[];
const MAX_IMAGE_BYTES=1024;
afterEach(async()=>{for(const store of stores.splice(0))store.db.close();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'memories-media-'));roots.push(root);
  const media=new MediaStore(root,{maxImageBytes:MAX_IMAGE_BYTES});stores.push(media);const owner=randomUUID();await media.ensure(owner);
  return {root,media,owner};
}
const item:PickedMediaItem={id:'google-photo-id',type:'PHOTO',createTime:'2020-01-01T00:00:00Z',mediaFile:{baseUrl:'https://lh3.googleusercontent.com/private-short-lived',mimeType:'image/png',filename:'../../bad\u0000name.png',mediaFileMetadata:{width:1,height:1}}};
function options() {return {remainingBytes:500*1024*1024,signal:new AbortController().signal,onBytes:()=>{}};}
function image(body:ConstructorParameters<typeof Response>[0]=png,headers:Record<string,string>={}) {return new Response(body,{headers:{'content-type':'image/png',...headers}});}

describe('private streamed media storage',()=>{
  it('uses safe generated paths, private URLs and durable metadata without remote base URLs',async()=>{
    const {media,root,owner}=await fixture();
    const asset=await media.import(owner,'person1',item,image(),options());
    expect(asset.filename).toBe('badname.png');expect(asset.url).toBe(`/api/projects/${owner}/assets/${asset.id}/content`);
    const files=await readdir(path.join(root,owner));
    expect(files).toEqual(expect.arrayContaining(['metadata.json',`${asset.id}.png`]));
    expect(files).toHaveLength(3);
    const metadata=await readFile(path.join(root,owner,`${asset.id}.metadata.json`),'utf8');
    expect(metadata).not.toContain('baseUrl');expect(metadata).not.toContain('googleusercontent');
    expect(metadata).toContain('google-photo-id');const {duplicate:_duplicate,...publicAsset}=asset;expect((await media.project(owner)).assets).toEqual([publicAsset]);
    await expect(media.content(randomUUID(),owner,asset.id)).rejects.toMatchObject({status:404});
    expect((await media.content(owner,owner,asset.id)).file).toBe(path.join(root,owner,`${asset.id}.png`));
    await media.select(owner,owner,asset.id,false);
    expect((await media.project(owner)).assets[0].selected).toBe(false);
    await media.delete(owner,owner,asset.id);
    expect((await media.project(owner)).assets).toEqual([]);expect(await readdir(path.join(root,owner))).toEqual(['metadata.json']);
  });
  it('rejects oversized Content-Length, MIME mismatches, and forged image signatures',async()=>{
    const {media,root,owner}=await fixture();
    await expect(media.import(owner,'person1',item,image(png,{'content-length':String(MAX_IMAGE_BYTES+1)}),options())).rejects.toMatchObject({code:'IMAGE_TOO_LARGE'});
    await expect(media.import(owner,'person1',item,image(png,{'content-type':'image/svg+xml'}),options())).rejects.toMatchObject({code:'UNSUPPORTED_IMAGE'});
    await expect(media.import(owner,'person1',item,image('<html>not a png</html>'),options())).rejects.toMatchObject({code:'INVALID_IMAGE'});
    expect(await readdir(path.join(root,owner))).toEqual(['metadata.json']);
  });
  it('enforces limits on chunked downloads and removes partial bytes on abort',async()=>{
    const {media,root,owner}=await fixture();
    const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(png);controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES));controller.close();}});
    await expect(media.import(owner,'person1',item,image(stream),options())).rejects.toMatchObject({code:'IMAGE_TOO_LARGE'});
    const controller=new AbortController();controller.abort();
    await expect(media.import(owner,'person1',item,image(),{...options(),signal:controller.signal})).rejects.toMatchObject({name:'AbortError'});
    expect(await readdir(path.join(root,owner))).toEqual(['metadata.json']);
  });
});

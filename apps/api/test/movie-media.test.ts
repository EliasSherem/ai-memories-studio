import {afterEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {stat,utimes,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {MovieMedia} from '../src/movie-media.js';
import {movieFixture} from './movie-fixture.js';
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(){const f=await movieFixture();cleanups.push(f.dispose);return f;}

describe('P5 private media reconciliation',()=>{
 it('cleans dead uploads and orphan audio after restart while preserving referenced tracks and active uploads',async()=>{
  const f=await fixture(),dead=randomUUID(),active=randomUUID(),orphan=randomUUID(),trackFile=randomUUID(),trackId=randomUUID(),unknownPartial=randomUUID(),unknownAudio=randomUUID();
  const directory=f.movieMedia.directory(f.owner);await f.movieMedia.ensure(f.owner);
  await writeFile(join(directory,`.upload-${dead}`),'dead partial');await writeFile(f.movieMedia.file(f.owner,`${dead}.mp3`),'rename before upload ledger checkpoint');await writeFile(join(directory,`.upload-${active}`),'live partial');await writeFile(join(directory,`.upload-${unknownPartial}`),'orphan partial');
  const old=new Date(Date.now()-11*60*1000);await utimes(join(directory,`.upload-${unknownPartial}`),old,old);await writeFile(f.movieMedia.file(f.owner,`${unknownAudio}.wav`),'unrecorded old audio');await utimes(f.movieMedia.file(f.owner,`${unknownAudio}.wav`),old,old);
  f.insert('movie_media_reservations',{id:dead,project_id:f.owner,bytes:1024,created_at:0,writer_pid:null,kind:'upload'});
  f.insert('movie_media_reservations',{id:active,project_id:f.owner,bytes:1024,created_at:Date.now(),writer_pid:process.pid,kind:'upload'});
  for(const id of[orphan,trackFile]){await writeFile(f.movieMedia.file(f.owner,`${id}.mp3`),Buffer.from('ID3synthetic stored audio'));f.insert('movie_media_files',{project_id:f.owner,storage_name:`${id}.mp3`,bytes:25,sha256:`synthetic-${id}`,mime_type:'audio/mpeg',writer_pid:null,created_at:0});}
  f.insert('movie_soundtracks',{id:trackId,project_id:f.owner,storage_name:`${trackFile}.mp3`,name:'Retained licensed track',mime_type:'audio/mpeg',bytes:25,sha256:`synthetic-${trackFile}`,duration_seconds:10,instrumental:1,licensed:1,onsets_json:'[]',created_at:new Date().toISOString()});
  const restarted=new MovieMedia(f.media,f.config);await restarted.reconcileUploads();
  await expect(stat(join(directory,`.upload-${dead}`))).rejects.toMatchObject({code:'ENOENT'});await expect(stat(f.movieMedia.file(f.owner,`${dead}.mp3`))).rejects.toMatchObject({code:'ENOENT'});await expect(stat(join(directory,`.upload-${unknownPartial}`))).rejects.toMatchObject({code:'ENOENT'});await expect(stat(f.movieMedia.file(f.owner,`${orphan}.mp3`))).rejects.toMatchObject({code:'ENOENT'});await expect(stat(f.movieMedia.file(f.owner,`${unknownAudio}.wav`))).rejects.toMatchObject({code:'ENOENT'});
  expect((await stat(join(directory,`.upload-${active}`))).isFile()).toBe(true);expect((await stat(f.movieMedia.file(f.owner,`${trackFile}.mp3`))).isFile()).toBe(true);
  expect(f.media.db.connection.prepare('SELECT id FROM movie_media_reservations').all()).toEqual([{id:active}]);expect(f.movieStore.soundtracks(f.owner).map(track=>track.id)).toEqual([trackId]);expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it('counts existing photos and P4 clips before reserving movie disk quota',async()=>{
  const f=await fixture();expect(f.movieMedia.storedBytes()).toBeGreaterThan(0);await expect(f.movieMedia.preflight(f.media.storageQuotaBytes-f.movieMedia.storedBytes()+1)).rejects.toMatchObject({code:'STORAGE_QUOTA_EXCEEDED'});
  expect(f.media.db.connection.prepare('SELECT COUNT(*) count FROM movie_media_reservations').get()).toMatchObject({count:0});
 });
});

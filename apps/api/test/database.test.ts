import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StudioDatabase } from '../src/database.js';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

describe('persistent private SQLite state',()=>{
  it('persists encrypted temporary capabilities and transactional checkpoints',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'memories-sqlite-'));roots.push(root);
    const file=path.join(root,'studio.sqlite');
    const database=new StudioDatabase(file,'test-only-encryption-key');
    database.connection.exec('CREATE TABLE test_capabilities(id INTEGER PRIMARY KEY,value TEXT NOT NULL)');
    const capability='https://lh3.googleusercontent.com/private-temporary-media';
    database.connection.prepare('INSERT INTO test_capabilities(id,value) VALUES(1,?)').run(database.seal(capability));
    expect(()=>database.transaction(()=>{
      database.connection.prepare('INSERT INTO test_capabilities(id,value) VALUES(2,?)').run('rolled-back');
      throw new Error('Simulated interruption');
    })).toThrow('Simulated interruption');
    expect(database.connection.prepare('SELECT * FROM test_capabilities WHERE id=2').get()).toBeUndefined();
    database.close();
    const bytes=await readFile(file);
    expect(bytes.includes(Buffer.from(capability))).toBe(false);
    expect((await stat(root)).mode&0o777).toBe(0o700);
    expect((await stat(file)).mode&0o777).toBe(0o600);
    const reopened=new StudioDatabase(file,'test-only-encryption-key');
    const row=reopened.connection.prepare('SELECT value FROM test_capabilities WHERE id=1').get() as {value:string};
    expect(reopened.unseal(row.value)).toBe(capability);
    reopened.close();
  });

  it('allows only one live coordinator and fences an expired worker',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'memories-lease-'));roots.push(root);
    const first=new StudioDatabase(path.join(root,'studio.sqlite'),'test-key');
    const second=new StudioDatabase(path.join(root,'studio.sqlite'),'test-key');
    const now=Date.now();
    expect(first.acquireLease('first',now)).toBe(true);
    expect(second.acquireLease('second',now)).toBe(false);
    expect(first.leaseOwned('first',now)).toBe(true);
    expect(second.acquireLease('second',now+10001)).toBe(true);
    expect(first.leaseOwned('first',now+10001)).toBe(false);
    first.releaseLease('first');
    expect(second.leaseOwned('second',now+10001)).toBe(true);
    second.releaseLease('second');
    expect(first.acquireLease('first',now+10002)).toBe(true);
    first.close();second.close();
  });
});

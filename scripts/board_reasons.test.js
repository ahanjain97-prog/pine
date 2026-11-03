import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { openDb } from '../src/db.js';
import { addRole, moveOnBoard, copyToRole } from '../src/lib/board.js';
import { mergePlayer } from '../src/lib/ncaa.js';
import { boardLastReviews } from '../src/lib/review.js';
import { addBoardRole, setBoardStar, removeBoardRole, moveBoardCard, validateBoardReason, recordBoardReason, boardHistory, registerBoardMoves, BOARD_EXIT_REASONS } from '../src/lib/board_reasons.js';

const add = { source: 'Search: Video', why: 'Fits the role in this synthetic example.' };
const promote = { why: 'Prioritize this example.' };
const exit = { exit_reason: 'Data review' };
function setup(t) {
  const db = openDb(':memory:'); t.after(()=>db.raw.close());
  for (const id of [1,2,3]) db.run("INSERT INTO players(id,name,created_at) VALUES (?,?,'2026-01-01 00:00:00')",id,`Example ${id}`);
  return db;
}

test('add, promote, drop back and take off are audited once with actor, role and persistent history', t=>{
  const db=setup(t);
  addBoardRole(db,1,'FWD1',add,2);
  const addId=db.get('SELECT reason_id FROM board_entries WHERE player_id=1').reason_id;
  setBoardStar(db,1,'FWD1',true,promote,2);
  assert.notEqual(db.get('SELECT reason_id FROM board_entries WHERE player_id=1').reason_id,addId);
  setBoardStar(db,1,'FWD1',false,exit,3);
  removeBoardRole(db,1,'FWD1',{exit_reason:'Other',note:'Example availability changed.'},1);
  assert.equal(db.get('SELECT count(*) n FROM board_entries').n,0);
  const history=boardHistory(db,1);
  assert.deepEqual(history.map(r=>r.kind),['take_off','drop_back','promote','add']);
  assert.equal(history.at(-1).user_id,2);
  assert.equal(history.at(-1).role,'FWD1');assert.ok(history.at(-1).created_at);
  const acts=db.all('SELECT * FROM activity ORDER BY id');
  assert.deepEqual(acts.map(r=>r.action),['added_role','shortlisted','unshortlisted','removed_role']);
  assert.equal(JSON.parse(acts[0].detail).reason.source,add.source);
  assert.equal(JSON.parse(acts[3].detail).reason.note,'Example availability changed.');
  assert.equal(boardLastReviews(db).size,0); // player remains tracked, no board spot
});

test('validation rejects missing/blank text, source choices and incomplete exits before any write', t=>{
  const db=setup(t);
  for (const reason of [undefined,{},[],{...add,why:'   '},{...add,source:null},{...add,source:'made up'},{...add,why:{}},{...add,why:'x'.repeat(4001)}]) {
    assert.throws(()=>addBoardRole(db,1,'FWD1',reason,1));
    assert.equal(db.get('SELECT count(*) n FROM board_entries').n,0);
    assert.equal(db.get('SELECT count(*) n FROM board_reasons').n,0);
  }
  addBoardRole(db,1,'FWD1',add,1);
  assert.throws(()=>setBoardStar(db,1,'FWD1',true,{},1));
  setBoardStar(db,1,'FWD1',true,promote,1);
  for(const reason of [undefined,{}, {exit_reason:'invalid'}, {exit_reason:'Other',note:'  '}]) {
    assert.throws(()=>setBoardStar(db,1,'FWD1',false,reason,1));
    assert.throws(()=>removeBoardRole(db,1,'FWD1',reason,1));
    assert.equal(db.get('SELECT shortlist FROM board_entries').shortlist,1);
  }
  for(const choice of BOARD_EXIT_REASONS)assert.equal(validateBoardReason('take_off',{exit_reason:choice,note:'Example'}).exit_reason,choice);
  assert.throws(()=>setBoardStar(db,1,'FWD1','false',exit,1));
});

test('no-op retries do not create reasons or reviews; automated helpers need none', t=>{
  const db=setup(t);addRole(db,1,'FWD1');
  assert.equal(addBoardRole(db,1,'FWD1',undefined,1),false);
  assert.equal(setBoardStar(db,1,'FWD1',false,undefined,1),false);
  assert.equal(removeBoardRole(db,2,'FWD1',undefined,1),false);
  moveOnBoard(db,1,'FWD1','FWD2',0);copyToRole(db,1,'FWD3',0);
  assert.equal(db.get('SELECT count(*) n FROM board_reasons').n,0);
  assert.equal(db.get('SELECT count(*) n FROM activity').n,0);
});

test('copy needs an add reason for a new role and a promotion reason for an existing unstarred role', t=>{
  const db=setup(t);addBoardRole(db,1,'FWD1',add,1);setBoardStar(db,1,'FWD1',true,promote,1);
  assert.throws(()=>moveBoardCard(db,1,{from_role:'FWD1',to_role:'FWD2',copy:true},1));
  moveBoardCard(db,1,{from_role:'FWD1',to_role:'FWD2',copy:true,reason:add},2);
  assert.deepEqual(db.all('SELECT role,shortlist FROM board_entries ORDER BY role').map(r=>[r.role,r.shortlist]),[['FWD1',1],['FWD2',1]]);
  assert.equal(boardHistory(db,1)[0].kind,'add');
  addRole(db,1,'FWD3');
  assert.throws(()=>moveBoardCard(db,1,{from_role:'FWD1',to_role:'FWD3',copy:true},1));
  moveBoardCard(db,1,{from_role:'FWD1',to_role:'FWD3',copy:true,reason:promote},1);
  assert.equal(boardHistory(db,1)[0].kind,'promote');
  const n=boardHistory(db,1).length;
  moveBoardCard(db,1,{from_role:'FWD1',to_role:'FWD3',copy:true},1);
  assert.equal(boardHistory(db,1).length,n);
});

test('reorders preserve flags and reason links for every card; transfers carry context without a new reason', t=>{
  const db=setup(t);
  addBoardRole(db,1,'FWD1',add,1);setBoardStar(db,1,'FWD1',true,promote,1);
  addBoardRole(db,2,'FWD1',add,1);
  const pointer=db.get('SELECT reason_id FROM board_entries WHERE player_id=1').reason_id;
  moveBoardCard(db,2,{from_role:'FWD1',to_role:'FWD1',index:0},1);
  assert.equal(db.get('SELECT reason_id FROM board_entries WHERE player_id=1').reason_id,pointer);
  moveBoardCard(db,1,{from_role:'FWD1',to_role:'FWD2',index:0},1);
  const moved=db.get('SELECT * FROM board_entries WHERE player_id=1');
  assert.equal(moved.role,'FWD2');assert.equal(moved.shortlist,1);assert.equal(moved.reason_id,pointer);
  assert.equal(boardHistory(db,1).length,2);
  // Transferring an unstarred role onto an already starred one must not silently remove its star.
  addRole(db,1,'FWD3');moveBoardCard(db,1,{from_role:'FWD3',to_role:'FWD2',index:0},1);
  assert.equal(db.get('SELECT shortlist FROM board_entries WHERE player_id=1').shortlist,1);
});

test('missing or forged starting roles cannot bypass reasons; multi-role creation and audit failures roll back', t=>{
  const db=setup(t);
  assert.throws(()=>moveBoardCard(db,1,{from_role:'FWD1',to_role:'FWD2'},1));
  assert.throws(()=>moveBoardCard(db,1,{to_role:'FWD2'},1));
  assert.equal(db.get('SELECT count(*) n FROM board_entries').n,0);
  db.raw.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT,'audit failure'); END");
  assert.throws(()=>db.tx(()=>{addBoardRole(db,1,'FWD1',add,1);addBoardRole(db,1,'FWD2',add,1);}),/audit failure/);
  assert.equal(db.get('SELECT count(*) n FROM board_entries').n,0);
  assert.equal(db.get('SELECT count(*) n FROM board_reasons').n,0);
});

test('tracking reason is optional and merges retain recorded history', t=>{
  const db=setup(t);
  assert.equal(validateBoardReason('track'),null);assert.equal(validateBoardReason('track',{}),null);
  const reason=validateBoardReason('track',{source:'Referral: Agent',why:'Track the example.'});
  recordBoardReason(db,2,null,'track',reason,2);
  addBoardRole(db,2,'FWD1',add,2);
  mergePlayer(db,2,1);
  assert.equal(boardHistory(db,1).length,2);
  assert.equal(boardHistory(db,2).length,0);
  removeBoardRole(db,1,'FWD1',exit,1);
  assert.equal(boardHistory(db,1).length,3);
});

test('existing databases migrate with no backfill and retain reasons on reopen',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pine-board-reasons-'));
  try {
    const file=join(dir,'pine.db'), old=openDb(file);
    old.run("INSERT INTO players(id,name) VALUES (1,'Example')");addRole(old,1,'FWD1');
    old.raw.exec('ALTER TABLE board_entries DROP COLUMN reason_id; DROP TABLE board_reasons');old.raw.close();
    const db=openDb(file);
    assert.equal(db.get('SELECT reason_id FROM board_entries').reason_id,null);
    assert.equal(db.get('SELECT count(*) n FROM board_reasons').n,0);
    setBoardStar(db,1,'FWD1',true,promote,1);db.raw.close();
    const again=openDb(file);assert.equal(boardHistory(again,1).length,1);again.raw.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('all four board API routes enforce reasons and staff identity',async t=>{
  const db=setup(t),app=new Hono();
  app.onError((e,c)=>c.json({error:e.message},e.status||500));
  app.use('*',async(c,next)=>{if(c.req.header('Test-User'))c.set('user',{id:2});await next();});
  registerBoardMoves(app,{db,getPlayer:id=>{const p=db.get('SELECT * FROM players WHERE id=?',Number(id));if(!p)throw Object.assign(new Error('Not found'),{status:404});return p;}});
  const request=(method,url,body,staff=true)=>app.request(url,{method,headers:{'Content-Type':'application/json',...(staff?{'Test-User':'1'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await request('POST','/api/players/1/roles',{role:'FWD1',reason:add},false)).status,401);
  assert.equal((await request('POST','/api/players/1/roles',{role:'FWD1'})).status,400);
  assert.equal((await request('POST','/api/board/move',{player_id:1,to_role:'FWD1'})).status,400);
  assert.equal((await request('POST','/api/players/1/roles',{role:'FWD1',reason:{...add,user_id:3,created_at:'1900-01-01'}})).status,200);
  assert.equal((await request('POST','/api/board/shortlist',{player_id:1,role:'FWD1',on:true})).status,400);
  assert.equal((await request('POST','/api/board/shortlist',{player_id:1,role:'FWD1',on:true,reason:promote})).status,200);
  assert.equal((await request('POST','/api/board/shortlist',{player_id:1,role:'FWD1',on:false})).status,400);
  assert.equal((await request('DELETE','/api/players/1/roles/FWD1')).status,400);
  assert.equal((await request('DELETE','/api/players/1/roles/FWD1',{reason:{exit_reason:'Unwilling to play in League One'}})).status,200);
  assert.equal(boardHistory(db,1).length,3);assert.equal(boardHistory(db,1).at(-1).user_id,2);
});

test('merging overlapping roles preserves the newer reason without inventing a move',t=>{
  const db=setup(t);
  addBoardRole(db,1,'FWD1',add,1);
  addBoardRole(db,2,'FWD1',{...add,why:'Newer synthetic explanation.'},2);
  const newer=db.get('SELECT reason_id FROM board_entries WHERE player_id=2').reason_id;
  mergePlayer(db,2,1);
  assert.equal(boardHistory(db,1).length,2);
  assert.equal(db.get('SELECT reason_id FROM board_entries WHERE player_id=1').reason_id,newer);
});

test('source menu values are validated without allowing inherited object keys as roles',t=>{
  const db=setup(t);
  for(const source of ['Search: Data screen','Search: Video','Search: NCAA database','Search: Live','Search: Other scouting','Referral: Staff','Referral: Agent','Referral: Contact'])assert.equal(validateBoardReason('add',{...add,source}).source,source);
  for(const role of ['__proto__','constructor',{},['FWD1']]) {
    assert.throws(()=>addBoardRole(db,1,role,add,1));
    assert.throws(()=>moveBoardCard(db,1,{from_role:role,to_role:'FWD1',reason:add},1),e=>e.status===400);
  }
  assert.equal(db.get('SELECT count(*) n FROM board_entries').n,0);
});

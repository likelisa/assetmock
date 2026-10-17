import Database from 'better-sqlite3';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { advance, choose, initialState } from '../../domain/v2/engine';
import { toPublic } from '../../domain/v2/presentation';
import type { ChoiceRecord, Draws, Run, Selection, Setup } from '../../domain/v2/types';
import { ServiceError } from '../store';
export function tapeFor(months: number): Draws[] {
  return Array.from({ length: months }, () => ({ medical: randomInt(1000000), jobLoss: randomInt(1000000), bonusDelay: randomInt(1000000), marketDrop: randomInt(1000000), career: randomInt(1000000) }));
}
export function makeRun(sessionId: string, setup: Setup, options?: { tape?: Draws[]; inherited?: ChoiceRecord[]; parentId?: string }): Run {
  const tape = options?.tape ?? tapeFor(setup.rules.months);
  if (tape.length !== setup.rules.months) throw new Error('随机记录长度无效');
  const initial = initialState(setup);
  return structuredClone({ schemaVersion: 2, id: randomUUID(), sessionId, createdAt: new Date().toISOString(), setup, tape, initial, state: initial, history: [], version: 0, status: 'running', inherited: options?.inherited ?? [], notices: [], parentId: options?.parentId, stageStart: 0, stopReason: setup.input.custom ? '行动方案已确认，准备开始人生' : '已完成购置，准备开始人生' });
}
export class V2Store {
  private db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new Database(path); this.db.pragma('journal_mode=WAL'); this.db.pragma('busy_timeout=5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS v2_runs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS v2_requests(run_id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(run_id,key));');
  }
  create(session: string, setup: Setup, options?: Parameters<typeof makeRun>[2]) {
    const run = makeRun(session, setup, options);
    this.db.prepare('INSERT INTO v2_runs VALUES(?,?,?,?)').run(run.id, session, JSON.stringify(run), 0); return run;
  }
  get(id: string, session: string): Run {
    const row = this.db.prepare('SELECT body FROM v2_runs WHERE id=? AND session_id=?').get(id, session) as { body: string } | undefined;
    if (!row) throw new ServiceError(404, '找不到当前会话的游戏。');
    return JSON.parse(row.body);
  }
  mutate(id: string, session: string, expectedVersion: number, key: string, action: { kind: 'advance'; single?: boolean } | { kind: 'choose'; selections: Selection[] }) {
    return this.db.transaction(() => {
      const run = this.get(id, session);
      const fingerprint = JSON.stringify({ expectedVersion, action });
      const cached = this.db.prepare('SELECT fingerprint,response FROM v2_requests WHERE run_id=? AND key=?').get(id, key) as { fingerprint: string; response: string } | undefined;
      if (cached) { if (cached.fingerprint !== fingerprint) throw new ServiceError(409, '请求标识已用于其他操作'); return JSON.parse(cached.response) as ReturnType<typeof toPublic>; }
      if (run.version !== expectedVersion || run.status === 'ended') throw new ServiceError(409, '进度已更新或游戏已结束，请重新载入。');
      try { if (action.kind === 'advance') advance(run, action.single); else choose(run, action.selections); }
      catch (e) { throw new ServiceError(422, e instanceof Error ? e.message : '操作无效'); }
      const result = this.db.prepare('UPDATE v2_runs SET body=?,version=? WHERE id=? AND version=?').run(JSON.stringify(run), run.version, id, expectedVersion);
      if (result.changes !== 1) throw new ServiceError(409, '状态冲突，请同步进度');
      const view = toPublic(run);
      this.db.prepare('INSERT INTO v2_requests VALUES(?,?,?,?)').run(id, key, fingerprint, JSON.stringify(view)); return view;
    }).immediate();
  }
  purgeWorkspace(workspaceId: string) {
    const prefix = `integrated:${workspaceId}:`;
    this.db.pragma('secure_delete=ON');
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM v2_requests WHERE run_id IN (SELECT id FROM v2_runs WHERE substr(session_id,1,?)=?)').run(prefix.length,prefix);
      this.db.prepare('DELETE FROM v2_runs WHERE substr(session_id,1,?)=?').run(prefix.length,prefix);
      for (const table of ['ai_records','search_documents','web_offers']) {
        if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) this.db.prepare(`DELETE FROM ${table} WHERE substr(session_id,1,?)=?`).run(prefix.length,prefix);
      }
    })();
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }
  close() { this.db.close(); }
}
const globalV2 = globalThis as unknown as { lifeV2?: V2Store };
export const v2Store = () => globalV2.lifeV2 ??= new V2Store(process.env.DATABASE_PATH || './data/life-simulator.sqlite');

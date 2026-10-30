// Copyright 2026 SeohoKim
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from 'react';
import { historyLoop } from '../domain/loop-history.ts';
import type { HistoryMode, LoopHistory } from '../domain/loop-history.ts';
import type { HistoryList } from '../application/history-ipc.ts';
import { HISTORY_SEARCH_LENGTH } from '../application/history-ipc.ts';
import { LoopProgress } from './LoopProgress.tsx';

const modes: Record<HistoryMode, string> = { auto: '자동', single: '단일 AI', manual: '직접 협업' };
const date = (value: string) => new Date(value).toLocaleString('ko-KR', { hour12: false });

export function History() {
  const [list, setList] = useState<HistoryList>({ items: [], partial: false });
  const [detail, setDetail] = useState<LoopHistory>();
  const [confirm, setConfirm] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState<string>();
  const [searching, setSearching] = useState(false);
  const revision = useRef(0);
  const ready = useRef(false);
  const active = useRef(true);
  const lock = useRef(false);
  async function refresh() {
    if (lock.current) return;
    revision.current++; ready.current = false; setSearching(false);
    lock.current = true; setBusy(true); setError(undefined);
    try {
      const reply = await window.seohoKimLoop?.listHistory();
      if (!active.current) return;
      if (!reply?.ok) { setList({ items: [], partial: false }); setError('기록을 불러오지 못했습니다.'); }
      else { setList(reply.value); setAppliedQuery(''); ready.current = true; }
    } catch { if (active.current) setError('기록을 불러오지 못했습니다.'); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  useEffect(() => { active.current = true; void refresh(); return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (busy || !ready.current) return;
    const current = ++revision.current;
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const reply = await window.seohoKimLoop?.listHistory({ query });
          if (!active.current || current !== revision.current) return;
          if (reply?.ok) { setList(reply.value); setAppliedQuery(query); }
          else { setList({ items: [], partial: false }); setError('기록을 불러오지 못했습니다.'); }
        } catch { if (active.current && current === revision.current) setError('기록을 불러오지 못했습니다.'); }
        finally { if (active.current && current === revision.current) setSearching(false); }
      })();
    }, 150);
    return () => { clearTimeout(timer); revision.current++; };
  }, [query, busy]);
  function changeQuery(value: string) {
    revision.current++;
    setQuery(value); setConfirm(undefined); setDetail(undefined);
    if (ready.current) setError(undefined);
  }
  const filtering = searching || (!error && appliedQuery !== query);
  const items = appliedQuery === query ? list.items : [];
  async function open(id: string) {
    if (lock.current) return;
    revision.current++;
    lock.current = true; setBusy(true); setDetail(undefined); setError(undefined); setConfirm(undefined);
    try {
      const reply = await window.seohoKimLoop?.getHistory(id);
      if (!active.current) return;
      if (reply?.ok) setDetail(reply.value); else setError('선택한 기록을 불러오지 못했습니다.');
    } catch { if (active.current) setError('선택한 기록을 불러오지 못했습니다.'); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  async function remove(id: string) {
    if (lock.current || confirm !== id) return;
    revision.current++;
    lock.current = true; setBusy(true); setError(undefined);
    try {
      const reply = await window.seohoKimLoop?.deleteHistory(id);
      if (!active.current) return;
      if (!reply?.ok) { setError('기록을 삭제하지 못했습니다.'); return; }
      setDetail((current) => current?.id === id ? undefined : current);
      setConfirm(undefined);
      const refreshed = await window.seohoKimLoop?.listHistory();
      if (!active.current) return;
      if (refreshed?.ok) { setList(refreshed.value); setAppliedQuery(''); ready.current = true; }
      else { setList((current) => ({ ...current, items: current.items.filter((item) => item.id !== id) })); setError('기록 목록을 다시 불러오지 못했습니다.'); }
    } catch { if (active.current) setError('기록을 삭제하지 못했습니다.'); }
    finally { lock.current = false; if (active.current) setBusy(false); }
  }
  return <section className="history-page" aria-labelledby="history-title" data-testid="history">
    <div className="connections-toolbar">
      <div><h1 id="history-title">작업 기록</h1><p>완료한 작업을 이 PC에서 다시 확인합니다.</p></div>
      <button className="secondary-button" type="button" disabled={busy || searching} onClick={() => void refresh()}>기록 새로고침</button>
    </div>
    <div className="history-search">
      <label htmlFor="history-search">기록 검색</label>
      <div className="history-search-controls">
        <input id="history-search" type="search" placeholder="제목 또는 요청 검색" value={query} maxLength={HISTORY_SEARCH_LENGTH}
          disabled={busy} onChange={(event) => changeQuery(event.target.value)} autoComplete="off" />
        <button className="secondary-button" type="button" disabled={busy || !query} onClick={() => changeQuery('')}>검색어 지우기</button>
      </div>
    </div>
    {(busy || filtering) && <p role="status">기록을 불러오는 중…</p>}
    {error && <p className="error-message" role="alert">{error}</p>}
    {list.partial && <p className="error-message" role="alert">일부 기록을 불러오지 못했습니다.</p>}
    {!busy && !filtering && !error && items.length === 0 && ((list.total ?? 0) > 0 || !list.partial)
      && <p className="card history-empty">{(list.total ?? 0) > 0 ? '검색 결과가 없습니다.' : '아직 저장된 작업이 없습니다.'}</p>}
    <div className="history-list">
      {items.map((item) => <article className="card history-card" key={item.id} data-history-id={item.id} aria-label={item.title}>
        <h2>{item.title}</h2>
        <p>{date(item.completedAt)} 완료 · {modes[item.executionMode]} · {item.stepCount}단계</p>
        <p>{item.providers.map((provider) => provider.displayName).join(' · ')}</p>
        <div className="connection-actions">
          <button className="secondary-button" type="button" disabled={busy || filtering} onClick={() => void open(item.id)}>기록 열기</button>
          <button className="secondary-button" type="button" disabled={busy || filtering} onClick={() => setConfirm(item.id)}>기록 삭제</button>
        </div>
        {confirm === item.id && <div className="history-confirm" role="group" aria-label="기록 삭제 확인">
          <p>이 기록을 삭제할까요? 삭제한 기록은 앱에서 복원할 수 없습니다.</p>
          <div className="connection-actions">
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void remove(item.id)}>삭제 확인</button>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => setConfirm(undefined)}>취소</button>
          </div>
        </div>}
      </article>)}
    </div>
    {detail && <section className="history-detail" aria-labelledby="history-detail-title" data-testid="history-detail">
      <h2 id="history-detail-title">{detail.title}</h2>
      <p>{modes[detail.executionMode]} · {date(detail.startedAt)} 시작 · {date(detail.completedAt)} 완료</p>
      <LoopProgress loop={historyLoop(detail)} idPrefix="history-" />
    </section>}
  </section>;
}

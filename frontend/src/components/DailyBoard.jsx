import { useCallback, useEffect, useRef, useState } from 'react';

const REFRESH_MS = 60000;

function formatTime(date) {
  return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function DailyBoard({ endpoint }) {
  const [rows, setRows] = useState([]);
  const [today, setToday] = useState('');
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [auto, setAuto] = useState(true);
  const timerRef = useRef(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setStatus((s) => (s === 'ready' ? 'ready' : 'loading'));
      try {
        const res = await fetch(endpoint, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setRows(Array.isArray(data.students) ? data.students : []);
        setToday(data.today || '');
        setLastUpdated(new Date());
        setStatus('ready');
        setError('');
      } catch (err) {
        setError(err.message || 'Veri alınamadı.');
        setStatus((s) => (s === 'ready' ? 'ready' : 'error'));
      }
    },
    [endpoint]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!auto) {
      if (timerRef.current) clearInterval(timerRef.current);
      return undefined;
    }
    timerRef.current = setInterval(() => load(true), REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, [auto, load]);

  const totals = rows.reduce(
    (acc, r) => {
      acc.due += r.dueCount || 0;
      acc.done += r.doneCount || 0;
      acc.questions += r.questionCount || 0;
      return acc;
    },
    { due: 0, done: 0, questions: 0 }
  );

  return (
    <div>
      <div className="row space-between center" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
        <p className="muted" style={{ margin: 0 }}>
          {today ? `Gün: ${today}` : ''}
          {lastUpdated ? ` - Son güncelleme ${formatTime(lastUpdated)}` : ''}
          {status === 'error' && error ? ` - ${error}` : ''}
        </p>
        <div className="row center" style={{ gap: 8 }}>
          <label className="row center" style={{ gap: 6, fontWeight: 600 }}>
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
            />
            Otomatik yenile
          </label>
          <button type="button" className="button-link" onClick={() => load(false)}>
            Yenile
          </button>
        </div>
      </div>

      {status === 'loading' && rows.length === 0 ? (
        <p className="muted">Yükleniyor...</p>
      ) : status === 'error' && rows.length === 0 ? (
        <p className="muted">{error || 'Veri alınamadı.'}</p>
      ) : rows.length === 0 ? (
        <p className="muted">Kayitli öğrenci yok.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Öğrenci</th>
                <th>Bugün Görev</th>
                <th>Tamamlanan</th>
                <th>Günlük Soru</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const complete = row.dueCount > 0 && row.doneCount >= row.dueCount;
                return (
                  <tr key={row.id}>
                    <td>{row.name}</td>
                    <td>{row.dueCount}</td>
                    <td>
                      <span className={`status-pill ${complete ? 'ok' : row.doneCount > 0 ? 'idle' : 'bad'}`}>
                        {row.doneCount}/{row.dueCount}
                      </span>
                    </td>
                    <td>{row.questionCount}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ fontWeight: 700 }}>Toplam</td>
                <td style={{ fontWeight: 700 }}>{totals.due}</td>
                <td style={{ fontWeight: 700 }}>{totals.done}</td>
                <td style={{ fontWeight: 700 }}>{totals.questions}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

"""SQLite storage for simulation runs: one row per run, its per-combination results and daily yard stock."""
from __future__ import annotations

import json
import os
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(os.environ.get('JETTY_DB', Path(__file__).resolve().parent.parent / 'data' / 'jetty.db'))

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    start_date    TEXT    NOT NULL,
    inputs_json   TEXT    NOT NULL,
    n_combos      INTEGER NOT NULL,
    n_feasible    INTEGER NOT NULL,
    duration_s    REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS run_results (
    run_id            INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    imp_mix           TEXT    NOT NULL,
    exp_mix           TEXT    NOT NULL,
    slab_mix          TEXT    NOT NULL DEFAULT '',
    eligible          INTEGER NOT NULL,
    feasible          INTEGER NOT NULL,
    imported_t        REAL,
    exported_t        REAL,
    imp_calls         INTEGER,
    exp_calls         INTEGER,
    berth_occ_pct     REAL,
    quay_occ_pct      REAL,
    berths            INTEGER,
    avg_turnaround_h  REAL,
    avg_waiting_h     REAL,
    stockout_h        REAL,
    fg_full_h         REAL,
    below_safety_h    REAL,
    lost_t            REAL,
    produced_t        REAL,
    min_rm_t          REAL,
    max_rm_t          REAL,
    max_fg_t          REAL,
    end_rm_t          REAL,
    end_fg_t          REAL,
    first_arrival_h   REAL,
    first_departure_h REAL,
    carried           INTEGER,
    slab_exported_t   REAL,
    slab_calls        INTEGER,
    slab_full_h       REAL,
    max_slab_t        REAL,
    end_slab_t        REAL,
    first_slab_dep_h  REAL,
    reasons_json      TEXT    NOT NULL,
    warnings_json     TEXT    NOT NULL,
    PRIMARY KEY (run_id, imp_mix, exp_mix, slab_mix)
);

CREATE TABLE IF NOT EXISTS run_daily_stock (
    run_id   INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    imp_mix  TEXT    NOT NULL,
    exp_mix  TEXT    NOT NULL,
    slab_mix TEXT    NOT NULL DEFAULT '',
    day      INTEGER NOT NULL,
    date     TEXT    NOT NULL,
    rm_t     REAL    NOT NULL,
    fg_t     REAL    NOT NULL,
    slab_t   REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, imp_mix, exp_mix, slab_mix, day)
);
"""

# result-dict key -> run_results column
RESULT_COLS = {
    'imported': 'imported_t', 'exported': 'exported_t', 'impCalls': 'imp_calls', 'expCalls': 'exp_calls',
    'occ': 'berth_occ_pct', 'lenOcc': 'quay_occ_pct', 'berths': 'berths', 'avgTurn': 'avg_turnaround_h',
    'avgIdle': 'avg_waiting_h', 'stockoutH': 'stockout_h', 'fgFullH': 'fg_full_h', 'belowSafeH': 'below_safety_h',
    'lost': 'lost_t', 'produced': 'produced_t', 'minRM': 'min_rm_t', 'maxRM': 'max_rm_t', 'maxFG': 'max_fg_t',
    'endRM': 'end_rm_t', 'endFG': 'end_fg_t', 'firstArr': 'first_arrival_h', 'firstDep': 'first_departure_h',
    'carried': 'carried', 'slabExported': 'slab_exported_t', 'slabCalls': 'slab_calls', 'slabFullH': 'slab_full_h',
    'maxSlab': 'max_slab_t', 'endSlab': 'end_slab_t', 'firstSlabDep': 'first_slab_dep_h',
}


@contextmanager
def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys = ON')
    try:
        yield con
        con.commit()
    finally:
        con.close()


def init() -> None:
    with connect() as con:
        _migrate(con)
        con.executescript(SCHEMA)


def _migrate(con: sqlite3.Connection) -> None:
    """Databases made before slab export was added: rebuild the result tables with the slab
    columns (slab_mix '' for the old runs, which had no slab ships)."""
    cols = [r['name'] for r in con.execute('PRAGMA table_info(run_results)')]
    if not cols or 'slab_mix' in cols:
        return
    con.execute('PRAGMA foreign_keys = OFF')
    con.execute('ALTER TABLE run_results RENAME TO old_run_results')
    con.execute('ALTER TABLE run_daily_stock RENAME TO old_run_daily_stock')
    con.executescript(SCHEMA)
    keep = ','.join(cols)
    con.execute(f'INSERT INTO run_results ({keep}) SELECT {keep} FROM old_run_results')
    con.execute('INSERT INTO run_daily_stock (run_id, imp_mix, exp_mix, day, date, rm_t, fg_t) '
                'SELECT run_id, imp_mix, exp_mix, day, date, rm_t, fg_t FROM old_run_daily_stock')
    con.execute('DROP TABLE old_run_results')
    con.execute('DROP TABLE old_run_daily_stock')
    con.commit()
    con.execute('PRAGMA foreign_keys = ON')


def save_run(name: str, P: dict, cal: dict, results: dict, duration_s: float) -> int:
    with connect() as con:
        cur = con.execute(
            'INSERT INTO runs (name, start_date, inputs_json, n_combos, n_feasible, duration_s) VALUES (?,?,?,?,?,?)',
            (name, P['startDate'], json.dumps(P), len(results), sum(1 for r in results.values() if r['feasible']), duration_s))
        run_id = cur.lastrowid
        cols = ['run_id', 'imp_mix', 'exp_mix', 'slab_mix', 'eligible', 'feasible', *RESULT_COLS.values(), 'reasons_json', 'warnings_json']
        rows, stock = [], []
        for r in results.values():
            rows.append([run_id, r['im'], r['ex'], r['sl'], int(not r['inelig']), int(r['feasible']),
                         *[r.get(k) for k in RESULT_COLS], json.dumps(r['reasons']), json.dumps(r['warnings'])])
            if not r['inelig']:
                stock += [(run_id, r['im'], r['ex'], r['sl'], d, cal['days'][d]['iso'], rm, fg, sb)
                          for d, (rm, fg, sb) in enumerate(zip(r['dRM'], r['dFG'], r['dSlab']))]
        con.executemany(f'INSERT INTO run_results ({",".join(cols)}) VALUES ({",".join("?" * len(cols))})', rows)
        con.executemany('INSERT INTO run_daily_stock VALUES (?,?,?,?,?,?,?,?,?)', stock)
        return run_id


def _run_row(row: sqlite3.Row, with_inputs: bool) -> dict:
    out = {k: row[k] for k in ('id', 'name', 'created_at', 'start_date', 'n_combos', 'n_feasible', 'duration_s')}
    if with_inputs:
        out['inputs'] = json.loads(row['inputs_json'])
    return out


def list_runs() -> list[dict]:
    with connect() as con:
        return [_run_row(r, False) for r in con.execute('SELECT * FROM runs ORDER BY id DESC')]


def _result_row(row: sqlite3.Row) -> dict:
    # runs saved before the product was called HBI on screen still say FG in their stored text
    hbi = lambda xs: [re.sub(r'\bFG\b', 'HBI', x) for x in xs]  # noqa: E731
    out = {'im': row['imp_mix'], 'ex': row['exp_mix'], 'sl': row['slab_mix'], 'inelig': not row['eligible'], 'feasible': bool(row['feasible']),
           'reasons': hbi(json.loads(row['reasons_json'])), 'warnings': hbi(json.loads(row['warnings_json']))}
    for key, col in RESULT_COLS.items():
        out[key] = row[col]
    return out


def get_run(run_id: int) -> dict | None:
    with connect() as con:
        row = con.execute('SELECT * FROM runs WHERE id = ?', (run_id,)).fetchone()
        if not row:
            return None
        run = _run_row(row, True)
        run['results'] = [_result_row(r) for r in con.execute(
            'SELECT * FROM run_results WHERE run_id = ? ORDER BY rowid', (run_id,))]
        return run


def get_result(run_id: int, im: str, ex: str, sl: str = '') -> dict | None:
    with connect() as con:
        key = (run_id, im, ex, sl)
        row = con.execute('SELECT * FROM run_results WHERE run_id = ? AND imp_mix = ? AND exp_mix = ? AND slab_mix = ?',
                          key).fetchone()
        if not row:
            return None
        res = _result_row(row)
        stock = con.execute('SELECT rm_t, fg_t, slab_t FROM run_daily_stock '
                            'WHERE run_id = ? AND imp_mix = ? AND exp_mix = ? AND slab_mix = ? ORDER BY day', key).fetchall()
        res['dRM'] = [s['rm_t'] for s in stock]
        res['dFG'] = [s['fg_t'] for s in stock]
        res['dSlab'] = [s['slab_t'] for s in stock]
        return res


def delete_run(run_id: int) -> bool:
    with connect() as con:
        return con.execute('DELETE FROM runs WHERE id = ?', (run_id,)).rowcount > 0

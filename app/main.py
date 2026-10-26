"""FastAPI app: runs the jetty simulation, stores runs in SQLite and serves the web UI."""
from __future__ import annotations

import time
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db, engine, resources

STATIC = Path(__file__).resolve().parent / 'static'

app = FastAPI(title='DRI Jetty Planner')
db.init()


@app.middleware('http')
async def no_stale_pages(request, call_next):
    # make the browser check for updated page files every time, so app changes show without a hard refresh
    response = await call_next(request)
    if request.url.path == '/' or request.url.path.startswith('/static/'):
        response.headers['Cache-Control'] = 'no-cache'
    return response


class RunRequest(BaseModel):
    name: str | None = None
    inputs: dict


class ResourceRequest(BaseModel):
    order: list[str] = list(resources.CATS)
    limits: dict | None = None


@app.get('/api/defaults')
def get_defaults():
    return engine.defaults()


@app.post('/api/runs', status_code=201)
def create_run(req: RunRequest):
    try:
        P = engine.normalize_inputs(req.inputs)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if not engine.mixes_for(P, 'imp') or not engine.mixes_for(P, 'exp'):
        raise HTTPException(422, 'Select at least one ship class for import and one for export.')
    t0 = time.perf_counter()
    ctx, results = engine.run_all(P)
    duration = time.perf_counter() - t0
    name = (req.name or '').strip()[:120] or f'Run {datetime.now():%d %b %Y %H:%M}'
    run_id = db.save_run(name, P, ctx['cal'], results, duration)
    return db.get_run(run_id)


@app.get('/api/runs')
def list_runs():
    return db.list_runs()


@app.get('/api/runs/{run_id}')
def get_run(run_id: int):
    run = db.get_run(run_id)
    if not run:
        raise HTTPException(404, 'Run not found')
    return run


@app.get('/api/runs/{run_id}/combos/{im}/{ex}')
def get_combo(run_id: int, im: str, ex: str, sl: str = ''):
    """One combination of a stored run (sl: slab fleet, when slab export is on): stored KPIs and
    daily stock, plus the call schedule, calendar and desk plan rebuilt from the run's stored inputs."""
    run = db.get_run(run_id)
    if not run:
        raise HTTPException(404, 'Run not found')
    res = db.get_result(run_id, im, ex, sl)
    if not res:
        raise HTTPException(404, 'This combination is not part of the run')
    P = engine.normalize_inputs(run['inputs'])
    ctx = engine.make_context(P)
    res['log'] = [] if res['inelig'] else engine.simulate(ctx, im, ex, sl)['log']
    res['NH'] = len(ctx['cal']['days']) * 24
    return {'result': res, 'calendar': ctx['cal'], 'plan': engine.desk_plan(ctx, im, ex, sl)}


@app.get('/api/runs/{run_id}/combos/{im}/{ex}/trace')
def get_trace(run_id: int, im: str, ex: str, sl: str = ''):
    """Hour-by-hour playback data for the simulator, rebuilt from the run's stored inputs."""
    run = db.get_run(run_id)
    if not run:
        raise HTTPException(404, 'Run not found')
    if not db.get_result(run_id, im, ex, sl):
        raise HTTPException(404, 'This combination is not part of the run')
    P = engine.normalize_inputs(run['inputs'])
    ctx = engine.make_context(P)
    r = engine.simulate(ctx, im, ex, sl, trace=True)
    if r['inelig']:
        raise HTTPException(422, r['reasons'][0])
    rt = ctx['rt']
    return {'trace': r['trace'], 'log': r['log'], 'calendar': ctx['cal'], 'inputs': P,
            'rates': {'imp': rt['imp'], 'exp': rt['exp'], 'slab': rt['slab']}, 'NH': r['NH']}


@app.post('/api/runs/{run_id}/combos/{im}/{ex}/resources')
def get_resources(run_id: int, im: str, ex: str, req: ResourceRequest, sl: str = ''):
    """Extra resources (jetty length, machines, yard space) that turn this combination YES, in the user's
    order of priority. Runs the unchanged simulation on copies of the run's inputs; nothing is saved."""
    run = db.get_run(run_id)
    if not run:
        raise HTTPException(404, 'Run not found')
    if not db.get_result(run_id, im, ex, sl):
        raise HTTPException(404, 'This combination is not part of the run')
    P = engine.normalize_inputs(run['inputs'])
    try:
        return resources.find(P, im, ex, sl, req.order, req.limits)
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.delete('/api/runs/{run_id}', status_code=204)
def delete_run(run_id: int):
    if not db.delete_run(run_id):
        raise HTTPException(404, 'Run not found')


@app.get('/')
def index():
    return FileResponse(STATIC / 'index.html')


app.mount('/static', StaticFiles(directory=STATIC), name='static')

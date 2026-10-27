# DRI Jetty Planner

A local system that checks whether the jetty can handle a year of raw material imports and finished goods exports, and optionally steel slab exports, for every import × export (× slab) combination of Panamax, Supramax and Handymax ships. Every simulation run is saved in a local SQLite database.

- **Backend:** Python, FastAPI. The simulation engine is in `app/engine.py`.
- **Database:** SQLite file at `data/jetty.db`. It is created on first start.
- **Front end:** a browser page served by the backend at http://127.0.0.1:8000.

## Start

Double-click `run.bat`.

The first time, it creates a `.venv` folder and installs the packages. Then it starts the server and opens the browser. Keep the window open while you use the planner, and close it to stop.

To start it by hand instead:

```bash
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Python 3.10 or newer is needed.

## Use

1. Enter the inputs in the left panel: targets, first ship arrival date, jetty, ship classes (with Import / Export ticks), steel slab export, plant and yards, equipment, non-cargo activities, and planning rules.
2. Choose the **Time step** under the Run button: **1 hour** (default) or **6 minutes** (finer timing of ship calls and stoppages, several times slower). Select **Run simulation**. All allowed combinations run, which takes about 3 seconds (about 10 seconds with slab export, spread over the CPU cores), and the run is saved.
3. Read the results in the tabs: **Shipment plan**, **Ship combinations**, **Simulation** and **Calendar**.
4. **Simulator** plays back the selected run and ship combination hour by hour in a 2D plan view: ships arriving, waiting for tugs, berthing, discharging or loading and sailing; SULs, loader and slab cranes moving to the ships; conveyors running; RM, FG and slab stockpiles; the DRI plant and SMS. Controls: play / pause, speed (1 hour to 1 week per second), ±1 hour, ±1 day, start / end and a timeline you can drag. Below the view are live figures, the ships at the jetty, charts of stock and plant production, and a daily table of RM received, RM used, RM stock, DRI made, FG shipped and FG stock (plus slab made, shipped and stock with slab export). **Hide simulator** hides the tab.
5. **Extra resources** answers "if the jetty is not enough, what has to be added?" for the selected combination. Set the priority between extra jetty length, extra loaders and unloaders (SUL, loader, slab crane), and extra RM and FG yard space, plus the search limits, then select **Find extra resources**. It runs the same simulation on copies of the run's inputs with resources added: the 1st priority is used as much as needed and the others only as much as still has to be added. It also shows the least of each resource that works on its own. The saved run is not changed and nothing is stored.
6. **Saved runs** lists every run in the database. **Open** reloads a run's inputs and results. **Delete** removes a run.

## Steel slab export (third material)

Tick **Include steel slab export** under *Steel slab export (3rd material)* to add a third, outward cargo. With it off, the model works exactly as before.

- The SMS (steel melt shop) takes DRI (HBI) from the plant ahead of the FG yard: slab target ÷ year hours × *DRI used per t of slab* every hour, and puts the slab in the slab yard. If the slab yard is full, the SMS stops and those hours are a NO reason.
- Slab ships use the same three classes, ticked in the **Slab** row of the ship table. Parcel = DWT × slab load %. A slab ship is called when slab stock reaches the export trigger share of its parcel, and is loaded by the slab cranes. It shares the jetty length, tugs and non-cargo activities with the other ships.
- Combinations become import × export × slab, up to 343. The *Ship combinations* matrix shows one slab fleet at a time (chosen above it); the ranking lists all of them.
- The desk plan adds slab calls to berth occupancy and checks DRI output ≥ FG export + DRI to the SMS + domestic dispatch.
- The slab values given (1 Mt/yr, 1.15 t DRI per t slab, 90% load, 150,000 t yard, 20,000 t opening stock, 2 cranes × 400 tph at 75%) are examples. Slab loading equipment is to be confirmed.

## Database

| Table | One row per | Holds |
|---|---|---|
| `runs` | simulation run | name, time saved, first ship arrival, all inputs as JSON, number of combinations and how many pass, run time |
| `run_results` | run × import fleet × export fleet × slab fleet | YES/NO, reasons, warnings, tonnes imported and exported, calls, berth occupancy, turnaround, waiting, plant-starved hours, FG-yard-full hours, stock levels, first arrival and first export departure, slab exported, slab calls, slab-yard-full hours |
| `run_daily_stock` | run × combination × day | RM, FG and slab yard stock at the end of each day |

The slab fleet is `''` (empty) for runs without slab export. A database made before slab export was added is upgraded on start, keeping every saved run.

When a combination is opened, the call-by-call schedule, the calendar and the desk plan are rebuilt from the run's saved inputs. The simulation gives the same result every time for the same inputs.

To back up the data, copy `data/jetty.db`. To use a different database file, set the `JETTY_DB` environment variable to its path before starting.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/defaults` | Default inputs |
| POST | `/api/runs` | Run all combinations and save. Body: `{"name": "...", "inputs": {...}}` |
| GET | `/api/runs` | List saved runs |
| GET | `/api/runs/{id}` | One run with its inputs and every combination's result |
| GET | `/api/runs/{id}/combos/{imp}/{exp}?sl={slab}` | One combination: stored result and daily stock, plus schedule, calendar and desk plan. `sl` is the slab fleet, left out without slab export |
| GET | `/api/runs/{id}/combos/{imp}/{exp}/trace?sl={slab}` | Hour-by-hour playback data for the simulator: stock, production, cargo moved, tugs and every ship alongside |
| POST | `/api/runs/{id}/combos/{imp}/{exp}/resources?sl={slab}` | Extra resources that turn the combination YES. Body: `{"order": ["jetty", "equip", "yard"], "limits": {...}}` |
| DELETE | `/api/runs/{id}` | Delete a run |

Fleet codes: `P` Panamax, `S` Supramax, `H` Handymax. Mixes are written as `PS`, `PH`, `SH` or `PSH`.

Interactive API docs are at http://127.0.0.1:8000/docs while the server is running.

## Tests

```bash
.venv\Scripts\python -m unittest discover -s tests -v
```

## Files

```
app/engine.py      simulation engine, desk plan, calendar
app/resources.py   extra-resources search (uses the engine unchanged)
app/db.py          SQLite schema and queries
app/main.py        FastAPI routes; serves the web page
app/static/        index.html, app.js, styles.css, sim.js (simulator playback, 2D view), resources.js (Extra resources screen)
tests/             engine and API tests
run.bat            one-click start on Windows
data/jetty.db      database (created on first start)
```

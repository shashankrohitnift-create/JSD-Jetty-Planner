"""Hour-by-hour jetty capacity and vessel call simulation for a DRI plant.

One run checks every import x export fleet combination of Panamax, Supramax and Handymax
ships against the jetty length, handling equipment, the shared plant/jetty calendar
and the RM / HBI yard stock, and gives a YES/NO per combination.
"""
from __future__ import annotations

import copy
import math
import os
from datetime import date, timedelta
from itertools import permutations

MIXES = ['P', 'S', 'H', 'PS', 'PH', 'SH', 'PSH']
SHIP_KEYS = ['P', 'S', 'H']
MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
EXT_DAYS = 30          # simulated past the year end so exports can be counted for a year from the first sailing

DEFAULTS = {
    'berthShip': '',        # ship class that sets the number of berths; '' = the smallest ship in each fleet
    'startDate': '2027-04-01', 'rmTarget': 7000000, 'fgTarget': 2000000, 'tol': 0.5,   # HBI export 2 Mtpa alongside 2.5 Mtpa slab
    'jettyLen': 600, 'gapPct': 25, 'endPct': 10, 'maxJettyDays': 333,
    'ships': {
        'P': {'name': 'Panamax', 'loa': 225, 'dwt': 75000, 'util': 92, 'tugs': 3, 'imp': True, 'exp': True, 'slab': True},
        'S': {'name': 'Supramax', 'loa': 199, 'dwt': 57000, 'util': 93, 'tugs': 2, 'imp': True, 'exp': True, 'slab': True},
        'H': {'name': 'Handymax', 'loa': 185, 'dwt': 45000, 'util': 94, 'tugs': 2, 'imp': True, 'exp': True, 'slab': True},
    },
    # Steel slab export (third material): part of the DRI goes to the SMS and leaves as slab.
    # Entered like the DRI plant: SMS capacity (Mtpa of slab), utilisation and t of HBI per t of slab set the
    # slab made (smsRate per hour); slabTarget is the slab export target, like fgTarget for HBI.
    # 2.5 Mtpa x 100% x 1.2 is the user's case. Slab yard and crane figures are examples.
    'slabOn': True, 'smsCap': 2.5, 'smsUtil': 100, 'slabDriRatio': 1.2, 'slabTarget': 2500000,
    'smsDirectPct': 70,     # share of the SMS's HBI taken straight from the DRI plant; the rest comes from the HBI yard
    'smsStartH': 6,         # SMS starts this many hours after the DRI plant (no slab, no HBI taken before)
    'slabYardCap': 150000, 'slabInit': 20000, 'slabCraneN': 2, 'slabCraneRate': 400, 'slabCraneEff': 75,
    'driCap': 5.2, 'plantUtil': 96.5, 'rmRatio': 1.40, 'domesticFG': 0,
    'rmYardCap': 600000, 'rmInit': 300000, 'rmSafety': 100000, 'fgYardCap': 350000, 'fgInit': 80000,
    'fgSafety': 0,          # HBI yard safety stock kept for the SMS: export ships load only the HBI above it
    'sulN': 2, 'sulRate': 1500, 'sulEff': 75, 'impConv': 3000, 'impConvEff': 90,
    'loaderN': 1, 'loaderRate': 2000, 'loaderEff': 75, 'expConv': 2200, 'expConvEff': 90, 'cargoStop': 8,
    'tugsAvail': 4, 'nightNav': True, 'dayStart': 6, 'dayEnd': 18,
    'acts': [
        {'n': 'Pilot boarding & inbound towage', 'h': 1.5, 'phase': 'pre', 'tug': True},
        {'n': 'Berthing & mooring', 'h': 1.0, 'phase': 'pre', 'tug': True},
        {'n': 'Customs, immigration & port health', 'h': 1.0, 'phase': 'pre', 'tug': False},
        {'n': 'Initial draft survey', 'h': 1.0, 'phase': 'pre', 'tug': False},
        {'n': 'Hatch opening & SUL/loader positioning', 'h': 0.5, 'phase': 'pre', 'tug': False},
        {'n': 'Final draft survey', 'h': 1.0, 'phase': 'post', 'tug': False},
        {'n': 'Hatch closing & cargo documents', 'h': 1.5, 'phase': 'post', 'tug': False},
        {'n': 'Unmooring & outbound towage', 'h': 1.0, 'phase': 'post', 'tug': True},
        {'n': 'Pilot disembark & channel exit', 'h': 0.5, 'phase': 'post', 'tug': False},
    ],
    'expTrigger': 60, 'slabTrigger': 60, 'rmCallDays': 0, 'holdDays': 3,   # rmCallDays: call RM ship when stock above safety covers this many days (0 = as soon as a parcel fits)
    'maxOcc': 70,
    'stepMin': 60,          # simulation time step in minutes: 60 (1 hour, default) or 6
    'sel': {'i': 'P', 'e': 'P', 'l': 'P'},
}

NUM_FIELDS = [k for k, v in DEFAULTS.items() if isinstance(v, (int, float)) and not isinstance(v, bool)]
SHIP_NUM_FIELDS = ['loa', 'dwt', 'util', 'tugs']


def defaults() -> dict:
    return copy.deepcopy(DEFAULTS)


def normalize_inputs(raw: dict) -> dict:
    """Merge user inputs over the defaults and coerce types. Raises ValueError on bad input."""
    P = defaults()
    raw = raw or {}
    for k in NUM_FIELDS:
        if k in raw:
            try:
                P[k] = float(raw[k])
            except (TypeError, ValueError):
                raise ValueError(f'{k} must be a number')
            if not math.isfinite(P[k]) or P[k] < 0:
                raise ValueError(f'{k} must be zero or more')
    if 'startDate' in raw:
        try:
            date.fromisoformat(str(raw['startDate']))
        except ValueError:
            raise ValueError('startDate must be a date in YYYY-MM-DD form')
        P['startDate'] = str(raw['startDate'])
    if 'slabTrigger' not in raw:            # runs saved before the separate slab trigger used the HBI one
        P['slabTrigger'] = P['expTrigger']
    for k in ('nightNav', 'slabOn'):
        if k in raw:
            P[k] = bool(raw[k])
    if 'berthShip' in raw:
        P['berthShip'] = str(raw['berthShip'] or '')
        if P['berthShip'] and P['berthShip'] not in P['ships']:
            raise ValueError('Berth ship class must be one of the ship classes')
    for key, ship in (raw.get('ships') or {}).items():
        if key not in P['ships']:
            continue
        for f in SHIP_NUM_FIELDS:
            if f in ship:
                try:
                    P['ships'][key][f] = float(ship[f])
                except (TypeError, ValueError):
                    raise ValueError(f'{P["ships"][key]["name"]} {f} must be a number')
        for f in ('imp', 'exp', 'slab'):
            if f in ship:
                P['ships'][key][f] = bool(ship[f])
    if 'acts' in raw:
        acts = []
        for a in raw['acts'] or []:
            try:
                h = float(a.get('h', 0))
            except (TypeError, ValueError):
                raise ValueError('Activity hours must be a number')
            acts.append({'n': str(a.get('n', 'Activity'))[:120], 'h': max(0.0, h),
                         'phase': 'post' if a.get('phase') == 'post' else 'pre', 'tug': bool(a.get('tug'))})
        P['acts'] = acts
    sel = raw.get('sel') or {}
    if sel.get('i') in MIXES:
        P['sel']['i'] = sel['i']
    if sel.get('e') in MIXES:
        P['sel']['e'] = sel['e']
    if sel.get('l') in MIXES:
        P['sel']['l'] = sel['l']
    if P['rmRatio'] <= 0:
        raise ValueError('RM consumed per t of DRI must be above zero')
    if P['slabOn'] and P['slabDriRatio'] <= 0:
        raise ValueError('DRI used per t of slab must be above zero')
    if not 1 <= P['maxJettyDays'] <= 366:
        raise ValueError('Days in a year must be between 1 and 366')
    if P['rmCallDays'] < 0:
        raise ValueError('RM call days of stock above safety must be 0 or more')
    if P['fgSafety'] < 0 or P['fgSafety'] > P['fgYardCap']:
        raise ValueError('HBI safety stock must be between 0 and the HBI yard capacity')
    if P['smsStartH'] < 0:
        raise ValueError('SMS start after the DRI plant must be 0 h or more')
    if P['smsDirectPct'] > 100:
        raise ValueError('SMS feed taken directly from the DRI plant must be 0 to 100%')
    if P['stepMin'] not in (60, 6):
        raise ValueError('Time step must be 60 or 6 minutes')
    P['stepMin'] = int(P['stepMin'])
    if not P['nightNav'] and not (0 <= P['dayStart'] < P['dayEnd'] <= 24):
        raise ValueError('With night berthing off, the daylight window must open before it closes (hours 0 to 24)')
    derive_slab(P, raw)
    return P


def derive_slab(P: dict, raw: dict | None = None) -> None:
    """SMS slab output per hour from its capacity and utilisation. Rail/road dispatch is not used (always 0)."""
    raw = raw or {}
    hours = P['maxJettyDays'] * 24
    if 'smsCap' not in raw:          # runs saved when the SMS was entered per hour or per year
        if raw.get('smsRate') is not None:
            P['smsCap'], P['smsUtil'] = max(0.0, float(raw['smsRate'])) * hours / 1e6, 100.0
        elif raw.get('slabTarget') is not None:
            P['smsCap'], P['smsUtil'] = max(0.0, float(raw['slabTarget'])) / 1e6, 100.0
    P['smsRate'] = P['smsCap'] * 1e6 * P['smsUtil'] / 100 / hours
    P['domesticFG'] = 0.0


def mixes_for(P: dict, direction: str) -> list[str]:
    """Fleet mixes a direction ('imp', 'exp' or 'slab') may use: every ship in the mix must be
    selected for that direction. Slab has the single mix '' (no slab ships) when slab export is off."""
    if direction == 'slab' and not P.get('slabOn'):
        return ['']
    return [m for m in MIXES if all(P['ships'][c].get(direction, True) is not False for c in m)]


def mix_name(P: dict, m: str) -> str:
    return ' + '.join(P['ships'][c]['name'] for c in m)


def fmt_n(x: float, d: int = 0) -> str:
    if abs(x) < 0.5 * 10 ** (-d):
        x = 0
    return f'{x:,.{d}f}'


def fmt_t(t: float) -> str:
    return fmt_n(t / 1e6, 2) + ' Mt' if abs(t) >= 1e6 else fmt_n(t) + ' t'


def year_days(P: dict) -> int:
    """Length of the planning year in days (333 by default); plant and jetty work every day of it."""
    return int(P['maxJettyDays'])


def build_calendar(P: dict) -> dict:
    """The planning year from the first ship's arrival plus EXT_DAYS; every day is a working day."""
    start = date.fromisoformat(P['startDate'])
    yd = year_days(P)
    days, mi, last = [], -1, ''
    for i in range(yd + EXT_DAYS):
        d = start + timedelta(days=i)
        iso = d.isoformat()
        if iso[:7] != last:
            mi += 1
            last = iso[:7]
        days.append({'i': i, 'iso': iso, 'dow': (d.weekday() + 1) % 7, 'm': d.month - 1, 'y': d.year,
                     'mi': mi, 'dd': d.day, 'st': 'work', 'why': ''})
    return {'days': days, 'start': P['startDate'], 'yearDays': yd, 'nWork': yd}


def _row_length(P: dict, loas) -> float:
    """Jetty length for ships in this order: LOA + end clearance (% of the end ship's LOA)
    + clearance between neighbours (% of the larger neighbour's LOA)."""
    gaps = sum(max(a, b) for a, b in zip(loas, loas[1:])) * P['gapPct'] / 100
    return sum(loas) + gaps + (loas[0] + loas[-1]) * P['endPct'] / 100


def len_needed(P: dict, loas: list[float]) -> float:
    """Shortest jetty length that takes these ships together, over every order they can lie in."""
    if not loas:
        return 0
    return min(_row_length(P, list(order)) for order in set(permutations(loas)))


def eligibility(P: dict) -> dict:
    r = {}
    for k in SHIP_KEYS:
        s = P['ships'][k]
        len_ok = len_needed(P, [s['loa']]) <= P['jettyLen']
        tug_ok = True                   # enough tugs: tugs are not a limit
        r[k] = {'lenOk': len_ok, 'tugOk': tug_ok, 'ok': len_ok and tug_ok and s['dwt'] > 0 and s['util'] > 0,
                'parcel': s['dwt'] * s['util'] / 100, 'slabParcel': s['dwt'] * s['util'] / 100}
    return r


def rates(P: dict) -> dict:
    stop = 1 - P['cargoStop'] / 100
    sul_e = P['sulRate'] * P['sulEff'] / 100
    ic_e = P['impConv'] * P['impConvEff'] / 100
    ld_e = P['loaderRate'] * P['loaderEff'] / 100
    ec_e = P['expConv'] * P['expConvEff'] / 100
    cr_e = P['slabCraneRate'] * P['slabCraneEff'] / 100
    return {'stop': stop, 'sulE': sul_e, 'icE': ic_e, 'ldE': ld_e, 'ecE': ec_e, 'crE': cr_e,
            'imp': min(P['sulN'] * sul_e, ic_e) * stop, 'exp': min(P['loaderN'] * ld_e, ec_e) * stop,
            'slab': P['slabCraneN'] * cr_e * stop if P['slabOn'] else 0}


def berths_for(P: dict, types: str) -> int:
    bs = P.get('berthShip')
    mn = P['ships'][bs]['loa'] if bs else min(P['ships'][t]['loa'] for t in set(types))
    n = 0
    while n < 6 and len_needed(P, [mn] * (n + 1)) <= P['jettyLen']:
        n += 1
    eq = P['sulN'] + P['loaderN'] + (P['slabCraneN'] if P['slabOn'] else 0)
    return max(1, min(n, max(1, int(eq))))


def make_context(P: dict) -> dict:
    return {'P': P, 'cal': build_calendar(P), 'el': eligibility(P), 'rt': rates(P)}


class _Ship:
    __slots__ = ('n', 'dir', 't', 'loa', 'tugs', 'qty', 'rem', 'phase', 'ai', 'actRem', 'berthH', 'frac',
                 'ncH', 'idle', 'waitTug', 'offH', 'lane', 'cargoStartH', 'cargoEndH', 'departH', 'tugNow')

    def as_dict(self) -> dict:
        return {'n': self.n, 'dir': self.dir, 't': self.t, 'qty': self.qty, 'berthH': self.berthH,
                'cargoStartH': self.cargoStartH, 'cargoEndH': self.cargoEndH, 'departH': self.departH,
                'ncH': self.ncH, 'idle': self.idle, 'waitTug': self.waitTug, 'offH': self.offH,
                'lane': self.lane, 'done': self.phase == 'done'}


PHASE_CODE = {'pre': 0, 'cargo': 1, 'post': 2}


def simulate(ctx: dict, im: str, ex: str, sl: str = '', trace: bool = False) -> dict:
    """Run one import x export (x slab, when slab export is on) combination. With trace=True the
    result also holds an hour-by-hour record ('trace') of stock, production, cargo moved and every
    ship alongside, for playback."""
    P, cal, el, rt = ctx['P'], ctx['cal'], ctx['el'], ctx['rt']
    yd = cal['yearDays']
    YH = yd * 24
    slabOn = bool(P['slabOn'] and sl)
    if not slabOn:
        sl = ''
    bad = sorted({t for t in im + ex + sl if not el[t]['ok']}, key=SHIP_KEYS.index)
    if bad:
        return {'im': im, 'ex': ex, 'sl': sl, 'inelig': True, 'feasible': False, 'warnings': [],
                'reasons': [', '.join(P['ships'][t]['name'] for t in bad) + ' cannot use this jetty (too long)']}
    days = cal['days']
    NH = len(days) * 24
    work_day = [d['st'] == 'work' for d in days]
    # Time step: 60 minutes (default) or 6 minutes. Rates stay per hour; each step moves dt hours' worth.
    stepMin = int(P.get('stepMin', 60))
    dt = stepMin / 60
    spH = 60 // stepMin                  # steps per hour
    spD = spH * 24                       # steps per day
    NS, YS = NH * spH, YH * spH          # steps in the run and in the year
    # Annual output is made continuously over the planning year
    prodH = P['driCap'] * 1e6 * P['plantUtil'] / 100 / max(1, cal['nWork'] * 24)
    ratio = P['rmRatio']
    consH = prodH * ratio
    domH = P['domesticFG'] / 24
    # SMS: takes DRI ahead of the HBI yard and makes slab at its capacity x utilisation, evenly over the year
    slabH = P['smsRate'] if slabOn else 0.0
    sRatio = P['slabDriRatio']
    prodS, slabS = prodH * dt, slabH * dt
    cumI = [0.0] * (NS + 1)
    cumE = [0.0] * (NS + 1)
    cumL = [0.0] * (NS + 1)
    pre = [a for a in P['acts'] if a['phase'] == 'pre']
    post = [a for a in P['acts'] if a['phase'] == 'post']
    rmCap, fgCap, jettyLen = P['rmYardCap'], P['fgYardCap'], P['jettyLen']
    slabCap = P['slabYardCap']
    sulN, loaderN, craneN = int(P['sulN']), int(P['loaderN']), int(P['slabCraneN'])
    rmTarget, fgTarget = P['rmTarget'], P['fgTarget']
    slabTarget = P['slabTarget'] if slabOn else 0
    st = {'rm': float(P['rmInit']), 'fg': float(P['fgInit']), 'imported': 0.0, 'exported': 0.0,
          'impC': 0.0, 'expC': 0.0, 'ii': 0, 'ei': 0,
          'slab': float(P['slabInit']) if slabOn else 0.0, 'slabExp': 0.0, 'slabC': 0.0, 'li': 0}
    stockoutH = fgFullH = belowSafeH = slabFullH = smsShortH = 0
    fgSafe = P['fgSafety']               # HBI below this is kept for the SMS, not exported
    direct = P['smsDirectPct'] / 100        # SMS feed: this share straight from the plant, the rest from the HBI yard
    lost = produced = slabMade = 0.0
    workH = 0
    minRM = maxRM = st['rm']
    maxFG = st['fg']
    maxSlab = st['slab']
    berth: list[_Ship] = []
    log: list[_Ship] = []
    dRM: list[float] = []
    dFG: list[float] = []
    dSlab: list[float] = []
    lanes = [False] * 6
    ships = P['ships']

    def fits(t):
        return len_needed(P, [s.loa for s in berth] + [ships[t]['loa']]) <= jettyLen

    def place(c, t_end):
        sh = ships[c['t']]
        lane = lanes.index(False) if False in lanes else -1
        s = _Ship()
        s.n, s.dir, s.t, s.loa, s.tugs = len(log) + 1, c['dir'], c['t'], sh['loa'], sh['tugs']
        s.qty = s.rem = c['qty']
        s.phase, s.ai = 'pre', 0
        s.actRem = pre[0]['h'] if pre else 0
        s.berthH, s.frac = t_end, dt
        s.ncH = s.idle = s.waitTug = 0.0
        s.offH = 0
        s.lane = lane if lane >= 0 else len(lanes) - 1
        s.cargoStartH = s.cargoEndH = s.departH = None
        s.tugNow = False
        if lane >= 0:
            lanes[lane] = True
        berth.append(s)
        log.append(s)
        if c['dir'] == 'I':
            st['impC'] += c['qty']
            st['ii'] += 1
        elif c['dir'] == 'E':
            st['expC'] += c['qty']
            st['ei'] += 1
        else:
            st['slabC'] += c['qty']
            st['li'] += 1

    def try_berth(t_end, daylight):
        if not daylight:
            return
        for _ in range(4):
            cand = []
            bi = [s for s in berth if s.dir == 'I']
            be = [s for s in berth if s.dir == 'E']
            if rmTarget - st['impC'] > 1 and rt['imp'] > 0:
                t = im[st['ii'] % len(im)]
                qty = min(el[t]['parcel'], rmTarget - st['impC'])
                pend = sum(s.rem for s in bi)
                if (len(bi) < sulN and st['rm'] + pend + qty <= rmCap + consH * qty / rt['imp']
                        and (P['rmCallDays'] <= 0 or st['rm'] + pend <= P['rmSafety'] + P['rmCallDays'] * consH * 24)):
                    cand.append({'dir': 'I', 't': t, 'qty': qty, 'urg': (st['rm'] + pend) / max(1e-9, consH * 24)})
            if fgTarget - st['expC'] > 1 and rt['exp'] > 0:
                t = ex[st['ei'] % len(ex)]
                qty = min(el[t]['parcel'], fgTarget - st['expC'])
                pend = sum(s.rem for s in be)
                if len(be) < loaderN and st['fg'] - fgSafe - pend >= P['expTrigger'] / 100 * qty:
                    cand.append({'dir': 'E', 't': t, 'qty': qty,
                                 'urg': (fgCap - (st['fg'] - pend)) / max(1e-9, (prodH - slabH * sRatio - domH) * 24)})
            if slabOn and slabTarget - st['slabC'] > 1 and rt['slab'] > 0:
                t = sl[st['li'] % len(sl)]
                qty = min(el[t]['slabParcel'], slabTarget - st['slabC'])
                bl = [s for s in berth if s.dir == 'L']
                pend = sum(s.rem for s in bl)
                if len(bl) < craneN and st['slab'] - pend >= P['slabTrigger'] / 100 * qty:
                    cand.append({'dir': 'L', 't': t, 'qty': qty,
                                 'urg': (slabCap - (st['slab'] - pend)) / max(1e-9, slabH * 24)})
            if not cand:
                return
            cand.sort(key=lambda c: c['urg'])
            placed = False
            for k, c in enumerate(cand):
                if fits(c['t']):
                    place(c, t_end)
                    placed = True
                    break
                if k == 0 and c['urg'] < P['holdDays']:
                    return  # keep the berth free for the urgent call
            if not placed:
                return

    def cargo(lst, nEq, eqE, convE, kind, t_end):
        if not lst:
            return
        k = min(len(lst), 1 if kind == 'I' else nEq)   # all ship unloaders work one RM ship; the next RM ship waits
        for s in lst[k:]:
            s.idle += s.frac
        if k <= 0:
            return
        w = lst[:k]
        caps = [((nEq // k) + (1 if i < nEq % k else 0)) * eqE * s.frac for i, s in enumerate(w)]
        tot = sum(caps)
        if tot <= 0:
            return
        sc = min(1, convE * dt / tot) * rt['stop']
        for i, s in enumerate(w):
            cap = caps[i] * sc
            avail = max(0.0, rmCap - st['rm']) if kind == 'I' else max(0.0, st['fg'] - fgSafe if kind == 'E' else st['slab'])
            amt = min(cap, s.rem, avail)
            s.rem -= amt
            if kind == 'I':
                st['rm'] += amt
                st['imported'] += amt
            elif kind == 'E':
                st['fg'] -= amt
                st['exported'] += amt
            else:
                st['slab'] -= amt
                st['slabExp'] += amt
            if cap > 0 and amt < cap - 1e-6 and s.rem > 0.5:
                s.idle += (1 - amt / cap) * s.frac
            if s.rem <= 0.5:
                s.rem = 0
                s.phase = 'post'
                s.cargoEndH = t_end
                s.ai = 0
                s.actRem = post[0]['h'] if post else 0

    # Hour 0 of day 1 is the first ship's arrival
    if work_day[0]:
        try_berth(0, True)
    tugsAvail, nightNav, dayStart, dayEnd = P['tugsAvail'], P['nightNav'], P['dayStart'], P['dayEnd']
    rmSafety = P['rmSafety']
    tr = {'rm': [], 'fg': [], 'prod': [], 'imp': [], 'exp': [], 'tugs': [], 'ships': []} if trace else None
    if trace and slabOn:
        tr.update({'slab': [], 'slabExp': [], 'slabMade': [], 'smsPlant': [], 'smsYard': []})
    hour_out = hour_slab = hour_sp = hour_sy = 0.0   # summed over the steps of an hour, for the hourly trace
    for k in range(NS):
        m = k * stepMin                  # minutes since the start
        d = m // 1440
        tod = (m % 1440) / 60            # time of day, hours
        t_end = (k + 1) * stepMin / 60   # end of this step, hours
        in_year = k < YS
        work = work_day[d]
        out = fromPlant = fromYard = 0.0
        tugs = tugsAvail
        # Plant: runs on working days, limited by RM stock and HBI yard space; domestic dispatch every day
        dom = min(st['fg'], domH)
        st['fg'] -= dom
        if work:
            byRM = st['rm'] / ratio
            # SMS: makes slab unless the slab yard is full. Its HBI comes partly straight from the plant
            # (direct share, which needs no HBI yard space) and partly from the HBI yard stock.
            smsOn = slabOn and m >= P['smsStartH'] * 60     # the SMS starts smsStartH hours after the DRI plant
            slabMake = min(slabS, max(0.0, slabCap - st['slab'])) if smsOn else 0.0
            slab_room = slabMake
            fromPlant = slabMake * sRatio * direct
            bySpace = max(0.0, fgCap - st['fg']) + fromPlant
            out = max(0.0, min(prodS, byRM, bySpace))
            if out < fromPlant:                      # the plant makes less than the SMS's direct share
                fromPlant = out
                slabMake = out / (sRatio * direct)
            fromYard = slabMake * sRatio * (1 - direct)
            in_yard = st['fg'] + out - fromPlant      # HBI yard stock after this step's output arrives
            if fromYard > in_yard + 1e-9:            # the HBI yard cannot supply its share
                fromYard = max(0.0, in_yard)
                slabMake = fromYard / (sRatio * (1 - direct))
                fromPlant = slabMake * sRatio * direct
            toSms = fromPlant + fromYard
            if in_year:
                if byRM < prodS - 1e-6:
                    stockoutH += dt
                elif bySpace < prodS - 1e-6:
                    fgFullH += dt
                if smsOn and slab_room < slabS - 1e-6:
                    slabFullH += dt
                elif smsOn and slabMake < slabS - 1e-6:
                    smsShortH += dt
                lost += prodS - out
                produced += out
                slabMade += slabMake
            st['rm'] -= out * ratio
            st['fg'] += out - toSms
            st['slab'] += slabMake
            workH += dt
            daylight = nightNav or (dayStart <= tod < dayEnd)
            tugs = tugsAvail
            for s in berth:
                s.frac = dt
                s.tugNow = False
                if s.phase == 'cargo':
                    continue
                b, held, guard = dt, False, 0
                while b > 1e-9 and guard < 50:
                    guard += 1
                    lst = pre if s.phase == 'pre' else post
                    if s.ai >= len(lst):
                        if s.phase == 'pre':
                            s.phase = 'cargo'
                            s.cargoStartH = t_end - b
                            s.frac = b
                        else:
                            s.phase = 'done'
                            s.departH = t_end - b
                        break
                    a = lst[s.ai]
                    if a['tug'] and not held:
                        if not daylight:
                            s.waitTug += b
                            break
                        tugs -= s.tugs
                        held = True
                        s.tugNow = True
                    tk = min(b, s.actRem)
                    s.actRem -= tk
                    b -= tk
                    s.ncH += tk
                    if s.actRem <= 1e-9:
                        s.ai += 1
                        s.actRem = lst[s.ai]['h'] if s.ai < len(lst) else 0
            if berth:
                cargo([s for s in berth if s.dir == 'I' and s.phase == 'cargo'], sulN, rt['sulE'], rt['icE'], 'I', t_end)
                cargo([s for s in berth if s.dir == 'E' and s.phase == 'cargo'], loaderN, rt['ldE'], rt['ecE'], 'E', t_end)
                if slabOn:
                    cargo([s for s in berth if s.dir == 'L' and s.phase == 'cargo'], craneN, rt['crE'], math.inf, 'L', t_end)
                for i in range(len(berth) - 1, -1, -1):
                    if berth[i].phase == 'done':
                        lanes[berth[i].lane] = False
                        berth.pop(i)
            try_berth(t_end, daylight)
        else:
            for s in berth:
                s.offH += dt
        cumI[k + 1] = st['imported']
        cumE[k + 1] = st['exported']
        cumL[k + 1] = st['slabExp']
        rm, fg = st['rm'], st['fg']
        if in_year:
            if st['slab'] > maxSlab:
                maxSlab = st['slab']
            if rm < rmSafety:
                belowSafeH += dt
            if rm < minRM:
                minRM = rm
            if rm > maxRM:
                maxRM = rm
            if fg > maxFG:
                maxFG = fg
        if (k + 1) % spD == 0:              # end of a day
            dRM.append(rm)
            dFG.append(fg)
            dSlab.append(st['slab'])
        hour_out += out
        hour_slab += slabMake if work and slabOn else 0.0
        hour_sp += fromPlant
        hour_sy += fromYard
        if trace and (k + 1) % spH == 0:    # the playback record stays hourly
            tr['rm'].append(round(rm))
            tr['fg'].append(round(fg))
            tr['prod'].append(round(hour_out))
            tr['imp'].append(round(st['imported']))
            tr['exp'].append(round(st['exported']))
            if slabOn:
                tr['slab'].append(round(st['slab']))
                tr['slabExp'].append(round(st['slabExp']))
                tr['slabMade'].append(round(hour_slab))
                tr['smsPlant'].append(round(hour_sp))   # HBI to the SMS straight from the plant
                tr['smsYard'].append(round(hour_sy))    # HBI to the SMS from the HBI yard
            tr['tugs'].append(int(tugsAvail - tugs))
            tr['ships'].append([[s.n, PHASE_CODE[s.phase], round(s.rem), s.ai, int(s.tugNow)] for s in berth])
        if (k + 1) % spH == 0:
            hour_out = hour_slab = hour_sp = hour_sy = 0.0

    yr_work_h = cal['nWork'] * 24
    berths = berths_for(P, im + ex + sl)
    # Occupancy from each ship's actual time alongside (berthing to sailing) inside the year
    alongside = [(s, max(0.0, min(s.departH if s.departH is not None else NH, YH) - max(0, s.berthH))) for s in log]
    shipH = sum(a for _, a in alongside)
    lenH = sum(a * s.loa for s, a in alongside)
    occ = shipH / (yr_work_h * berths) * 100 if yr_work_h else 0
    len_occ = lenH / (yr_work_h * jettyLen) * 100 if yr_work_h else 0
    # One year for imports from the first arrival, and for exports from the first departure
    gone = [s for s in log if s.phase == 'done']
    first_imp = next((s for s in log if s.dir == 'I'), None)
    first_arr = max(0, first_imp.berthH) if first_imp else 0
    exp_gone = [s for s in gone if s.dir == 'E']
    first_dep = min(s.departH for s in exp_gone) if exp_gone else None

    def fl(hh):
        """Step index at or before time hh (hours)."""
        return math.floor(hh * spH + (1e-6 if spH > 1 else 0))

    def at(arr, hh):
        return arr[max(0, min(NS, fl(hh)))]

    # The first export ship loads before it sails, so its own cargo counts: the export year runs
    # from that ship's cargo start until one year after the first departure
    exp_first = next((s for s in exp_gone if s.departH == first_dep), None)
    exp_from = fl(exp_first.cargoStartH) / spH if exp_first else 0
    exp_to = YH if first_dep is None else fl(first_dep) / spH + YH
    imported = at(cumI, first_arr + YH) - at(cumI, first_arr)
    exported = at(cumE, exp_to) - at(cumE, exp_from)
    # Slab: one year from the first slab sailing, counted the same way as the HBI exports
    slab_gone = [s for s in gone if s.dir == 'L']
    first_slab = min((s for s in slab_gone), key=lambda s: s.departH, default=None)
    slab_from = fl(first_slab.cargoStartH) / spH if first_slab else 0
    slab_to = YH if first_slab is None else fl(first_slab.departH) / spH + YH
    slab_exported = at(cumL, slab_to) - at(cumL, slab_from) if slabOn else 0.0
    carried = [s for s in log if s.berthH < YH and (s.phase != 'done' or s.departH > YH)]
    avg_turn = sum(s.departH - s.berthH for s in gone) / len(gone) if gone else 0
    avg_idle = sum(s.idle + s.waitTug for s in log) / len(log) if log else 0
    tol = P['tol'] / 100
    reasons, warnings = [], []
    if imported < rmTarget * (1 - tol):
        reasons.append(f'RM import short by {fmt_t(rmTarget - imported)} ({fmt_n(imported / rmTarget * 100, 1)}% of target)')
    if exported < fgTarget * (1 - tol):
        reasons.append(f'HBI export short by {fmt_t(fgTarget - exported)} ({fmt_n(exported / fgTarget * 100, 1)}% of target)')
    if stockoutH > 0:
        reasons.append(f'Plant starved of RM for {fmt_n(stockoutH)} h')
    if fgFullH > 0:
        reasons.append(f'HBI yard full for {fmt_n(fgFullH)} h, {fmt_t(lost)} production lost')
    if slabOn and slab_exported < slabTarget * (1 - tol):
        reasons.append(f'Slab export short by {fmt_t(slabTarget - slab_exported)} ({fmt_n(slab_exported / slabTarget * 100, 1)}% of target)')
    if slabFullH > 0:
        reasons.append(f'Slab yard full for {fmt_n(slabFullH)} h, SMS stopped')
    if smsShortH > 0:
        reasons.append(f'SMS short of HBI for {fmt_n(smsShortH)} h')
    if occ > P['maxOcc']:
        reasons.append(f'Berth occupancy {fmt_n(occ, 1)}% is above the {fmt_n(P["maxOcc"], 0)}% limit')
    if belowSafeH > 0:
        warnings.append(f'RM stock below safety level for {fmt_n(belowSafeH)} h (lowest {fmt_t(minRM)})')
    if carried:
        warnings.append(f'{len(carried)} vessel(s) still alongside at the end of day {yd}')
    if exp_to > NH:
        warnings.append('First export sailing came late; the export year runs past the simulated period')
    if slabOn and slab_to > NH:
        warnings.append('First slab sailing came late; the slab year runs past the simulated period')
    if maxFG > fgCap * 0.95 and not fgFullH:
        warnings.append(f'HBI yard peaked at {fmt_n(maxFG / fgCap * 100, 0)}% of capacity')
    return {
        'im': im, 'ex': ex, 'sl': sl, 'inelig': False, 'feasible': not reasons, 'reasons': reasons, 'warnings': warnings,
        'imported': imported, 'exported': exported, 'slabExported': slab_exported,
        'impCalls': sum(1 for s in log if s.dir == 'I'), 'expCalls': sum(1 for s in log if s.dir == 'E'),
        'slabCalls': sum(1 for s in log if s.dir == 'L'), 'slabFullH': slabFullH, 'smsShortH': smsShortH, 'slabMade': slabMade,
        'maxSlab': maxSlab, 'dSlab': dSlab, 'endSlab': dSlab[yd - 1],
        'firstSlabDep': first_slab.departH if first_slab else None,
        'occ': occ, 'lenOcc': len_occ, 'berths': berths, 'stockoutH': stockoutH, 'fgFullH': fgFullH,
        'belowSafeH': belowSafeH, 'lost': lost, 'produced': produced, 'minRM': minRM, 'maxRM': maxRM,
        'maxFG': maxFG, 'avgTurn': avg_turn, 'avgIdle': avg_idle,
        'log': [s.as_dict() for s in log], 'dRM': dRM, 'dFG': dFG, 'endRM': dRM[yd - 1], 'endFG': dFG[yd - 1],
        'carried': len(carried), 'workH': workH, 'NH': NH, 'firstArr': first_arr, 'firstDep': first_dep,
        'expFrom': exp_from, 'expTo': exp_to, 'trace': tr,
    }


def analytic(ctx: dict, m: str, direction: str) -> dict:
    P, el, rt = ctx['P'], ctx['el'], ctx['rt']
    rate = {'I': rt['imp'], 'E': rt['exp'], 'L': rt['slab']}[direction]
    target = {'I': P['rmTarget'], 'E': P['fgTarget'], 'L': P['slabTarget']}[direction]
    pk = 'slabParcel' if direction == 'L' else 'parcel'
    parcel = sum(el[t][pk] for t in m) / len(m)
    nc = sum(a['h'] for a in P['acts'])
    calls = math.ceil(target / parcel) if parcel > 0 else 0
    cargo_h = parcel / rate if rate > 0 else math.inf
    return {'parcel': parcel, 'calls': calls, 'cargoH': cargo_h, 'nc': nc, 'per': cargo_h + nc,
            'total': calls * (cargo_h + nc), 'eqH': calls * cargo_h}


def desk_plan(ctx: dict, im: str, ex: str, sl: str = '') -> dict:
    """Step 1A: average-based shipment plan and checks for one import x export (x slab) combination."""
    P, cal, el, rt = ctx['P'], ctx['cal'], ctx['el'], ctx['rt']
    if not P['slabOn']:
        sl = ''
    prod = P['driCap'] * 1e6 * P['plantUtil'] / 100
    rm_need = prod * P['rmRatio']
    jh = cal['nWork'] * 24
    A, E = analytic(ctx, im, 'I'), analytic(ctx, ex, 'E')
    SL = analytic(ctx, sl, 'L') if sl else None
    berths = berths_for(P, im + ex + sl)
    occ = (A['total'] + E['total'] + (SL['total'] if SL else 0)) / (jh * berths) * 100
    elig_i = all(el[t]['ok'] for t in im)
    elig_e = all(el[t]['ok'] for t in ex) and all(el[t]['ok'] for t in sl)
    yd = cal['yearDays']
    dom = ''
    sms_dri = P['smsRate'] * jh * P['slabDriRatio'] if sl else 0
    sms = f' + {fmt_t(sms_dri)} to SMS for {fmt_t(P["smsRate"] * jh)} slab' if sl else ''
    checks = [
        [elig_i and elig_e, 'Selected ship classes fit the jetty'],
        [prod >= P['fgTarget'] + sms_dri,
         f'DRI output {fmt_t(prod)} covers {fmt_t(P["fgTarget"])} HBI export{sms}{dom}'],
        [P['rmTarget'] + P['rmInit'] - P['rmSafety'] >= rm_need,
         f'RM import + opening stock above safety ({fmt_t(P["rmTarget"] + P["rmInit"] - P["rmSafety"])}) covers plant use {fmt_t(rm_need)}'],
        [A['eqH'] <= jh, f'SUL hours needed {fmt_n(A["eqH"])} h ≤ jetty working hours {fmt_n(jh)} h'],
        [E['eqH'] <= jh, f'Loader hours needed {fmt_n(E["eqH"])} h ≤ jetty working hours {fmt_n(jh)} h'],
    ]
    if SL:
        checks.append([SL['eqH'] <= jh, f'Slab crane hours needed {fmt_n(SL["eqH"])} h ≤ jetty working hours {fmt_n(jh)} h'])
    checks.append([occ <= P['maxOcc'], f'Berth occupancy {fmt_n(occ, 1)}% on {berths} berth position{"s" if berths > 1 else ""} ≤ {fmt_n(P["maxOcc"])}% limit'])
    # every set of 1-3 ships alongside together
    sets = []
    for a in range(3):
        sets.append([a])
        for b in range(a, 3):
            sets.append([a, b])
            for c in range(b, 3):
                sets.append([a, b, c])
    sets.sort(key=lambda s: (len(s), ','.join(map(str, s))))
    fit_rows = []
    for s in sets:
        ks = [SHIP_KEYS[i] for i in s]
        L = len_needed(P, [P['ships'][k]['loa'] for k in ks])
        fit_rows.append({'ships': ' + '.join(P['ships'][k]['name'] for k in ks), 'count': len(ks), 'length': L,
                         'spare': P['jettyLen'] - L, 'fits': L <= P['jettyLen'] and all(el[k]['ok'] for k in ks)})
    type_rows = []
    for d in ('I', 'E', 'L') if P['slabOn'] else ('I', 'E'):
        for k in SHIP_KEYS:
            a = analytic(ctx, k, d)
            type_rows.append({'dir': d, 'ship': k, 'name': P['ships'][k]['name'], 'parcel': a['parcel'], 'calls': a['calls'],
                              'perMonth': a['calls'] / 12, 'cargoH': a['cargoH'], 'nc': a['nc'], 'per': a['per'],
                              'berthDays': a['total'] / 24, 'share': a['total'] / jh * 100 if jh else 0,
                              'ok': el[k]['ok'],
                              'selected': P['ships'][k].get({'I': 'imp', 'E': 'exp', 'L': 'slab'}[d], True) is not False})
    big_i = max((P['ships'][c] for c in im), key=lambda s: s['loa'])
    big_e = max((P['ships'][c] for c in ex), key=lambda s: s['loa'])
    pair_len = len_needed(P, [big_i['loa'], big_e['loa']])
    return {
        'ok': all(c[0] for c in checks), 'checks': checks,
        'kpis': {'nWork': cal['nWork'], 'impRate': rt['imp'], 'expRate': rt['exp'],
                 'needImp': P['rmTarget'] / jh, 'needExp': P['fgTarget'] / jh, 'prod': prod, 'rmNeed': rm_need,
                 'rmCover': P['rmYardCap'] / (rm_need / cal['nWork']), 'fgCover': P['fgYardCap'] / (prod / cal['nWork']),
                 'impCalls': A['calls'], 'expCalls': E['calls'],
                 'slab': bool(sl), 'slabRate': rt['slab'], 'needSlab': P['slabTarget'] / jh if sl else 0,
                 'slabCalls': SL['calls'] if SL else 0, 'smsDri': sms_dri,
                 'slabCover': P['slabYardCap'] / (P['smsRate'] * 24) if sl and P['smsRate'] else 0},
        'eligibility': [{'key': k, 'name': P['ships'][k]['name'], 'loa': P['ships'][k]['loa'], 'dwt': P['ships'][k]['dwt'],
                         'util': P['ships'][k]['util'], 'parcel': el[k]['parcel'], 'lenOk': el[k]['lenOk'],
                         'tugOk': el[k]['tugOk'], 'ok': el[k]['ok']} for k in SHIP_KEYS],
        'fits': fit_rows, 'types': type_rows,
        'pair': {'imp': {'name': big_i['name'], 'loa': big_i['loa']}, 'exp': {'name': big_e['name'], 'loa': big_e['loa']},
                 'length': pair_len, 'fits': pair_len <= P['jettyLen'],
                 'endM': big_i['loa'] * P['endPct'] / 100, 'gapM': max(big_i['loa'], big_e['loa']) * P['gapPct'] / 100},
    }


def run_all(P: dict) -> tuple[dict, dict]:
    """Simulate every allowed import x export (x slab) combination.
    Returns (context, results keyed 'IM|EX|SL'; SL is '' when slab export is off)."""
    ctx = make_context(P)
    combos = [(i, e, l) for i in mixes_for(P, 'imp') for e in mixes_for(P, 'exp') for l in mixes_for(P, 'slab')]
    if len(combos) > 49 or P.get('stepMin', 60) < 60:
        # slab runs (up to 343 combinations) and 6-minute runs are shared out over the CPU cores
        from concurrent.futures import ProcessPoolExecutor
        with ProcessPoolExecutor(max_workers=min(8, os.cpu_count() or 1)) as pool:
            out = list(pool.map(_simulate_job, [(P, c) for c in combos], chunksize=8))
    else:
        out = [simulate(ctx, *c) for c in combos]
    return ctx, {f'{i}|{e}|{l}': r for (i, e, l), r in zip(combos, out)}


def _simulate_job(job):
    P, combo = job
    return simulate(make_context(P), *combo)

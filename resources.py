"""Extra resources: when a ship combination is NO, find the smallest additions that turn it YES.

Three kinds of resource can be added, in the order of priority the user sets:
  jetty  - extra jetty length, in steps of metres
  equip  - extra ship unloaders (SUL), ship loaders and, with slab export, slab cranes, one machine per step
  yard   - extra RM, HBI (and slab) yard space, as a percentage of each yard per step

This module does not change the planner's calculation: it runs engine.simulate unchanged on copies of the
run's inputs with the extra resources added.
"""
from __future__ import annotations

import copy

from . import engine

CATS = ('jetty', 'equip', 'yard')
LIMITS = {'jettyStep': 25, 'jettyMax': 300, 'equipMax': 4, 'yardStepPct': 10, 'yardMaxPct': 100}
UNIT_NAME = {'sulN': 'ship unloader (SUL)', 'loaderN': 'ship loader', 'slabCraneN': 'slab crane'}


def _limits(raw: dict | None) -> dict:
    L = dict(LIMITS)
    for k in L:
        if raw and raw.get(k) is not None:
            try:
                L[k] = max(0.0, float(raw[k]))
            except (TypeError, ValueError):
                raise ValueError(f'{k} must be a number')
    if L['jettyStep'] <= 0 or L['yardStepPct'] <= 0:
        raise ValueError('Step sizes must be above zero')
    L['equipMax'] = int(L['equipMax'])
    return L


def _summary(r: dict) -> dict:
    keys = ('feasible', 'inelig', 'reasons', 'warnings', 'occ', 'berths', 'imported', 'exported', 'slabExported',
            'impCalls', 'expCalls', 'slabCalls', 'stockoutH', 'fgFullH', 'slabFullH', 'avgIdle', 'minRM', 'maxFG')
    return {k: r.get(k) for k in keys}


def _score(r: dict) -> tuple:
    """Lower is better: fewer failed checks first, then lower occupancy."""
    return (0 if r['feasible'] else 1, len(r['reasons']), r.get('occ') or 1e9)


def find(P0: dict, im: str, ex: str, sl: str = '', order=CATS, limits: dict | None = None) -> dict:
    order = [c for c in order if c in CATS]
    if sorted(order) != sorted(CATS):
        raise ValueError('Priority must list jetty, equip and yard once each')
    L = _limits(limits)
    units = ['sulN', 'loaderN'] + (['slabCraneN'] if P0.get('slabOn') and sl else [])
    n_lv = {'jetty': int(L['jettyMax'] // L['jettyStep']) + 1, 'equip': L['equipMax'] + 1,
            'yard': int(L['yardMaxPct'] // L['yardStepPct']) + 1}
    cache: dict = {}
    eq_seq: list[str] = []

    def inputs(lv: dict) -> dict:
        P = copy.deepcopy(P0)
        P['jettyLen'] = P0['jettyLen'] + lv['jetty'] * L['jettyStep']
        for u in eq_seq[:lv['equip']]:
            P[u] = P[u] + 1
        f = 1 + lv['yard'] * L['yardStepPct'] / 100
        for k in ('rmYardCap', 'fgYardCap', 'slabYardCap'):
            P[k] = P0[k] * f
        return P

    def run(lv: dict) -> dict:
        key = (lv['jetty'], lv['equip'], lv['yard'])
        if key not in cache:
            P = inputs(lv)
            cache[key] = engine.simulate(engine.make_context(P), im, ex, sl)
        return cache[key]

    base = engine.simulate(engine.make_context(P0), im, ex, sl)
    cache[(0, 0, 0)] = base

    # Which machine to add at each equipment step: try each kind on top of the machines already added and
    # keep the one that helps most (judged with no extra jetty length or yard space).
    for _ in range(L['equipMax']):
        best = None
        for u in units:
            P = copy.deepcopy(P0)
            for v in eq_seq + [u]:
                P[v] = P[v] + 1
            r = engine.simulate(engine.make_context(P), im, ex, sl)
            if best is None or _score(r) < best[0]:
                best = (_score(r), u)
        eq_seq.append(best[1])

    def minimal(first: str, fixed: dict) -> int | None:
        """Smallest level of `first` that gives YES with the other levels fixed (assumes more never hurts)."""
        top = n_lv[first] - 1
        if not run({**fixed, first: top})['feasible']:
            return None
        lo, hi = 0, top
        while lo < hi:
            mid = (lo + hi) // 2
            if run({**fixed, first: mid})['feasible']:
                hi = mid
            else:
                lo = mid + 1
        return lo

    found = None
    if not base['feasible'] and not base['inelig']:
        # Use the top-priority resource as much as needed and the lower-priority ones as little as possible:
        # walk the lowest priority up from zero, then the middle one, and for each find the least top-priority.
        a, b, c = order
        for lc in range(n_lv[c]):
            for lb in range(n_lv[b]):
                la = minimal(a, {b: lb, c: lc})
                if la is not None:
                    found = {a: la, b: lb, c: lc}
                    break
            if found:
                break

    alone = {}
    if not base['feasible'] and not base['inelig']:
        for cat in CATS:
            lvl = minimal(cat, {k: 0 for k in CATS if k != cat})
            alone[cat] = None if lvl is None else {'level': lvl, **_describe(P0, {**{k: 0 for k in CATS}, cat: lvl}, eq_seq, L),
                                                   'result': _summary(run({**{k: 0 for k in CATS}, cat: lvl}))}

    out = {'base': _summary(base), 'order': order, 'limits': L, 'units': units, 'eqSeq': eq_seq,
           'eqSeqNames': [UNIT_NAME[u] for u in eq_seq], 'tried': len(cache), 'alone': alone, 'found': None, 'best': None}
    if found:
        out['found'] = {'levels': found, **_describe(P0, found, eq_seq, L), 'result': _summary(run(found))}
    elif not base['feasible'] and not base['inelig']:
        # closest: fewest failed checks, then the smallest addition, then the lowest occupancy
        key = min(cache, key=lambda k: (len(cache[k]['reasons']), sum(k), cache[k].get('occ') or 1e9))
        lv = dict(zip(('jetty', 'equip', 'yard'), key))
        out['best'] = {'levels': lv, **_describe(P0, lv, eq_seq, L), 'result': _summary(cache[key])}
    if not base['feasible'] and not base['inelig']:
        tops = {c: n_lv[c] - 1 for c in CATS}
        zero = {k: 0 for k in CATS}
        at_max = {c: run({**zero, c: tops[c]}) for c in CATS}
        at_max['all'] = run(tops)
        out['atMax'] = {c: {**_describe(P0, tops if c == 'all' else {**zero, c: tops[c]}, eq_seq, L), 'result': _summary(rr)}
                        for c, rr in at_max.items()}
        out['diagnosis'] = _diagnose(P0, im, ex, sl, at_max)
    return out


def _periods(flags: list) -> list:
    """Runs of True as (first hour, number of hours)."""
    out, start = [], None
    for h, f in enumerate(list(flags) + [False]):
        if f and start is None:
            start = h
        elif not f and start is not None:
            out.append((start, h - start))
            start = None
    return out


def _diagnose(P0: dict, im: str, ex: str, sl: str, at_max: dict) -> list:
    """For each failed check: what happened, why, what the most of each resource did, and what would fix it."""
    ctx = engine.make_context(P0)
    r = engine.simulate(ctx, im, ex, sl, trace=True)
    tr, log, cal = r['trace'], r['log'], ctx['cal']
    hours = cal['yearDays'] * 24
    q = P0['driCap'] * 1e6 * P0['plantUtil'] / 100 / hours
    u = q * P0['rmRatio']
    tol = P0['tol'] / 100
    pre = [a for a in P0['acts'] if a['phase'] == 'pre']
    fmt_t, fmt_n = engine.fmt_t, engine.fmt_n
    out = []

    def effect(key, fmt):
        base_v = r.get(key) or 0
        return {c: {'value': at_max[c].get(key), 'text': fmt(at_max[c].get(key) or 0),
                    'changed': abs((at_max[c].get(key) or 0) - base_v) > 1e-6} for c in at_max}

    # plant starved of RM
    if r['stockoutH'] > 0:
        # the plant draws RM at the start of each hour, before that hour's discharge reaches the yard
        starved = [h < hours and p < q - 1e-6 and (tr['rm'][h - 1] if h else P0['rmInit']) < u for h, p in enumerate(tr['prod'])]
        per = _periods(starved)
        first_imp = next((s for s in log if s['dir'] == 'I'), None)
        lost = sum(q - tr['prod'][h] for h, f in enumerate(starved) if f)
        start_up = bool(per) and per[0][0] == 0 and first_imp is not None
        item = {'check': 'stockoutH', 'title': f'Plant starved of RM for {fmt_n(r["stockoutH"])} h',
                'periods': [{'start': a, 'hours': k} for a, k in per], 'verified': None,
                'effects': effect('stockoutH', lambda v: f'{fmt_n(v)} h'),
                'facts': [f'The plant needs {fmt_n(u, 1)} t of RM every hour ({fmt_n(q, 1)} t of DRI × {fmt_n(P0["rmRatio"], 2)} t RM per t).',
                          f'About {fmt_t(lost)} of DRI is not made in those hours.']}
        if start_up:
            cs = first_imp['cargoStartH']
            steps = ', '.join(f'{a["n"].lower()} {fmt_n(a["h"], 1)} h' for a in pre)
            item['facts'] += [
                f'RM opening stock is {fmt_t(P0["rmInit"])}: enough for {fmt_n(P0["rmInit"] / u, 1)} h of the plant.',
                f'The first import ship arrives at 00:00 on day 1. Before it can discharge it goes through: {steps}'
                + (f', plus {fmt_n(first_imp["waitTug"], 1)} h waiting for tugs' if first_imp['waitTug'] else '')
                + f'. Its discharge starts at hour {fmt_n(cs, 1)}.',
                'In every hour the plant takes its RM first and the RM discharged in that hour reaches the yard after it, '
                f'so the hour in which discharge begins is short as well: hours 0 to {fmt_n(per[0][1] - 1)}, '
                f'{fmt_n(per[0][1])} h with no RM for the plant.']
            item['cause'] = ("Start-up gap. The plant starts at full rate at 00:00, but the first RM reaches the yard only after the first "
                             "ship's non-cargo steps. With no or too little opening stock the plant stops until then.")
            item['resourceWhy'] = {
                'jetty': "More jetty length lets more ships lie alongside together, but the first ship still has to finish its berthing and clearance steps before any RM comes off it.",
                'equip': 'More SULs discharge faster once discharge has started; they cannot start it earlier.',
                'yard': f'A bigger RM yard can hold more, but it still starts the year with {fmt_t(P0["rmInit"])} in it.'}
            need = None
            for step in range(1, 400):
                P = copy.deepcopy(P0)
                P['rmInit'] = step * 1000.0
                rr = engine.simulate(engine.make_context(P), im, ex, sl)
                if rr['stockoutH'] == 0:
                    need = (P['rmInit'], rr)
                    break
            if need:
                item['fix'] = (f'Hold an RM opening stock of at least {fmt_t(need[0])} '
                               f'({fmt_n(u, 1)} t/h × {fmt_n(per[0][1])} h = {fmt_t(u * per[0][1])}, rounded up to the next 1,000 t). '
                               'This is a plant-side input, not a jetty resource.')
                item['verified'] = {'rmInit': need[0], 'stockoutH': need[1]['stockoutH'], 'feasible': need[1]['feasible'],
                                    'reasons': need[1]['reasons'], 'occ': need[1]['occ']}
            else:
                item['fix'] = 'More RM opening stock.'
        else:
            item['facts'].append('RM ran out between ships during the year: imports did not arrive or discharge fast enough to keep up with the plant.')
            item['cause'] = 'Import supply gap during the year.'
            item['resourceWhy'] = {'jetty': 'Helps only if more import ships can then discharge at the same time.',
                                   'equip': 'More SULs bring RM in faster.',
                                   'yard': 'A bigger RM yard holds more stock to bridge the gaps between ships.'}
            item['fix'] = 'Faster or more frequent imports, or more RM stock in the yard to bridge the gaps.'
        out.append(item)

    # berth occupancy above the limit
    if r['occ'] > P0['maxOcc']:
        bh = {d: sum(max(0.0, min(s['departH'] if s['departH'] is not None else r['NH'], hours) - s['berthH'])
                     for s in log if s['dir'] == d) for d in 'IEL'}
        out.append({'check': 'occ', 'title': f'Berth occupancy {fmt_n(r["occ"], 1)}% is above the {fmt_n(P0["maxOcc"])}% limit',
                    'periods': [], 'verified': None, 'effects': effect('occ', lambda v: f'{fmt_n(v, 1)}%'),
                    'facts': [f'The jetty has {fmt_n(hours)} h × {r["berths"]} berth positions = {fmt_n(hours * r["berths"])} berth-hours a year; '
                              f'the {fmt_n(P0["maxOcc"])}% limit allows {fmt_n(hours * r["berths"] * P0["maxOcc"] / 100)} h.',
                              f'Ships use {fmt_n(sum(bh.values()))} h: import {fmt_n(bh["I"])} h, HBI export {fmt_n(bh["E"])} h'
                              + (f', slab {fmt_n(bh["L"])} h' if bh['L'] else '') + '.'],
                    'cause': 'Ships stay alongside too long for the berth positions available: cargo hours (set by the handling rates), non-cargo hours and waiting.',
                    'resourceWhy': {'jetty': 'Extra length adds a berth position only when a whole extra ship fits and a SUL, loader or crane is free for it.',
                                    'equip': 'More machines shorten cargo time and allow another ship of that cargo alongside.',
                                    'yard': 'Yard space does not change how long ships stay alongside.'},
                    'fix': 'Shorter stays (faster equipment, less waiting) or more berth positions (jetty length together with a machine for the extra ship).'})

    # yards full
    for key, name, cap_key in (('fgFullH', 'HBI yard', 'fgYardCap'), ('slabFullH', 'Slab yard', 'slabYardCap')):
        if (r.get(key) or 0) > 0:
            out.append({'check': key, 'title': f'{name} full for {fmt_n(r[key])} h', 'periods': [], 'verified': None,
                        'effects': effect(key, lambda v: f'{fmt_n(v)} h'),
                        'facts': [f'The {name.lower()} holds {fmt_t(P0[cap_key])}.'],
                        'cause': 'Ships do not take the cargo away as fast as it is made, so the yard fills and production has to slow down.',
                        'resourceWhy': {'jetty': 'Helps only if more ships of this cargo can then load at once.',
                                        'equip': 'More loaders or cranes take the cargo away faster.',
                                        'yard': 'More space lets the yard absorb the gaps between ships.'},
                        'fix': 'A bigger yard, faster loading, or calling ships earlier (lower export trigger).'})

    # targets not reached
    for key, name, tgt in (('imported', 'RM import', P0['rmTarget']), ('exported', 'HBI export', P0['fgTarget']),
                           ('slabExported', 'Slab export', P0['slabTarget'] if sl else 0)):
        if tgt and (r.get(key) or 0) < tgt * (1 - tol):
            made = q * hours
            short_product = key == 'exported' and made < tgt
            out.append({'check': key, 'title': f'{name} short by {fmt_t(tgt - r[key])}', 'periods': [], 'verified': None,
                        'effects': effect(key, fmt_t),
                        'facts': [f'{fmt_t(r[key])} moved in its one-year window against {fmt_t(tgt)} ({fmt_n(r[key] / tgt * 100, 1)}%).']
                        + ([f'The plant only makes {fmt_t(made)} of DRI a year.'] if short_product else []),
                        'cause': 'Not enough product: the plant makes less than the target.' if short_product
                        else 'Ships could not be handled fast enough within the year.',
                        'resourceWhy': {'jetty': '', 'equip': '', 'yard': ''},
                        'fix': 'More plant output or a lower export target.' if short_product else 'More handling capacity or berth time, or a lower target.'})
    return out


def _describe(P0: dict, lv: dict, eq_seq: list, L: dict) -> dict:
    add = {u: eq_seq[:lv['equip']].count(u) for u in ('sulN', 'loaderN', 'slabCraneN')}
    f = 1 + lv['yard'] * L['yardStepPct'] / 100
    return {
        'jetty': {'add': lv['jetty'] * L['jettyStep'], 'from': P0['jettyLen'], 'to': P0['jettyLen'] + lv['jetty'] * L['jettyStep']},
        'equip': {u: {'add': add[u], 'from': P0[u], 'to': P0[u] + add[u]} for u in add},
        'yard': {'pct': lv['yard'] * L['yardStepPct'],
                 **{k: {'from': P0[k], 'to': P0[k] * f, 'add': P0[k] * (f - 1)} for k in ('rmYardCap', 'fgYardCap', 'slabYardCap')}},
    }

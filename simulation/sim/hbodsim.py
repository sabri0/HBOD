"""
hbodsim: in silico evaluation of athlete-monitoring decision engines.

Data-generating model (DGM)
  - squad training plan (football-like microcycle, periodisation, congested block, shock weeks)
  - athlete physiology: variable dose-response model (Busso 2003) with fitness g, fatigue h and
    a time-varying fatigue gain k2
  - competing health events: injury (hazard driven by fatigue and/or true load spikes, mixture phi)
    and illness (exposure hazard, incubation with prodromal symptoms, progression)
  - observation: session duration and CR-10 RPE (sRPE), four ordinal Hooper items (ordered probit),
    reporting styles (honest, under-reporter, compressor, careless) and MCAR/MNAR missingness

Decision engines (streaming, vectorised across athletes) are in engines.py.
All random numbers are drawn up front per component (common random numbers across policies).
"""
import numpy as np
from scipy.special import expit, logit

T_DAYS = 238          # 34 weeks
EVAL_START = 42       # first evaluated day (chronic windows full)
A_PER_SQUAD = 25
LIFE_ILL = 0.3        # log-odds effect of life stress on illness exposure (0 in the sensitivity run)

# ---------------------------------------------------------------- parameter space
# name: (low, high)   uniform priors; see Table 1 of the manuscript for sources
PRIORS = {
    # load and plan
    "W0":        (2000.0, 3800.0),   # planned weekly sRPE (AU)
    "shock_p":   (0.0, 1.0),         # probability that a squad has a shock (camp) block
    # physiology (Banister / Busso)
    "tau_g":     (25.0, 55.0),       # fitness time constant (days)
    "tau_h":     (5.0, 20.0),        # fatigue time constant (days)
    "tau_k":     (2.0, 10.0),        # time constant of the fatigue gain (days)
    "k_ratio":   (1.5, 3.0),         # typical fatigue gain / fitness gain
    # injury hazard
    "a_inj":     (-8.5, -4.5),       # baseline log-odds per day [calibrated]
    "beta":      (0.3, 0.9),         # log-OR per SD of the mechanism signal
    "phi":       (0.0, 1.0),         # mechanism mix: 0 = latent fatigue, 1 = true load spike
    "beta_g":    (-0.3, 0.0),        # protective effect of fitness (log-OR per SD)
    "d_inj":     (5.0, 12.0),        # median injury duration (days) [calibrated]
    "b_match":   (0.0, 1.2),         # extra log-odds of injury on a played match day
    # illness
    "a_ill":     (-8.0, -4.0),       # baseline log-odds of exposure per day [calibrated]
    "beta_ill":  (0.1, 0.6),         # log-OR per SD of fatigue for illness exposure
    "prog":      (0.5, 0.9),         # probability that an exposure progresses to time loss
    "prodrome":  (0.0, 1.0),         # SD shift of fatigue/sleep items during incubation
    "d_ill":     (3.0, 6.0),         # median illness duration (days)
    # wellness and reporting
    "lam_w":     (0.4, 1.2),         # sensitivity of Hooper items to latent fatigue (SD per SD)
    "s_under":   (0.0, 0.4),         # share of under-reporters
    "rho_under": (0.3, 0.8),         # shrinkage of adverse deviations in under-reporters
    "s_comp":    (0.0, 0.2),         # share of compressors (central tendency)
    "s_care":    (0.0, 0.1),         # share of careless responders
    "m0":        (0.05, 0.40),       # baseline missing-day rate
    "nu":        (0.0, 1.0),         # MNAR strength (log-odds of missing per SD of fatigue)
}
PNAMES = list(PRIORS)


def sample_priors(n, rng):
    lo = np.array([PRIORS[k][0] for k in PNAMES]); hi = np.array([PRIORS[k][1] for k in PNAMES])
    X = lo + (hi - lo) * rng.random((n, len(PNAMES)))
    return X


def as_dict(X):
    X = np.atleast_2d(X)
    return {k: X[:, i] for i, k in enumerate(PNAMES)}


# ---------------------------------------------------------------- training plan
# weekly template relative to match day (MD). index 0 = MD+1 ... index 6 = MD
TEMPLATE_FRAC = np.array([0.08, 0.00, 0.22, 0.20, 0.15, 0.08, 0.27])
TEMPLATE_DUR = np.array([45., 0., 85., 80., 70., 50., 95.])


def build_plans(P, rng):
    """Squad-level planned load (W, T), duration (W, T), match flag (W, T)."""
    W = len(P["W0"]); T = T_DAYS
    weeks = T // 7
    frac = np.tile(TEMPLATE_FRAC, weeks)[None, :].repeat(W, 0)
    dur = np.tile(TEMPLATE_DUR, weeks)[None, :].repeat(W, 0)
    match = np.zeros((W, T), bool); match[:, 6::7] = True
    # periodisation multipliers by week
    mult = np.ones((W, weeks))
    pre = np.array([0.80, 0.95, 1.10, 1.20])
    mult[:, :4] = pre
    cycle = np.array([1.00, 1.05, 1.10, 0.85])
    for w in range(4, weeks):
        mult[:, w] = cycle[(w - 4) % 4]
    mult *= np.exp(0.05 * rng.standard_normal((W, weeks)))
    # shock (camp) block: one or two weeks x1.3 to x1.5, starting between the 9th and 27th week
    has_shock = rng.random(W) < P["shock_p"]
    start = rng.integers(8, 27, W); length = rng.integers(1, 3, W); size = rng.uniform(1.3, 1.5, W)
    for i in np.where(has_shock)[0]:
        mult[i, start[i]:start[i] + length[i]] *= size[i]
    # congested block weeks 14-16: second match replaces MD-3 session
    for w in range(14, 17):
        d = 7 * w + 3
        frac[:, d] = 0.27; dur[:, d] = 95.; match[:, d] = True
        frac[:, d + 1] = 0.08; dur[:, d + 1] = 45.
    plan = frac * np.repeat(mult, 7, axis=1)[:, :T] * P["W0"][:, None]
    plan *= np.exp(0.10 * rng.standard_normal((W, T)))      # squad day noise
    plan[frac == 0] = 0.0
    return plan, dur, match


# ---------------------------------------------------------------- random streams (CRN)
def draw_streams(N, rng):
    T = T_DAYS
    f = np.float32
    S = {
        "e_load": rng.standard_normal((N, T)).astype(f),
        "u_inj": rng.random((N, T)).astype(f),
        "u_ill": rng.random((N, T)).astype(f),
        "u_prog": rng.random((N, T)).astype(f),
        "inc_len": rng.integers(2, 5, (N, T)).astype(np.int8),
        "z_dur": rng.standard_normal((N, T)).astype(f),
        "e_rpe": rng.standard_normal((N, T)).astype(f),
        "e_well": rng.standard_normal((N, T, 4)).astype(f),
        "u_miss": rng.random((N, T)).astype(f),
        "u_care": rng.random((N, T)).astype(f),
        "care_cat": rng.integers(1, 8, (N, T, 4)).astype(np.int8),
        "e_life": rng.standard_normal((N, T)).astype(f),
    }
    return S


def athlete_traits(P, widx, rng):
    N = len(widx)
    tr = {}
    tr["starter"] = rng.random(N) < 0.6
    tr["mult"] = np.exp(0.10 * rng.standard_normal(N))
    tr["u_inj"] = 0.5 * rng.standard_normal(N)        # frailty (log-odds)
    tr["u_ill"] = 0.5 * rng.standard_normal(N)
    tr["base"] = -0.5 + 0.5 * rng.standard_normal((N, 4))   # item baselines
    tr["m0_i"] = expit(logit(P["m0"][widx]) + 0.8 * rng.standard_normal(N))
    r = rng.random(N)
    su, sc, sk = P["s_under"][widx], P["s_comp"][widx], P["s_care"][widx]
    style = np.zeros(N, np.int8)                       # 0 honest
    style[r < su] = 1                                  # under-reporter
    style[(r >= su) & (r < su + sc)] = 2               # compressor
    style[(r >= su + sc) & (r < su + sc + sk)] = 3     # careless
    tr["style"] = style
    return tr


CUTS = np.array([-2.0, -1.2, -0.4, 0.4, 1.2, 2.0])
# item order: sleep, stress, fatigue, soreness  (1 = best, 7 = worst)
LAM_ITEM = np.array([0.4, 0.3, 0.8, 0.7])
KAP_ITEM = np.array([0.0, 0.0, 0.3, 0.5])      # acute load (yesterday) effect
GAM_ITEM = np.array([0.5, 0.9, 0.3, 0.0])      # life stress effect
PRO_ITEM = np.array([1.0, 0.0, 1.0, 0.3])      # prodrome loading


def athlete_plan(plan, match, P, widx, tr):
    pl = plan[widx] * tr["mult"][:, None]
    m = match[widx]
    ns = ~tr["starter"]
    # non-starters: 35% of match load, +12% of W0 compensatory session the next day
    pl[ns] = np.where(m[ns], pl[ns] * 0.35, pl[ns])
    nxt = np.zeros_like(m); nxt[:, 1:] = m[:, :-1]
    add = 0.12 * P["W0"][widx][:, None] * nxt
    pl[ns] += add[ns]
    return pl


def reference_states(pl, P, widx):
    """Run physiology on the planned load (no noise, no events) for normalisation constants."""
    N, T = pl.shape
    ag = np.exp(-1 / P["tau_g"][widx]); ah = np.exp(-1 / P["tau_h"][widx]); ak = np.exp(-1 / P["tau_k"][widx])
    k1 = 1e-3
    s_typ = (P["W0"][widx] / 7.0) / (1 - ak)
    k3 = P["k_ratio"][widx] * k1 / s_typ
    g = np.zeros(N); h = np.zeros(N); k2 = np.zeros(N)
    G = np.zeros((N, T)); H = np.zeros((N, T))
    for t in range(1, T):
        g = g * ag + k1 * pl[:, t - 1]
        k2 = k2 * ak + k3 * pl[:, t - 1]
        h = h * ah + k2 * pl[:, t - 1]
        G[:, t] = g; H[:, t] = h
    sl = slice(EVAL_START, T)
    S = spike_series(pl)
    ref = dict(k3=k3, ag=ag, ah=ah, ak=ak,
               mF=H[:, sl].mean(1), sF=H[:, sl].std(1) + 1e-9,
               mG=G[:, sl].mean(1), sG=G[:, sl].std(1) + 1e-9,
               mS=np.nanmean(S[:, sl], 1), sS=np.nanstd(S[:, sl], 1) + 1e-9)
    return ref


def spike_series(w):
    """log of uncoupled 7:28 ratio of a load matrix (N, T)."""
    N, T = w.shape
    c = np.concatenate([np.zeros((N, 1)), np.cumsum(w, 1)], 1)
    S = np.full((N, T), np.nan)
    for t in range(34, T):
        a = (c[:, t + 1] - c[:, t - 6]) / 7.0
        ch = (c[:, t - 6] - c[:, t - 34]) / 28.0
        S[:, t] = np.log((a + 10.0) / (ch + 10.0))
    return S


# ---------------------------------------------------------------- main simulator
def simulate(Pmat, seed, policy=None, engines=None, deload=0.25, deload_days=2,
             return_wellness=False, A=A_PER_SQUAD):
    """
    Pmat: (W, n_params) parameter matrix, one row per world (squad).
    policy: None (open loop) or name of engine driving alert-triggered deloads, or
            'random:x' (placebo that deloads healthy athletes at random at the rate set in
            engines.placebo_rate)
    engines: engines.EngineBank instance (created inside if None)
    Returns dict of arrays.
    """
    from engines import EngineBank
    P = as_dict(Pmat); W = Pmat.shape[0]; N = W * A; T = T_DAYS
    rng_plan = np.random.default_rng([seed, 1]); rng_tr = np.random.default_rng([seed, 2])
    rng_s = np.random.default_rng([seed, 3])
    widx = np.repeat(np.arange(W), A)
    plan, dur, match = build_plans(P, rng_plan)
    tr = athlete_traits(P, widx, rng_tr)
    S = draw_streams(N, rng_s)
    pl = athlete_plan(plan, match, P, widx, tr)
    ref = reference_states(pl, P, widx)
    d_ = dur[widx]; m_ = match[widx] & tr["starter"][:, None]
    bank = engines if engines is not None else EngineBank(N, T, widx, W)

    k1 = 1e-3
    g = np.zeros(N); h = np.zeros(N); k2 = np.zeros(N)
    life = np.zeros(N)
    status = np.zeros(N, np.int8)      # 0 healthy, 1 injured, 2 ill, 3 return-to-play
    remaining = np.zeros(N, np.int16)
    inc = np.zeros(N, np.int8)         # incubation days remaining
    mod = np.ones((N, T))
    w_true = np.zeros((N, T)); rep_load = np.full((N, T), np.nan)
    well = np.full((N, T, 4), np.nan, np.float32) if return_wellness else None
    zF_all = np.zeros((N, T), np.float32)
    healthy = np.zeros((N, T), bool)
    onset_inj = np.zeros((N, T), bool); onset_ill = np.zeros((N, T), bool)
    incub_flag = np.zeros((N, T), bool)
    G_all = np.zeros((N, T), np.float32); H_all = np.zeros((N, T), np.float32)
    rand_rate = None
    if policy is not None and policy.startswith("random:"):
        rand_rate = bank.placebo_rate        # (W,) alert rate per squad
        rng_pl = np.random.default_rng([seed, 9])
    ill_mu = np.log(P["d_ill"][widx]); inj_mu = np.log(P["d_inj"][widx])
    carelessness = tr["style"] == 3

    for t in range(T):
        # ---- physiology update with yesterday's load
        if t > 0:
            g = g * ref["ag"] + k1 * w_true[:, t - 1]
            k2 = k2 * ref["ak"] + ref["k3"] * w_true[:, t - 1]
            h = h * ref["ah"] + k2 * w_true[:, t - 1]
        G_all[:, t] = g; H_all[:, t] = h
        zF = (h - ref["mF"]) / ref["sF"]; zG = (g - ref["mG"]) / ref["sG"]
        zF_all[:, t] = zF
        life = 0.9 * life + np.sqrt(1 - 0.81) * S["e_life"][:, t]
        # ---- health status transitions (events start before today's session)
        healthy_now = status == 0
        healthy[:, t] = healthy_now
        # spike of true load (uncoupled)
        if t >= 34:
            a7 = w_true[:, t - 7:t].mean(1); c28 = w_true[:, t - 35:t - 7].mean(1)
            sp = np.log((a7 + 10.0) / (c28 + 10.0))
            zS = (sp - ref["mS"]) / ref["sS"]
        else:
            zS = np.zeros(N)
        phi = P["phi"][widx]
        lp = (P["a_inj"][widx] + tr["u_inj"] + P["beta"][widx] * ((1 - phi) * zF + phi * zS)
              + P["beta_g"][widx] * zG + P["b_match"][widx] * m_[:, t])
        new_inj = healthy_now & (S["u_inj"][:, t] < expit(lp))
        lpi = P["a_ill"][widx] + tr["u_ill"] + P["beta_ill"][widx] * zF + LIFE_ILL * life
        expose = healthy_now & (inc == 0) & ~new_inj & (S["u_ill"][:, t] < expit(lpi))
        inc = np.where(expose, S["inc_len"][:, t], inc)
        # incubation end -> progression
        inc_end = (inc == 1)
        new_ill = healthy_now & ~new_inj & inc_end & (S["u_prog"][:, t] < P["prog"][widx])
        incub_flag[:, t] = inc > 0
        inc = np.maximum(inc - 1, 0)
        dur_inj = np.maximum(1, np.round(np.exp(inj_mu + 0.9 * S["z_dur"][:, t]))).astype(np.int16)
        dur_ill = np.maximum(1, np.round(np.exp(ill_mu + 0.6 * S["z_dur"][:, t]))).astype(np.int16)
        status = np.where(new_inj, 1, np.where(new_ill, 2, status)).astype(np.int8)
        remaining = np.where(new_inj, dur_inj, np.where(new_ill, dur_ill, remaining))
        onset_inj[:, t] = new_inj; onset_ill[:, t] = new_ill
        # ---- today's true load
        base = pl[:, t] * mod[:, t] * np.exp(0.15 * S["e_load"][:, t])
        fac = np.where(status == 0, 1.0, np.where(status == 3, 0.6, 0.0))
        w_true[:, t] = base * fac
        # ---- observation: missingness, sRPE, wellness
        pm = expit(logit(tr["m0_i"]) + P["nu"][widx] * zF)
        observed = S["u_miss"][:, t] >= pm
        session = d_[:, t] > 0
        rpe_true = np.where(session, w_true[:, t] / np.maximum(d_[:, t], 1), 0.0)
        rpe_obs = np.clip(np.round(rpe_true + 0.6 * S["e_rpe"][:, t]), 0, 10)
        rpe_obs = np.where(w_true[:, t] > 0, np.maximum(rpe_obs, 1), 0)
        load_obs = np.where(w_true[:, t] > 0, rpe_obs * d_[:, t] * np.where(status == 3, 0.6, 1.0), 0.0)
        rep_load[:, t] = np.where(observed, load_obs, np.nan)
        # wellness latent per item
        yload = w_true[:, t - 1] if t > 0 else np.zeros(N)
        zy = (yload - pl[:, t - 1 if t > 0 else 0]) / (P["W0"][widx] / 7.0)
        lam = P["lam_w"][widx][:, None] * LAM_ITEM[None, :]
        eta = (tr["base"] + lam * zF[:, None] + KAP_ITEM[None, :] * zy[:, None]
               + GAM_ITEM[None, :] * life[:, None]
               + P["prodrome"][widx][:, None] * PRO_ITEM[None, :] * incub_flag[:, t][:, None]
               + S["e_well"][:, t, :])
        st = tr["style"]
        dev = eta - tr["base"]
        under = (st == 1)[:, None]
        eta = np.where(under, tr["base"] + np.where(dev > 0, dev * (1 - P["rho_under"][widx][:, None]), dev), eta)
        comp = (st == 2)[:, None]
        eta = np.where(comp, tr["base"] + 0.5 * dev, eta)
        cat = 1 + (eta[:, :, None] > CUTS[None, None, :]).sum(2)
        care_today = carelessness & (S["u_care"][:, t] < 0.3)
        cat = np.where(care_today[:, None], S["care_cat"][:, t, :], cat).astype(np.float32)
        cat = np.where(observed[:, None], cat, np.nan)
        if return_wellness:
            well[:, t, :] = cat
        # ---- engines update (evening, after today's report)
        bank.update(t, rep_load[:, t], cat, status != 0)
        # ---- policy: alert-triggered deload of the next days
        if policy is not None and t < T - 1:
            if rand_rate is not None:
                alert = (rng_pl.random(N) < rand_rate[widx]) & (status == 0)
            else:
                alert = bank.alert(policy, t) & (status == 0)
            for k in range(1, deload_days + 1):
                if t + k < T:
                    mod[:, t + k] = np.where(alert, np.minimum(mod[:, t + k], 1 - deload), mod[:, t + k])
        # ---- advance event clocks (after today)
        remaining = np.where(status > 0, remaining - 1, remaining)
        back = (status > 0) & (status < 3) & (remaining <= 0)
        status = np.where(back, 3, status).astype(np.int8)
        remaining = np.where(back, 7, remaining)
        done_rtp = (status == 3) & (remaining <= 0)
        status = np.where(done_rtp, 0, status).astype(np.int8)

    out = dict(P=P, widx=widx, w_true=w_true, rep_load=rep_load, plan=pl, healthy=healthy,
               onset_inj=onset_inj, onset_ill=onset_ill, zF=zF_all, incub=incub_flag,
               G=G_all, H=H_all, k1=k1, starter=tr["starter"], style=tr["style"], bank=bank)
    if return_wellness:
        out["well"] = well
    return out

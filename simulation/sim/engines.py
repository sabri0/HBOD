"""
Streaming decision engines, vectorised across athletes.

Each engine produces a daily score (higher = more concern) and a default binary alert.
Engines:
  v1           rule-based prototype, an unpublished development stage of HBOD (any of: uncoupled ACWR > 1.30, wellness z <= -1,
               monotony >= 2, spike >= 1.5); missing days zero-filled; no decision without entry
  ra_coupled   rolling-average ACWR 7:28 (coupled)            > 1.30
  ra_uncoupled rolling-average ACWR 7:28 (acute excluded)     > 1.30
  ewma         EWMA ACWR (lambda_a = 2/8, lambda_c = 2/29)     > 1.30
  week_change  week-to-week change in load                     > 15 %
  tsb          ATL - CTL (time constants 7 and 42 d), z vs own 42-day baseline > 1.0
  wellness     Hooper composite z vs own 28-day baseline       <= -1.0
  v2           HBOD state-space engine: Kalman filter on fitness and fatigue states with
               recursive-least-squares observation model for Hooper wellness; score is the
               posterior probability that the fatigue-fitness deficit or the wellness strain exceeds
               the athlete's own baseline by kappa SD; alert P >= 0.80
  v2_noW       ablation of v2 without wellness updates
Load-based engines (all except v1) use the same imputation for missing session reports
(squad median of that day among available reporters; zero when the athlete is unavailable).
"""
import numpy as np
from scipy.stats import norm

ENGINES = ["v1", "ra_coupled", "ra_uncoupled", "ewma", "week_change", "tsb", "wellness", "v2", "v2_noW"]
DEFAULT_THR = {"v1": 1.0, "ra_coupled": 1.30, "ra_uncoupled": 1.30, "ewma": 1.30, "week_change": 0.15,
               "tsb": 1.0, "wellness": 1.0, "v2": float(np.log(0.8 / 0.2)), "v2_noW": float(np.log(0.8 / 0.2))}


class EngineBank:
    def __init__(self, N, T, widx, W, kappa=1.0, q_g=0.005, q_h=0.03, q_s=0.30, rho_s=0.80,
                 forget=0.99, imp_inflate=4.0):
        self.N, self.T, self.widx, self.W = N, T, widx, W
        self.A = N // W
        f = np.float32
        self.score = {e: np.full((N, T), np.nan, f) for e in ENGINES}
        self.L1 = np.zeros((N, T))          # v1 zero-filled reported load
        self.obs = np.zeros((N, T), bool)   # entry exists
        self.LI = np.zeros((N, T))          # imputed load
        self.WL = np.full((N, T), np.nan)   # wellness composite (higher = better), v1 style
        self.Y = np.full((N, T), np.nan)    # mean Hooper item (1 best .. 7 worst)
        self.thr = dict(DEFAULT_THR)
        # EWMA / TSB states
        self.ea = None; self.ec = None
        self.atl = np.zeros(N); self.ctl = np.zeros(N)
        self.dtsb = np.full((N, T), np.nan)
        # Kalman (v2) states: x = [G, H, s]; G, H in kAU (exponentially weighted load),
        # s = wellness strain not explained by load (Hooper item units, AR(1))
        self.kappa = kappa; self.q = np.array([q_g ** 2, q_h ** 2, q_s ** 2]); self.forget = forget
        self.rho_s = rho_s
        self.imp_inflate = imp_inflate
        self.ag = np.exp(-1 / 42.0); self.ah = np.exp(-1 / 7.0)
        for tag in ("", "n"):
            setattr(self, "x" + tag, np.zeros((N, 3)))
            P0 = np.zeros((N, 3, 3)); P0[:, 0, 0] = 0.05; P0[:, 1, 1] = 0.05
            P0[:, 2, 2] = q_s ** 2 / (1 - rho_s ** 2)
            setattr(self, "P" + tag, P0)
            setattr(self, "dd" + tag, np.full((N, T), np.nan))
            setattr(self, "ss" + tag, np.full((N, T), np.nan))
        self.theta = np.tile(np.array([3.5, 1.0, 0.3]), (N, 1))
        self.Prls = np.tile(np.diag([1.0, 4.0, 4.0]), (N, 1, 1))
        self.R = np.full(N, 0.5)
        self.placebo_rate = None

    # ------------------------------------------------------------------ helpers
    def _sum(self, M, a, b):
        """sum over columns a..b inclusive, clipped at 0 (zero padding before start)."""
        a = max(a, 0)
        if b < a:
            return np.zeros(M.shape[0])
        return M[:, a:b + 1].sum(1)

    def _impute(self, t, rep, unavailable):
        x = np.where(unavailable, np.nan, rep).reshape(self.W, self.A)
        with np.errstate(all="ignore"):
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                med = np.nanmedian(x, axis=1)
        med = np.nan_to_num(med, nan=0.0)
        imp = np.where(np.isnan(rep), med[self.widx], rep)
        imp = np.where(unavailable, 0.0, imp)
        return imp

    # ------------------------------------------------------------------ main update
    def update(self, t, rep, cat, unavailable):
        N = self.N
        obs = ~np.isnan(rep)
        self.obs[:, t] = obs
        self.L1[:, t] = np.where(obs, rep, 0.0)
        u = self._impute(t, rep, unavailable)
        imputed = (~obs) & (~unavailable)
        self.LI[:, t] = u
        y = cat.mean(axis=1)
        y = np.where(np.isnan(cat).any(1), np.nan, y)
        self.Y[:, t] = y
        self.WL[:, t] = 8.0 - y
        sc = self.score

        # ---------------- v1 rule-based prototype (JS-identical logic)
        L1 = self.L1
        weekly = self._sum(L1, t - 6, t); acute = weekly / 7.0
        chronic = self._sum(L1, t - 34, t - 7) / 28.0
        with np.errstate(divide="ignore", invalid="ignore"):
            acwr = np.where(chronic > 0, acute / chronic, np.nan)
        aw = np.stack([L1[:, k] if k >= 0 else np.zeros(N) for k in range(t - 6, t + 1)], 1)
        sd = aw.std(1)
        with np.errstate(divide="ignore", invalid="ignore"):
            mono = np.where(sd > 0, acute / sd, np.nan)
        pk = [k for k in range(t - 7, t) if k >= 0]
        if pk:
            pobs = self.obs[:, pk]; pval = L1[:, pk]
            cnt = pobs.sum(1)
            pm = np.where(cnt > 0, (pval * pobs).sum(1) / np.maximum(cnt, 1), 0.0)
        else:
            pm = np.zeros(N)
        with np.errstate(divide="ignore", invalid="ignore"):
            spike = np.where(pm > 0, L1[:, t] / pm, np.nan)
        bk = [k for k in range(t - 28, t) if k >= 0]
        wz = np.full(N, np.nan)
        if bk:
            B = self.WL[:, bk]
            nb = (~np.isnan(B)).sum(1)
            with np.errstate(all="ignore"):
                import warnings
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    mb = np.nanmean(B, 1); sb = np.nanstd(B, 1)
            ok = (nb >= 3) & (sb > 0) & ~np.isnan(self.WL[:, t])
            wz = np.where(ok, (self.WL[:, t] - mb) / np.where(sb > 0, sb, 1), np.nan)
        flags = ((acwr > 1.30).astype(int) + (wz <= -1.0).astype(int) + (mono >= 2.0).astype(int)
                 + (spike >= 1.5).astype(int))
        # deterministic sub-integer tie-breaker in [0, 0.999): leaves every integer threshold
        # decision unchanged and only orders days within the same flag count
        jit = np.modf((np.arange(N) * 0.6180339887 + t * 0.4142135624) * 7.0)[0] * 0.999
        sc["v1"][:, t] = np.where(obs, flags + jit, np.nan)
        self.v1_parts = dict(acwr=acwr, wz=wz, mono=mono, spike=spike)
        sc["wellness"][:, t] = -wz

        # ---------------- ratio engines on imputed load
        LI = self.LI
        if t >= 27:
            a = self._sum(LI, t - 6, t) / 7.0
            c = self._sum(LI, t - 27, t) / 28.0
            sc["ra_coupled"][:, t] = np.where(c > 0, a / np.where(c > 0, c, 1), np.nan)
        if t >= 34:
            a = self._sum(LI, t - 6, t) / 7.0
            c = self._sum(LI, t - 34, t - 7) / 28.0
            sc["ra_uncoupled"][:, t] = np.where(c > 0, a / np.where(c > 0, c, 1), np.nan)
        la, lc = 2 / 8, 2 / 29
        if self.ea is None:
            self.ea = u.copy(); self.ec = u.copy()
        else:
            self.ea = la * u + (1 - la) * self.ea
            self.ec = lc * u + (1 - lc) * self.ec
        if t >= 27:
            sc["ewma"][:, t] = np.where(self.ec > 0, self.ea / np.where(self.ec > 0, self.ec, 1), np.nan)
        if t >= 13:
            s1 = self._sum(LI, t - 6, t); s0 = self._sum(LI, t - 13, t - 7)
            sc["week_change"][:, t] = np.where(s0 > 0, (s1 - s0) / np.where(s0 > 0, s0, 1), np.nan)
        self.atl += (u - self.atl) / 7.0
        self.ctl += (u - self.ctl) / 42.0
        self.dtsb[:, t] = self.atl - self.ctl
        if t >= 28:
            base = self.dtsb[:, max(0, t - 42):t]
            mb = base.mean(1); sb = base.std(1)
            sc["tsb"][:, t] = np.where(sb > 0, (self.dtsb[:, t] - mb) / np.where(sb > 0, sb, 1), np.nan)

        # ---------------- v2 and ablation: Kalman with RLS observation model
        self._kalman(t, u / 1000.0, imputed, y, use_obs=True, tag="")
        self._kalman(t, u / 1000.0, imputed, y, use_obs=False, tag="n")

    def _kalman(self, t, ukau, imputed, y, use_obs, tag):
        N = self.N
        x = getattr(self, "x" + tag); P = getattr(self, "P" + tag)
        dd = getattr(self, "dd" + tag); ss = getattr(self, "ss" + tag)
        ag, ah, rs = self.ag, self.ah, self.rho_s
        F = np.diag([ag, ah, rs]); b = np.array([1 - ag, 1 - ah, 0.0])
        # time update with today's (reported or imputed) load
        x = x @ F.T + ukau[:, None] * b[None, :]
        infl = np.where(imputed, self.imp_inflate, 1.0)
        P = F @ P @ F.T
        P[:, 0, 0] += self.q[0] * infl; P[:, 1, 1] += self.q[1] * infl; P[:, 2, 2] += self.q[2]
        if use_obs:
            th = self.theta
            have = ~np.isnan(y)
            # RLS regressors use predicted load states; target net of predicted strain
            phi = np.stack([np.ones(N), x[:, 1], -x[:, 0]], 1)
            y_rls = np.where(have, y - x[:, 2], 0.0)
            if t >= 14:
                H = np.stack([-th[:, 2], th[:, 1], np.ones(N)], 1)   # d y / d [G, H, s]
                yhat = th[:, 0] + (H * x).sum(1)
                e = np.where(have, y - yhat, 0.0)
                HP = np.einsum("ni,nij->nj", H, P)
                hph = (HP * H).sum(1)
                S = hph + self.R
                K = HP / S[:, None]
                x = np.where(have[:, None], x + K * e[:, None], x)
                Pn = P - np.einsum("ni,nj->nij", K, HP)
                P = np.where(have[:, None, None], Pn, P)
                self.R = np.where(have, np.maximum(0.95 * self.R + 0.05 * (e ** 2 - hph), 0.05), self.R)
            lam = self.forget
            Pr = self.Prls
            Pphi = np.einsum("nij,nj->ni", Pr, phi)
            den = lam + (phi * Pphi).sum(1)
            Kr = Pphi / den[:, None]
            er = np.where(have, y_rls - (th * phi).sum(1), 0.0)
            th_new = th + Kr * er[:, None]
            Pr_new = (Pr - np.einsum("ni,nj->nij", Kr, Pphi)) / lam
            th_new[:, 1] = np.clip(th_new[:, 1], 0.1, 5.0); th_new[:, 2] = np.clip(th_new[:, 2], 0.0, 5.0)
            self.theta = np.where(have[:, None], th_new, th)
            self.Prls = np.where(have[:, None, None], Pr_new, Pr)
        d = x[:, 1] - x[:, 0]
        vd = P[:, 0, 0] + P[:, 1, 1] - 2 * P[:, 0, 1]
        dd[:, t] = d; ss[:, t] = x[:, 2]
        name = "v2" if use_obs else "v2_noW"
        if t >= 28:
            base = dd[:, max(0, t - 42):t]
            mb = base.mean(1); sb = base.std(1)
            zd = (d - mb - self.kappa * sb) / np.sqrt(np.maximum(vd, 1e-10))
            pd_ = norm.cdf(zd)
            if use_obs:
                bs = ss[:, max(0, t - 42):t]
                ms = bs.mean(1); sbs = bs.std(1)
                zs = (x[:, 2] - ms - self.kappa * sbs) / np.sqrt(np.maximum(P[:, 2, 2], 1e-10))
                ps = norm.cdf(zs)
                p = 1 - (1 - pd_) * (1 - ps)
            else:
                p = pd_
            # store on the logit scale to avoid ties at 0 or 1 in single precision
            p = np.clip(p, 1e-12, 1 - 1e-12)
            self.score[name][:, t] = np.log(p / (1 - p))
        setattr(self, "x" + tag, x); setattr(self, "P" + tag, P)

    # ------------------------------------------------------------------ alerts
    def alert(self, name, t):
        """thr may be a scalar or an (N,) array of athlete-specific (per-squad) thresholds."""
        s = np.nan_to_num(self.score[name][:, t].astype(float), nan=-np.inf)
        thr = self.thr[name]
        if name in ("v1", "wellness", "v2", "v2_noW"):
            return s >= thr
        return s > thr

    def alerts(self, name):
        out = np.zeros((self.N, self.T), bool)
        for t in range(self.T):
            out[:, t] = self.alert(name, t)
        return out


class NullBank:
    """No-op engine bank used for calibration runs (no decision engines evaluated)."""
    def __init__(self, *a, **k):
        self.placebo_rate = None
    def update(self, *a, **k):
        pass

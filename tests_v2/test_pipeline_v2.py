"""Tests for the pure-math parts of pipeline_v2.py.  Run:  python -m unittest discover tests_v2"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pipeline_v2 as p  # noqa: E402


class FactorRegression(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(0)
        self.T = 2000
        self.F = rng.normal(0, 0.01, (self.T, 2))
        self.B = np.array([[1.2, 0.5, -0.3], [0.4, -0.8, 0.0]])  # K x N true betas
        self.noise = rng.normal(0, 0.01, (self.T, 3))
        self.R = 0.0002 + self.F @ self.B + self.noise

    def test_recovers_betas(self):
        _, B = p.residualize(self.R, self.F)
        np.testing.assert_allclose(B, self.B, atol=0.05)

    def test_residuals_orthogonal_to_factors_and_mean_zero(self):
        E, _ = p.residualize(self.R, self.F)
        np.testing.assert_allclose(self.F.T @ E, 0, atol=1e-12)
        np.testing.assert_allclose(E.mean(axis=0), 0, atol=1e-15)

    def test_single_factor_matches_cov_over_var(self):
        f = self.F[:, :1]
        _, B = p.residualize(self.R[:, :1], f)
        beta = np.cov(self.R[:, 0], f[:, 0])[0, 1] / np.var(f[:, 0], ddof=1)
        self.assertAlmostEqual(B[0, 0], beta, places=10)

    def test_spread_basis_gives_identical_residuals(self):
        # [SPY, TLT, USMV, IWM, IWD, IWF] and the readable spread basis span the same space
        rng = np.random.default_rng(4)
        spy, tlt, usmv, iwm, iwd, iwf = rng.normal(0, 0.01, (6, 800))
        raw = np.column_stack([spy, tlt, usmv, iwm, iwd, iwf])
        spread = np.column_stack([spy, tlt, usmv - spy, iwm - spy, iwd - iwf, (iwd + iwf) / 2 - spy])
        R = rng.normal(0, 0.01, (800, 4)) + raw @ rng.normal(0, 1, (6, 4))
        np.testing.assert_allclose(p.residualize(R, raw)[0], p.residualize(R, spread)[0], atol=1e-12)


class Winsorise(unittest.TestCase):
    def test_clips_outlier_only(self):
        rng = np.random.default_rng(1)
        x = rng.normal(0, 1, 500)
        x[100] = 60.0                       # a merger-day jump
        y = p.winsorize(x[:, None])[:, 0]
        bound = x.mean() + 5 * x.std(ddof=1)
        self.assertAlmostEqual(y[100], bound)
        inside = np.abs(x - x.mean()) <= 5 * x.std(ddof=1)
        np.testing.assert_array_equal(y[inside], x[inside])

    def test_per_column_and_nan_safe(self):
        X = np.column_stack([np.r_[np.zeros(99), 100.0], np.r_[np.ones(50), np.nan, np.ones(49)] * np.arange(100)])
        Y = p.winsorize(X)
        self.assertLess(Y[-1, 0], 100.0)          # column 1 clipped
        self.assertTrue(np.isnan(Y[50, 1]))       # NaN preserved
        self.assertEqual(Y[0, 1], X[0, 1])

    def test_one_spike_cannot_create_a_link(self):
        rng = np.random.default_rng(2)
        a, b = rng.normal(0, 1, 500), rng.normal(0, 1, 500)
        a[10] = b[10] = 40.0                      # both jump on the same day
        raw = np.corrcoef(a, b)[0, 1]
        w = p.corr_matrix(p.winsorize(np.column_stack([a, b])))[0, 1]
        self.assertGreater(raw, 0.5)
        self.assertLess(w, raw / 2)


class Stability(unittest.TestCase):
    def test_counts_held_and_available_windows(self):
        m1 = np.array([[1, 0.50], [0.50, 1]])
        m2 = np.array([[1, 0.29], [0.29, 1]])
        m3 = np.array([[1, np.nan], [np.nan, 1]])
        m4 = np.array([[1, 0.30], [0.30, 1]])      # exactly at the threshold counts as held
        k, n = p.stability_counts([m1, m2, m3, m4], thr=0.3)
        self.assertEqual(k[0, 1], 2)
        self.assertEqual(n[0, 1], 3)
        self.assertEqual(k[0, 1], k[1, 0])


class Neff(unittest.TestCase):
    def test_identity_gives_n(self):
        for n in (1, 5, 15):
            self.assertAlmostEqual(p.neff(np.eye(n)), n)

    def test_all_ones_gives_one(self):
        self.assertAlmostEqual(p.neff(np.ones((12, 12))), 1.0)

    def test_matches_eigenvalue_definition_with_weights(self):
        rng = np.random.default_rng(3)
        A = rng.normal(size=(8, 8))
        C = np.corrcoef(A @ A.T)
        w = rng.uniform(1, 5, 8)
        wn = w / w.sum()
        lam = np.linalg.eigvalsh(np.diag(np.sqrt(wn)) @ C @ np.diag(np.sqrt(wn)))
        self.assertAlmostEqual(p.neff(C, w), lam.sum() ** 2 / (lam ** 2).sum(), places=10)

    def test_two_blocks(self):
        C = np.kron(np.eye(2), np.ones((3, 3)))   # two groups of perfect clones
        self.assertAlmostEqual(p.neff(C), 2.0)


class CovarianceNeff(unittest.TestCase):
    def test_uncorrelated_equal_vol_equal_weight_gives_n(self):
        for n in (2, 9, 20):
            S = np.eye(n) * 0.02 ** 2
            self.assertAlmostEqual(p.neff_cov(S, np.full(n, 1 / n)), n)

    def test_perfectly_correlated_gives_one(self):
        sd = np.array([0.01, 0.02, 0.03, 0.015])
        S = np.outer(sd, sd)                      # every correlation = 1
        self.assertAlmostEqual(p.neff_cov(S, np.array([0.4, 0.3, 0.2, 0.1])), 1.0)

    def test_matches_eigenvalue_definition(self):
        rng = np.random.default_rng(5)
        A = rng.normal(size=(7, 7))
        S = A @ A.T / 100
        w = rng.uniform(0.5, 2, 7)
        w /= w.sum()
        lam = np.linalg.eigvalsh(np.diag(w) @ S @ np.diag(w))
        self.assertAlmostEqual(p.neff_cov(S, w), lam.sum() ** 2 / (lam ** 2).sum(), places=10)

    def test_risk_contributions_sum_to_one(self):
        rng = np.random.default_rng(6)
        A = rng.normal(size=(9, 9))
        S = A @ A.T
        w = rng.uniform(0, 1, 9)
        rc = p.risk_contrib(S, w)
        self.assertAlmostEqual(rc.sum(), 1.0)
        # equal weights, uncorrelated, equal vol -> equal risk shares
        np.testing.assert_allclose(p.risk_contrib(np.eye(4), np.full(4, 0.25)), 0.25)


class Decoupling(unittest.TestCase):
    def test_fisher_z(self):
        # atanh(0.2) - atanh(0.7) over SE 1/sqrt(57)
        expected = (np.arctanh(0.2) - np.arctanh(0.7)) * np.sqrt(57)
        self.assertAlmostEqual(float(p.fisher_z(0.2, 0.7, n=60)), expected)
        self.assertAlmostEqual(float(p.fisher_z(0.5, 0.5)), 0.0)
        self.assertLess(float(p.fisher_z(0.1, 0.8)), -6)            # a big fall is very significant

    def test_benjamini_hochberg(self):
        # textbook example: m = 10, q = 0.05; the 3 smallest pass (0.04 > 4*0.05/10 = 0.02)
        pv = np.array([0.001, 0.008, 0.012, 0.04, 0.06, 0.2, 0.3, 0.5, 0.7, 0.9])
        rej, adj = p.bh_reject(pv, 0.05)
        np.testing.assert_array_equal(rej, [True, True, True] + [False] * 7)
        self.assertAlmostEqual(adj[2], 0.04)                        # 0.012 * 10 / 3
        # order independence and monotone adjusted values
        rej2, _ = p.bh_reject(pv[::-1], 0.05)
        np.testing.assert_array_equal(rej2, rej[::-1])
        self.assertEqual(p.bh_reject(np.array([]))[0].size, 0)

    def test_stability_rule(self):
        k = np.array([6, 5, 4, 3, 4, 5])
        n = np.array([11, 11, 7, 5, 5, 8])
        # 6/11 ok; 5/11 no; 4/7 no (needs 5 = ceil(4.2)); 3/5 no (needs >= 4 held); 4/5 ok; 5/8 ok
        np.testing.assert_array_equal(p.stable_pair(k, n, 11), [True, False, False, False, True, True])


class TriangleIndex(unittest.TestCase):
    def test_matches_numpy_order(self):
        n = 7
        iu = np.triu_indices(n, 1)
        for pos, (i, j) in enumerate(zip(*iu)):
            self.assertEqual(p.tri_index(int(i), int(j), n), pos)
            self.assertEqual(p.tri_index(int(j), int(i), n), pos)


if __name__ == "__main__":
    unittest.main()

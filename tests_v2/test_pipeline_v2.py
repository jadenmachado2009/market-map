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

    def test_exposure_transform(self):
        # an asset that IS the small-cap ETF: market 1, size 1; a long-value/short-growth asset: value 1
        raw = np.array([[0.0, 0.0], [0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [0.0, -1.0]])  # SPY,TLT,IWM,IWD,IWF x 2 assets
        ex = p.exposures("full", raw)
        np.testing.assert_allclose(ex[:, 0], [1, 0, 1, 0])
        np.testing.assert_allclose(ex[:, 1], [0, 0, 0, 1])


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


class TriangleIndex(unittest.TestCase):
    def test_matches_numpy_order(self):
        n = 7
        iu = np.triu_indices(n, 1)
        for pos, (i, j) in enumerate(zip(*iu)):
            self.assertEqual(p.tri_index(int(i), int(j), n), pos)
            self.assertEqual(p.tri_index(int(j), int(i), n), pos)


if __name__ == "__main__":
    unittest.main()

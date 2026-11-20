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


class NoiseAssignment(unittest.TestCase):
    def test_hdbscan_plus_assignment_leaves_no_unclustered_points(self):
        rng = np.random.default_rng(0)
        blobs = [rng.normal(c, 0.05, (40, 2)) for c in ((0, 0), (1, 0), (0, 1))]
        Y = np.vstack(blobs + [rng.uniform(-0.5, 1.5, (25, 2))])     # 25 scattered points: HDBSCAN noise
        raw = p.hdbscan_labels(Y)
        self.assertGreater((raw == -1).sum(), 0)                       # the test is only useful if noise exists
        ids, assigned = p.assign_noise(raw, Y)
        self.assertEqual(int((ids == -1).sum()), 0)
        np.testing.assert_array_equal(assigned, raw == -1)            # exactly the noise points are flagged
        np.testing.assert_array_equal(ids[raw != -1], raw[raw != -1])  # clustered points keep their cluster

    def test_majority_of_five_nearest_clustered_neighbours(self):
        # cluster 0 at x = 0..0.4, cluster 1 at x = 1..1.4; noise at 0.6 is nearer cluster 0's members
        Y = np.array([[0.0, 0], [0.1, 0], [0.2, 0], [0.3, 0], [0.4, 0],
                      [1.0, 0], [1.1, 0], [1.2, 0], [1.3, 0], [1.4, 0], [0.6, 0], [0.95, 0]])
        ids = np.array([0] * 5 + [1] * 5 + [-1, -1])
        out, assigned = p.assign_noise(ids, Y, k=5)
        self.assertEqual(out[10], 0)        # 5 nearest: 0.4, 0.3, 0.2, 1.0, 0.1 -> 4 votes for 0
        self.assertEqual(out[11], 1)        # 5 nearest: 1.0, 1.1, 1.2, 1.3, 1.4 -> all 1
        self.assertEqual(assigned.tolist(), [False] * 10 + [True, True])

    def test_votes_come_from_clustered_points_only_and_ties_go_to_nearest(self):
        # k = 4 covers all four clustered points, so every noise point sees a 2-2 tie; noise points never vote
        Y = np.array([[0.0, 0], [0.1, 0], [1.0, 0], [1.1, 0], [0.45, 0], [0.58, 0], [0.59, 0]])
        ids = np.array([0, 0, 1, 1, -1, -1, -1])
        out, _ = p.assign_noise(ids, Y, k=4)
        # 0.45: nearest member 0.1 (0.35 away) -> 0;  0.58 / 0.59: nearest member 1.0 (0.42 / 0.41) -> 1
        self.assertEqual(out.tolist(), [0, 0, 1, 1, 0, 1, 1])

    def test_assigned_points_cannot_change_a_cluster_name(self):
        # FSLR-style case: a solar name joining the analog-chip cluster must not flip it to the broad label
        meta = {t: {"sub": "Semiconductors", "sector": "Information Technology"} for t in ["ADI", "TXN", "ON", "FSLR"]}
        overrides = [{"label": "Analog & auto chips", "tickers": ["ADI", "TXN", "ON"]},
                     {"label": "AI hardware & chips", "subs": ["Semiconductors"]}]
        ids, Y = np.array([0, 0, 0, 0]), np.zeros((4, 2))
        tick = ["ADI", "TXN", "ON", "FSLR"]
        flipped = p.label_clusters(ids, Y, tick, meta, overrides)                       # counting FSLR: 3/4 vs 4/4
        kept = p.label_clusters(ids, Y, tick, meta, overrides, np.array([False, False, False, True]))
        self.assertEqual(flipped[0]["label"], "AI hardware & chips")
        self.assertEqual(kept[0]["label"], "Analog & auto chips")
        self.assertEqual(kept[0]["n"], 4)                                               # size still counts everyone

    def test_degenerate_cases(self):
        Y = np.zeros((3, 2))
        out, assigned = p.assign_noise(np.array([-1, -1, -1]), Y)
        self.assertEqual(out.tolist(), [0, 0, 0])
        self.assertTrue(assigned.all())
        out, assigned = p.assign_noise(np.array([2, 2, 3]), Y)
        self.assertEqual(out.tolist(), [2, 2, 3])
        self.assertFalse(assigned.any())


class Watchlist(unittest.TestCase):
    def test_excludes_significant_pairs_and_ranks_by_z(self):
        z = np.array([-4.0, -1.0, -3.0, -2.5, 0.5, -0.2, -3.5])
        sig = np.array([True, False, False, False, False, False, True])
        w = p.watchlist(z, sig, n=5)
        self.assertEqual(w.tolist(), [2, 3, 1, 5])     # -3.0, -2.5, -1.0, -0.2; never 0 or 6, never the rising pair
        self.assertFalse(sig[w].any())
        self.assertTrue((np.diff(z[w]) >= 0).all())

    def test_caps_length_and_handles_empty(self):
        z = -np.arange(1, 40, dtype=float)
        self.assertEqual(len(p.watchlist(z, np.zeros(39, bool), n=5)), 5)
        self.assertEqual(p.watchlist(np.array([]), np.array([], bool)).size, 0)
        self.assertEqual(p.watchlist(np.array([-2.0, -1.0]), np.array([True, True])).size, 0)


def _words(tag: str, n: int) -> str:
    return " ".join(f"{tag}{k % 7}" for k in range(n))


class TenKExtraction(unittest.TestCase):
    """Synthetic 10-K plain text shaped like html_to_text output: one block per line."""
    TOC = "PART I\nItem 1.\nBusiness\n3\nItem 1A.\nRisk Factors\n14\nItem 2.\nProperties\n30\n"

    def test_skips_contents_and_cross_references_and_stops_at_item_1a(self):
        doc = (self.TOC
               + "Forward-looking statements are discussed in Item 1. Business and Item 1A. Risk Factors of this report. "
               + _words("noise", 500) + "\n"
               + "PART I\nITEM 1. BUSINESS\nOverview\n" + _words("grain", 450) + "\n"
               + "Item 1A. Risk Factors\n" + _words("risk", 900) + "\n"
               + "Item 7. Management's Discussion\nSee Item 1. Business above and Item 1A. Risk Factors.\n" + _words("mda", 4000))
        out = p.extract_item1(doc)
        self.assertIsNotNone(out)
        self.assertTrue(out.startswith("Overview grain0"))
        self.assertNotIn("noise", out)            # the inline cross-reference never starts a span
        self.assertNotIn("risk", out)
        self.assertNotIn("mda", out)              # v2.1's longest-span rule took this later span

    def test_items_1_and_2_heading_used_by_oil_and_gas_filers(self):
        doc = (self.TOC + "Items 1 and 2. Business and Properties\n" + _words("oil", 600)
               + "\nItem 1A. Risk Factors\n" + _words("risk", 300))
        out = p.extract_item1(doc)
        self.assertIsNotNone(out)
        self.assertTrue(out.split()[0].startswith("oil"))
        self.assertNotIn("risk", out)
        doc2 = "PART I, ITEM 1 — BUSINESS\n" + _words("chip", 400) + "\nITEM 3. LEGAL PROCEEDINGS\n" + _words("law", 50)
        self.assertNotIn("law", p.extract_item1(doc2))

    def test_cuts_boilerplate_subsections_once_300_words_are_in(self):
        doc = ("Item 1. Business\n" + _words("fund", 350) + "\nHuman Capital\n" + _words("staff", 200)
               + "\nRegulation\n" + _words("rule", 400) + "\nItem 1A. Risk Factors\n")
        out = p.extract_item1(doc)
        self.assertEqual(len(out.split()), 350)
        self.assertNotIn("staff", out)
        self.assertNotIn("rule", out)
        # a boilerplate heading before 300 words of business text doesn't cut it short
        early = "Item 1. Business\nRegulation\n" + _words("bank", 400) + "\nItem 1A. Risk Factors\n"
        self.assertEqual(len(p.extract_item1(early).split()), 401)
        # and a long sentence starting with "Regulation" is text, not a heading
        prose = ("Item 1. Business\n" + _words("x", 320) + "\nRegulation of our products by the FDA shapes how we "
                 "design, test and sell every device we make " + _words("y", 30) + "\nItem 1A. Risk Factors\n")
        self.assertIn("y0", p.extract_item1(prose))

    def test_short_or_missing_sections_give_none_and_cap_applies(self):
        self.assertIsNone(p.extract_item1(self.TOC))
        self.assertIsNone(p.extract_item1("Item 1. Business\n" + _words("a", 100) + "\nItem 1A. Risk Factors\n"))
        self.assertIsNone(p.extract_item1("no headings here " + _words("a", 1000)))
        long = "Item 1. Business\n" + _words("a", 5000) + "\nItem 1A. Risk Factors\n"
        self.assertEqual(len(p.extract_item1(long, max_words=3000).split()), 3000)

    def test_inline_xbrl_style_html(self):
        body = "".join(f"<div><span>{_words('grain', 60)}.</span></div>" for _ in range(6))
        html = ("<html><body><ix:header><span>dei data</span></ix:header>"
                "<table><tr><td>Item 1.</td><td>Business</td><td>3</td></tr>"
                "<tr><td>Item 1A.</td><td>Risk Factors</td><td>14</td></tr></table>"
                "<div><span style='font-weight:700'>PART I</span></div>"
                "<div><span style='font-weight:700'>ITEM 1.</span><span>&#160;</span><span>BUSINESS</span></div>"
                "<div><span>Overview</span></div>" + body +
                "<div><span>As described in Item 1A. Risk Factors, prices vary.</span></div>" + body +
                "<div><span style='font-weight:700'>ITEM&#160;1A.&#160;RISK FACTORS</span></div>"
                f"<div>{_words('risk', 400)}</div></body></html>").encode()
        out = p.extract_item1(p.html_to_text(html))
        self.assertIsNotNone(out)
        self.assertTrue(out.startswith("Overview grain0"))
        self.assertIn("prices vary", out)          # an inline mention of Item 1A doesn't end the section
        self.assertNotIn("risk0", out)
        self.assertNotIn("dei", out)

    def test_latest_10k_reads_older_pages_when_recent_has_none(self):
        class Resp:
            def __init__(self, d): self.d = d
            def json(self): return self.d

        class Http:
            def __init__(self): self.urls = []
            def get(self, url):
                self.urls.append(url)
                if url.endswith("CIK0000034088.json"):
                    return Resp({"filings": {"recent": {"form": ["4", "8-K", "10-Q"], "accessionNumber": ["a", "b", "c"],
                                                        "primaryDocument": ["x", "y", "z"]},
                                             "files": [{"name": "CIK0000034088-submissions-001.json"}]}})
                return Resp({"form": ["4", "10-K/A", "10-K", "10-K"], "accessionNumber": ["d", "e", "f", "g"],
                             "primaryDocument": ["p", "q", "xom-10k.htm", "old.htm"]})
        http = Http()
        self.assertEqual(p.latest_10k(http, 34088), ("f", "xom-10k.htm"))   # newest 10-K, never the amendment
        self.assertTrue(http.urls[1].endswith("CIK0000034088-submissions-001.json"))


class V23TextRules(unittest.TestCase):
    def test_cik_overrides_file(self):
        o = p.load_cik_overrides()
        self.assertEqual(o["XOM"], 34088)                       # "0000034088" in the file
        self.assertFalse(any(k.startswith("_") for k in o))

    def test_same_source_drops_mixed_pairs_only(self):
        src = np.array(["edgar", "edgar", "yahoo", "yahoo", "name"])
        si, sj = np.triu_indices(5, 1)
        keep = p.same_source(src, si, sj)
        for a, b, k in zip(si, sj, keep):
            self.assertEqual(bool(k), src[a] == src[b])
        self.assertEqual(int(keep.sum()), 2)                     # edgar-edgar and yahoo-yahoo

    def test_custom_heading_extractor_for_annual_report_layouts(self):
        doc = ("Contents\nOverview\n3\nManagement's Discussion and Analysis of Financial Condition\n12\n"
               "Overview of our results is a long sentence, not a heading, " + _words("prose", 50) + "\n"
               "OVERVIEW\n" + _words("bank", 420) + "\n"
               "MANAGEMENT'S DISCUSSION AND ANALYSIS OF FINANCIAL CONDITION AND RESULTS OF OPERATIONS\n" + _words("mda", 900))
        out = p.extract_by_headings(doc, ["overview"], ["management.?s discussion and analysis.*", "risk factors"])
        self.assertIsNotNone(out)
        self.assertTrue(out.startswith("bank0"))
        self.assertNotIn("mda", out)
        self.assertNotIn("prose", out)
        self.assertIsNone(p.extract_by_headings(doc, ["our business"], ["risk factors"]))

    def test_relaxed_rule_is_opt_in(self):
        # AIG: "ITEM 1 | Business" as a running page header; EXPE: "Part I. Item 1A. Risk Factors" as the end
        doc = (_words("toc", 20) + "\nSee Item 1. Business - Regulation for details " + _words("xref", 350)
               + "\nTABLE OF CONTENTS ITEM 1 | Business\n" + _words("ins", 400)
               + "\n2025 Form 10-K 9 Part I. Item 1A. Risk Factors\n" + _words("risk", 200))
        self.assertIsNone(p.extract_item1(doc))                  # the strict rule finds no heading here
        out = p.extract_item1(doc, relaxed=True)
        self.assertIsNotNone(out)
        self.assertTrue(out.startswith("ins0"))                  # the inline cross-reference doesn't start it
        self.assertNotIn("xref", out)
        self.assertNotIn("risk0", out)
        # the strict rule is unchanged: "|" and a "Part I." end prefix still don't count without relaxed=True
        self.assertIsNone(p.extract_item1("ITEM 1 | Business\n" + _words("a", 400) + "\nITEM 1A | Risk Factors\n"))
        cfg = p.load_extractors()
        self.assertEqual(cfg["relaxed"], {"AIG", "EXC", "EXPE"})
        self.assertEqual(set(cfg["custom"]), {"C", "MS", "GE", "HON", "INTC", "MCD"})

    def test_ge_and_hon_configs_on_their_layouts(self):
        cfg = p.load_extractors()["custom"]
        ge = ("TABLE OF CONTENTS\nAbout GE Aerospace\nManagement’s Discussion and Analysis of Financial Condition and\n"
              "Segment Operations\nRisk Factors\nForm 10-K Cross Reference Index\n" + _words("engine", 600)
              + "\n2025 FORM 10-K 3\n" + _words("engine", 300) + "\nCONSOLIDATED RESULTS\n" + _words("rev", 500))
        out = p.extract_by_headings(ge, cfg["GE"]["start"], cfg["GE"]["end"])
        self.assertTrue(out.startswith("engine0") and "rev0" not in out)
        hon = ("About Honeywell\nManagement’s Discussion and Analysis of Financial Condition\nRisk Factors\n"
               "TABLE OF CONTENTS\nABOUT HONEYWELL\n" + _words("aero", 300) + "\nTABLE OF CONTENTS\nABOUT HONEYWELL\n"
               "MAJOR BUSINESSES\n" + _words("auto", 300) + "\nMANAGEMENT’S DISCUSSION AND ANALYSIS OF\n" + _words("mda", 400))
        out = p.extract_by_headings(hon, cfg["HON"]["start"], cfg["HON"]["end"])
        self.assertTrue(out.startswith("aero0") and "auto0" in out and "mda0" not in out)

    def test_lookup_trace_records_urls_and_responses(self):
        class Resp:
            status_code = 200
            def json(self):
                return {"name": "EXXONMOBIL HOLDINGS", "filings": {"recent": {"form": ["8-K", "4"],
                        "accessionNumber": ["a", "b"], "primaryDocument": ["x", "y"]}, "files": []}}

        class Http:
            def get(self, url): return Resp()
        trace = []
        self.assertIsNone(p.latest_10k(Http(), 2115436, trace))
        self.assertEqual(len(trace), 1)
        self.assertIn("CIK0002115436.json -> HTTP 200", trace[0])
        self.assertIn("EXXONMOBIL HOLDINGS", trace[0])
        self.assertIn("8-K", trace[0])

    def test_heading_dump_lists_structure(self):
        doc = "PART I\nItem 1. Business\n" + _words("a", 40) + "\nOUR SEGMENTS\n" + _words("b", 30)
        d = p.heading_dump(doc)
        self.assertEqual([x.split("w  ")[1] for x in d], ["PART I", "Item 1. Business", "OUR SEGMENTS"])

    def test_ticker_quality_and_gate(self):
        rng = np.random.default_rng(3)
        centres = rng.normal(size=(4, 16))
        subs = [f"s{k // 10}" for k in range(40)]
        secs = [f"S{k // 20}" for k in range(40)]
        E = np.vstack([centres[k // 10] + 0.05 * rng.normal(size=16) for k in range(40)])
        E /= np.linalg.norm(E, axis=1, keepdims=True)
        tri = np.sort((E @ E.T)[np.triu_indices(40, 1)])
        good = p.ticker_quality(E, 0, subs, secs, tri)
        self.assertEqual((good["sub"], good["sector"]), (1.0, 1.0))
        bad_E = E.copy()
        bad_E[0] = centres[3] / np.linalg.norm(centres[3])      # ticker 0's text now reads like sub-industry 3
        bad = p.ticker_quality(bad_E, 0, subs, secs, np.sort((bad_E @ bad_E.T)[np.triu_indices(40, 1)]))
        self.assertTrue(p.ticker_gate(good, bad))
        self.assertFalse(p.ticker_gate(bad, good))
        one_off = {"sub": 0.8, "sector": 0.8, "sameSubPct": good["sameSubPct"] - 1}
        self.assertTrue(p.ticker_gate(one_off, good))            # one neighbour of slack
        self.assertTrue(p.ticker_gate({"sub": 0, "sector": 0.6, "sameSubPct": 50}, {"sub": 0, "sector": 0.8, "sameSubPct": 50}))
        self.assertTrue(p.text_gate({"sub": 0, "sector": 0.74, "sameSubPct": 94}, {"sub": 0, "sector": 0.78, "sameSubPct": 97}))


class TextQualityGate(unittest.TestCase):
    def test_quality_and_gate(self):
        rng = np.random.default_rng(1)
        centres = rng.normal(size=(4, 16))
        subs = [f"s{k // 10}" for k in range(40)]
        secs = [f"S{k // 20}" for k in range(40)]
        good = np.vstack([centres[k // 10] + 0.05 * rng.normal(size=16) for k in range(40)])
        good /= np.linalg.norm(good, axis=1, keepdims=True)
        noisy = rng.normal(size=(40, 16))
        noisy /= np.linalg.norm(noisy, axis=1, keepdims=True)
        qg, qn = p.text_quality(good, subs, secs), p.text_quality(noisy, subs, secs)
        self.assertEqual(qg["sub"], 1.0)
        self.assertEqual(qg["sector"], 1.0)
        self.assertGreater(qg["sameSubPct"], 85)
        self.assertLess(qn["sub"], 0.5)
        self.assertTrue(p.text_gate(qg, qn))       # better than the baseline: use it
        self.assertFalse(p.text_gate(qn, qg))      # clearly worse: fall back
        near = {"sub": qg["sub"], "sector": qg["sector"] - 0.03, "sameSubPct": qg["sameSubPct"] - 2.5}
        self.assertTrue(p.text_gate(near, qg))     # within tolerance


class TriangleIndex(unittest.TestCase):
    def test_matches_numpy_order(self):
        n = 7
        iu = np.triu_indices(n, 1)
        for pos, (i, j) in enumerate(zip(*iu)):
            self.assertEqual(p.tri_index(int(i), int(j), n), pos)
            self.assertEqual(p.tri_index(int(j), int(i), n), pos)


if __name__ == "__main__":
    unittest.main()

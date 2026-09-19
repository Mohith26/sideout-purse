/**
 * Fixed vectors for the signed score attestation contract (docs/attestation.md). The
 * private key is a TEST key, generated once for these vectors and never used by any
 * device. This file is copied verbatim to `apps/purse/test/attestation/vectors.ts` and
 * `apps/sideout/test/attestation/vectors.ts` (the boundary keeps each app to the package's
 * public entry); a change here is a contract change and every copy moves together.
 */
export const ATTESTATION_VECTORS = {
  "privateJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "r8lq57oQ4z3J_akci3XxcZfjeO7xV2_PG-HWHjqVjaE",
    "y": "gD8H4FrMv-l3t3Z0DH2Ar6ErHiAXcl47r7Ry2GMW1Qo",
    "d": "uMZeDzWLGS0CJ2IYibjta_L_-lUM2D5r1wq_Zddy_RU"
  },
  "publicJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "r8lq57oQ4z3J_akci3XxcZfjeO7xV2_PG-HWHjqVjaE",
    "y": "gD8H4FrMv-l3t3Z0DH2Ar6ErHiAXcl47r7Ry2GMW1Qo"
  },
  "otherPublicJwk": {
    "kty": "EC",
    "crv": "P-256",
    "x": "lXmJvB-LEDPO3ToHiOtQrOpbGlg4IJmPmmIN2gy1dwQ",
    "y": "N0uj4X7ddT1m4LgkuD9qPbP78FQkaGzLVtPV3rTDt58"
  },
  "keyId": "8XbN5630JiGUaVkgMV6bdDTXYOUC485Hd2mumkzF1-o",
  "payload": {
    "v": 1,
    "keyId": "8XbN5630JiGUaVkgMV6bdDTXYOUC485Hd2mumkzF1-o",
    "timestamp": "2026-09-19T16:05:00.000Z",
    "sourceRef": "mch_0192f1a0-0000-7000-8000-000000000101",
    "refs": {
      "tournamentId": "trn_0192f1a0-0000-7000-8000-000000000001",
      "teamId": "tm_0192f1a0-0000-7000-8000-000000000011"
    },
    "content": {
      "matchId": "mch_0192f1a0-0000-7000-8000-000000000101",
      "sets": [
        [
          1,
          21,
          18
        ],
        [
          2,
          19,
          21
        ],
        [
          3,
          15,
          11
        ]
      ]
    }
  },
  "canonical": "purse-score-attestation/1\n{\"content\":{\"matchId\":\"mch_0192f1a0-0000-7000-8000-000000000101\",\"sets\":[[1,21,18],[2,19,21],[3,15,11]]},\"keyId\":\"8XbN5630JiGUaVkgMV6bdDTXYOUC485Hd2mumkzF1-o\",\"refs\":{\"teamId\":\"tm_0192f1a0-0000-7000-8000-000000000011\",\"tournamentId\":\"trn_0192f1a0-0000-7000-8000-000000000001\"},\"sourceRef\":\"mch_0192f1a0-0000-7000-8000-000000000101\",\"timestamp\":\"2026-09-19T16:05:00.000Z\",\"v\":1}",
  "signature": "TObCBMpYyx1LQ0ef0nqUNBgK70FMYkrojJDAk-D5Hiwi2WoqJesv3kLQaHLpd-1gbGaG_DAYHGUi02W7AxaEcA"
} as const;

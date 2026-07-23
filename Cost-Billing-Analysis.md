# Semantica — Billing & Cost Analysis
**Date:** 22 July 2026
**Scope:** Billing pipeline audit, per-request cost modeling, translation-provider comparison, cache TTL analysis, and student-market pricing recommendation.

---

## 1 — Existing Billing Pipeline (confirmed in code)

Real, working payment pipeline — not aspirational UI copy. Uses **SePay** (Vietnamese bank-transfer/VietQR), not Stripe/Paddle.

**Flow:**
1. User picks Monthly (99,000₫) or Annual (899,000₫) in the Tauri app's Premium card (`app.js`, `index.html`).
2. `POST /v1/billing/checkout` (`server/src/billing.js`) creates a pending order in D1's `orders` table and returns a `qr.sepay.vn` VietQR image URL for that exact amount.
3. Client polls `GET /v1/billing/order/:id` (`pollPremiumOrder` in `app.js`) waiting for payment confirmation.
4. SePay calls `POST /webhooks/sepay` on payment — verified by API key (`_safeEqual`, constant-time comparison), amount-checked, and deduped on `sepay_tx_id` (unique index) so replayed webhooks can't double-credit.
5. On confirmed payment, `users.plan_expires_at` is extended (stacks remaining time on early renewal, doesn't overwrite).
6. Every authenticated request derives `isPro`/`planExpiresAt` from that column (`auth.js`) — this is what gates access to Cloud AI.

**Key fact for cost modeling:** Cloud AI (Claude + DeepL + Google TTS pipeline) is **Pro-gated**. Free/non-paying users use the local "Free Dictionary" (`freedict`) option instead, which costs nothing. So all API cost in this analysis is driven only by paying subscribers, not total registered users.

---

## 2 — What Happens on Each Word Lookup

- **Cache hit:** word+language already has a stored result in Cloudflare KV (key format `wac_<word>_<language>`, or `wac_en_<word>` for English-only content). Instant response, $0 cost.
- **Cache miss:** no valid entry exists (first-ever lookup, or the old entry expired). Triggers the real pipeline: Claude Haiku 4.5 (definition/POS/example), DeepL (translation), Google Cloud TTS (audio), Datamuse (synonyms, free) — then the result is written back into the cache before being returned.
- **Cache is global, not per-user.** Key is `wac_apple_vietnamese`, not tied to a user ID. The first person to look up "apple" triggers the paid pipeline; every other user who looks up "apple" afterward, at any time before expiry, gets a free cache hit. This is why hit rate scales with total user overlap, not individual usage.
- **TTL (time-to-live):** originally 7 days (`CACHE_TTL_SECONDS` in `analyze.js`). After 7 days, even an unchanged, correct entry is treated as gone and must be regenerated — pure waste for content (word definitions) that doesn't actually go stale.

---

## 3 — Per-Request Cost Breakdown (cache miss only)

Confirmed from `server/src/analyze.js`:

| Component | Provider | Model/tier | Trigger |
|---|---|---|---|
| Definition/POS/example | Claude | `claude-haiku-4-5-20251001`, max 400 tokens | Every cache miss (Phase 1) |
| Translation fallback | Claude | Same model, max 600 tokens | Only when DeepL fails/rejects (~conditional) |
| Translation | DeepL | Free or Pro tier by key suffix (`:fx`) | Every cache miss (Phase 2), batches word+definition+example in 1 call |
| Audio | Google Cloud TTS | Neural2 voice (`en-US-Neural2-D`) | Every English-content build |
| Synonyms | Datamuse | Free, no key | Every English-content build |

**Pricing used (verified via provider docs, July 2026):**
- Claude Haiku 4.5: $1/M input tokens, $5/M output tokens
- DeepL Growth: $26/month base (1M chars included), $27.50/M chars overage
- Google Cloud TTS Neural2: $16/M chars, 1M chars/month free
- Datamuse: free
- Cloudflare Workers Paid: $5/month base (10M requests + 30M CPU-ms included)
- Cloudflare D1: bundled in Workers Paid at this scale
- Cloudflare KV: 10M reads + 1M writes/month included in Workers Paid, then $0.50/M reads, $5/M writes

**Blended cost per cache miss (~200 chars/request):** Claude ~$0.0011 + DeepL ~$0.0055 + TTS ~$0.0001 ≈ **$0.0067/miss**

---

## 4 — Cost by Scale (Cache Hit Rate as the Key Assumption)

Assumptions: 20 lookups/paying-user/day (600/month). Cache hit rate assumed to rise with scale (Zipfian word-frequency clustering + shared global cache).

### At original 7-day TTL

| | 100 users | 1,000 users | 10,000 users |
|---|---|---|---|
| Lookups/mo | 60,000 | 600,000 | 6,000,000 |
| Assumed hit rate | 50% | 70% | 85% |
| Misses/mo | 30,000 | 180,000 | 900,000 |
| Claude | $33 | $198 | $990 |
| DeepL | $164 | $989 | $4,949 |
| Google TTS | $0 | $7 | $99 |
| Cloudflare | $5 | $5 | $10 |
| SePay | $0 | $0 | ~$5 |
| **Total/month** | **~$202** | **~$1,199** | **~$6,052** |

### At extended 1-year TTL (hit rate rises to 75/87/94% — churn-driven misses mostly eliminated)

| | 100 users | 1,000 users | 10,000 users |
|---|---|---|---|
| Misses/mo | 15,000 | 78,000 | 360,000 |
| **Total/month** | **~$103** | **~$518** | **~$2,415** |
| Savings vs. 7-day TTL | ~49% | ~57% | ~60% |

---

## 5 — DeepL Alternatives Considered

| Provider | Price | Free tier | Cost/request (~200 chars) | Monthly @ Tier 3, 900K misses | Monthly @ Tier 3, 360K misses (1yr TTL) |
|---|---|---|---|---|---|
| **DeepL Growth** (current) | $27.50/M chars overage | 1M chars/mo ($26 base) | $0.0055 | ~$4,950 | ~$1,979 |
| Google Cloud Translation (NMT) | $20/M chars | 500K chars/mo | $0.0040 | ~$3,590 | ~$1,430 |
| Amazon Translate | $15/M chars | 2M chars/mo (first 12 mo only) | $0.0030 | ~$2,700 | ~$1,080 |
| Azure Translator | $10/M chars | 2M chars/mo (ongoing) | $0.0020 | ~$1,780 | ~$700 |
| **Claude Haiku 4.5** (already integrated fallback) | token-based | — | $0.0017 | ~$1,530 | ~$612 |
| **Cloudflare Workers AI (M2M100)** | $0.342/M tokens | 10,000 neurons/day free | $0.00003 | ~$31 | ~$12 |
| MyMemory (already the sentence-translate fallback) | free | ~5K–50K words/day cap | $0 | not viable at this volume | still not viable |

**Latency caveat (why we did NOT recommend swapping DeepL → Claude as primary):** DeepL is a dedicated, low-latency MT service (sub-second). Claude Haiku is an LLM completion call through the AI Gateway proxy — realistically 1-3+ seconds for the same content, and the call is non-streaming. Swapping primary providers would visibly slow down the popup's "Vietnamese patched in when ready" second phase. Conclusion: **attack miss volume (TTL, pre-seeding), not provider choice**, to avoid trading cost for UX.

---

## 6 — TTL Trade-off: Why Not Just Set It to "Never Expire"

An indefinite TTL removes the cache's only self-healing mechanism:

- **Bug/poisoning risk:** the cache-poisoning bug fixed in Log_20-07 relied on the TTL to eventually retry failed translations. An indefinite TTL means a bad cached entry (from a bug, a bad prompt, an API hiccup) lives forever unless manually found and deleted.
- **No path for improvements to propagate:** any future prompt/model improvement never reaches already-cached words without a manual purge.
- **Storage cost is not the real constraint** — entries are small (a few hundred bytes); even tens of thousands of words indefinitely cached is trivial storage cost.

**Recommended middle ground:** long TTL (1 year) *plus* a version-bump mechanism for controlled invalidation — add a `CACHE_VERSION` constant baked into the cache key (e.g. `wac_v1_apple_vietnamese`). To force a full refresh (e.g., after fixing a bug or improving a prompt), bump the constant to `v2` and deploy. New keys don't exist yet, so every lookup is a fresh miss under the new version; old `v1` entries sit unused and expire naturally on their own 1-year TTL. This gives indefinite-style durability with a deliberate reset switch, rather than true infinite caching.

---

## 7 — Per-User Unit Economics & Pricing Recommendation

Marginal API cost per paying user (600 lookups/month):

- **Immature cache** (early days, 7-day TTL, ~50% hit): ~300 misses/user/month × $0.0067 ≈ **$2.01/user/month** (~49,000₫)
- **Mature cache** (1-year TTL, ~94% hit at scale): ~36 misses/user/month × $0.0067 ≈ **$0.24/user/month** (~5,900₫)

**Pricing recommendation (student market, DeepL retained as primary):**

- **Monthly: keep ~99,000–100,000₫.** Even in the worst-case immature-cache scenario, this leaves ~50% gross margin; at a mature cache, margin exceeds 90%.
- **50,000₫/month is risky as a standing price** — too close to the immature-cache worst-case cost (~49,000₫). Usable only as a limited-time promo/intro price, not the default.
- **Annual: keep steeply discounted (~25–30% off).** Marginal cost per user barely changes monthly vs. annually, but annual billing collapses 12 SePay transactions/year into 1, cutting payment overhead, and reduces churn risk around academic breaks. Current 899,000₫/year is reasonable; ~750,000–800,000₫/year would push annual adoption harder.
- **No metered/word-limit tier recommended** — added complexity isn't justified given the worst-case economics already work at 100,000₫/month. Instead, rely on (and verify/tune) the existing per-user daily rate limit (`rate-limit.js`) as a guardrail against outlier abuse, rather than building a new limited-tier product.

---

## 8 — Open Items / Next Steps

- [ ] Confirm actual DeepL key tier deployed (free `:fx` vs. paid) — DeepL's Free plan can no longer be newly purchased per their docs, worth checking renewability.
- [ ] Pull real cache hit-rate data from production KV once available — all hit-rate figures above are modeled estimates, not measured.
- [ ] Implement 1-year TTL change in `analyze.js` (`CACHE_TTL_SECONDS`).
- [ ] Add `CACHE_VERSION` key-prefixing for controlled invalidation.
- [ ] Check current configured value in `rate-limit.js` and tune against this cost model.
- [x] Model cost impact of GPT-credit-funded curated word-list pre-seeding — see Section 9.

---

## 9 — Pre-Seeding the Cache with a Curated Word List ($5,000 GPT Credit)

**The plan:** hire a well-known English teacher to curate topic-based word lists (Business, Travel, IELTS bands, Academic Writing, etc.), then run each word through a define+translate+example generation pass — funded by an existing $5,000 prepaid GPT API credit (token.ai.vn) — and write the results directly into the KV cache ahead of any organic user searches, instead of waiting for real traffic to slowly build up cache coverage.

*Note: I could not independently verify token.ai.vn's specific pricing/model access — costs below use standard OpenAI API list pricing (GPT-4o: $2.50/M input, $10/M output tokens; GPT-4o-mini: $0.15/M input, $0.60/M output tokens) as a stand-in reference. Confirm token.ai.vn's actual per-token rate before committing to a model choice.*

### Cost to run the pre-seeding job itself

Estimated ~300 input + 300 output tokens per word (definition + translation + example, combined):

| Model | Cost/word | 8,828 words (existing `ielts-wordlist.json`) | 30,000 words (broader topic coverage) |
|---|---|---|---|
| GPT-4o-mini | $0.000225 | ~$2 | ~$6.75 |
| GPT-4o (higher quality) | $0.00375 | ~$33 | ~$112.50 |

**The $5,000 credit is not a binding constraint at all** — even generating quality output for tens of thousands of curated words costs a tiny fraction of it (roughly 0.1–2% of the credit). The real cost of this plan is the teacher's curation fee and review time, not the API spend. The credit comfortably covers this pass many times over, leaving room for periodic re-runs (e.g., once a year alongside a `CACHE_VERSION` bump) without any additional budget concern.

### Where 1-year TTL comes in

**The TTL is what makes this a one-time investment instead of a recurring one.** Pre-seeding writes results into the exact same KV cache the live app reads from, with the same TTL applied. What happens next depends entirely on that TTL:

- **With the original 7-day TTL:** every word the teacher's list carefully pre-seeds evaporates from the cache within a week. The very next time any student looks up "negotiate," it's back to a live cache miss — full Claude+DeepL+TTS pipeline, full cost — as if the pre-seeding never happened. To keep the curated list "hot," you'd have to re-run the entire batch job every single week, turning a one-time investment into a recurring operational cost with no real payoff.
- **With a 1-year TTL:** run the batch job once, and every pre-seeded word stays a free cache hit for a full year, for every student who looks it up, regardless of volume. The teacher's curation work and the (trivial) API spend both get amortized across 12 months of usage instead of evaporating in a week.

In short: pre-seeding without a long TTL is close to wasted effort. Pre-seeding *with* the 1-year TTL is what turns "pay once" into "serve for free for a year" — the two changes are meant to be adopted together, not separately.

### Updated cost projection: 1-year TTL + comprehensive pre-seeding

Pre-seeding the head of the word-frequency distribution (via the existing 8,828-word IELTS list plus the teacher's topic lists, say ~20,000–30,000 words total) means the cache starts "mature" from day one instead of slowly ramping up with organic traffic. Estimated hit rate rises to ~97% even at small scale, since most of what students realistically search is already pre-cached before they search it.

| | 100 users | 1,000 users | 10,000 users |
|---|---|---|---|
| Misses/mo (~3% miss rate) | 1,800 | 18,000 | 180,000 |
| Claude | $2 | $20 | $198 |
| DeepL | $26 (base only) | $98 | $989 |
| Google TTS | $0 | $0 | $7 |
| Cloudflare | $5 | $5 | $6 |
| SePay | $0 | $0 | ~$5 |
| **Total/month** | **~$33** | **~$122** | **~$1,204** |
| vs. original 7-day-TTL baseline | ~$202 → ~$33 (84% cut) | ~$1,199 → ~$122 (90% cut) | ~$6,052 → ~$1,204 (80% cut) |

Combining the TTL change with pre-seeding cuts the original monthly bill by roughly 80–90% across all three scales — considerably more than either change alone (TTL extension by itself got ~50–60%). At the 10,000-paying-user tier, this brings the marginal cost down to well under 100,000₫/user/month even before accounting for SePay revenue, giving very comfortable margin at the recommended 100,000₫/month price point.

One caveat worth tracking: this projection assumes the curated lists genuinely cover most of what students search. If real usage skews heavily toward words outside the curated topics (slang, proper nouns, very niche vocabulary), actual hit rate — and therefore actual cost — will land somewhere between this 97% scenario and the 94% "organic 1-year-TTL only" scenario in Section 4. Worth re-measuring against real KV analytics once it's live rather than treating 97% as guaranteed.

---

## 10 — Multi-Provider Split (GPT for Definitions, DeepL + Haiku Fallback for Translation) at 50,000₫/month

**Proposed architecture:** GPT (token.ai.vn, $5,000 prepaid credit) for definition generation, a cheap model for topic classification, DeepL unchanged as primary translator, Claude Haiku unchanged as translation fallback.

**Model choice within the account's available models** (gpt-4.1-mini, gpt-4o-mini, gpt-5, gpt-5-chat, gpt-5-mini, model-router, o4-mini): definition generation is output-token-heavy (a ~110-token definition dominates the bill more than the ~250-token prompt), so **gpt-4o-mini is the cheapest fit** ($0.15/M in, $0.60/M out → ~$0.0001/call) — cheaper than gpt-5-mini for this specific profile despite gpt-5-mini's lower input price, because gpt-5-mini's output price ($1.00/M) is higher. gpt-4.1-mini, gpt-5, gpt-5-chat, and o4-mini are all pricier and better suited to reasoning-heavy tasks, not templated dictionary definitions. `model-router` may auto-optimize this but its pricing mechanics weren't verifiable here.

**On the "speed" goal specifically:** splitting tasks across providers mainly helps **throughput/concurrency under load** — it prevents one vendor's rate limit from becoming a bottleneck when many users open the popup at the same time — rather than making a single popup noticeably faster. If definition, translation, and TTS calls are already fired in parallel (`Promise.all`) within one request, as they are today, an individual lookup's speed is bounded by whichever single call is slowest, regardless of how many different vendors are involved. Multi-provider is a scaling/reliability improvement, not a latency improvement for one user's popup.

### Credit runway: when does the $5,000 GPT cost actually start counting?

Definition-gen cost per cache miss with gpt-4o-mini ≈ **$0.0001/miss** — about 8x cheaper than the Claude-Haiku baseline used in Section 9. Combined with the 1-year TTL + pre-seeding scenario (~97% hit rate):

| | 100 users | 1,000 users | 10,000 users |
|---|---|---|---|
| Misses/mo | 1,800 | 18,000 | 180,000 |
| GPT-4o-mini definition spend/mo | ~$0.19 | ~$1.86 | ~$18.63 |
| Credit runway (from ~$4,993 after the one-time pre-seed pass) | ~2,190 years | ~224 years | **~22 years** |

**At every modeled scale, the $5,000 credit is not realistically exhaustible** within any normal business-planning horizon — even at 10,000 paying users running continuously, it lasts over two decades. So per your instruction, GPT/definition cost is treated as **$0** in the recurring monthly model below; the "over $5,000" condition isn't expected to trigger unless the user base grows an order of magnitude beyond what's modeled here, or a pricier model (gpt-5/o4-mini) is used instead of gpt-4o-mini.

### Recalculated monthly cost (GPT definitions = $0, DeepL unchanged, 1-year TTL + pre-seeding)

| | 100 users | 1,000 users | 10,000 users |
|---|---|---|---|
| GPT (definitions) | $0 (credit) | $0 (credit) | $0 (credit) |
| DeepL | $26 | $97.50 | $988.50 |
| Google TTS | $0 | $0 | $7 |
| Claude Haiku (translation fallback only, ~15% of misses) | ~$0.50 | ~$4.60 | ~$46 |
| Cloudflare | $5 | $5 | $6 |
| SePay | $0 | $0 | ~$5 |
| **Total/month** | **~$31.50** | **~$107** | **~$1,052** |

DeepL is now, by a wide margin, the *entire* remaining cost story — it's ~93-95% of the total at every tier once GPT is credit-funded. Removing definition-gen cost only trimmed the total by another 5-13% on top of Section 9's numbers, because it was never the dominant line to begin with.

### Does 50,000₫/month hold up now?

**Per-user marginal cost at the mature, pre-seeded state:** 18 misses/user/month × ~$0.0059/miss (DeepL + TTS + occasional Haiku fallback) ≈ **$0.105/month ≈ 2,600₫/month**. Against a 50,000₫ price, that's roughly **95% gross margin** — very comfortable.

**The catch — this is conditional on the TTL + pre-seeding actually being live.** GPT being free doesn't change the cold-start risk at all, because GPT was never the risk; DeepL always was. If the app launches (or a user segment ramps up) *before* the pre-seed batch runs, or with the TTL still at 7 days, the immature-cache case is still: 300 misses/user/month × ~$0.0059 ≈ **$1.76/month ≈ 43,000₫/month** — dangerously close to a 50,000₫ price, leaving only ~14% margin in a bad month.

**Bottom line:** 50,000₫/month is safe *if and only if* the 1-year TTL and cache pre-seeding ship together before or alongside the price drop. Cutting the price without those two changes in place first would reintroduce the exact thin-margin risk flagged back when 50,000₫ was first discussed — the multi-provider GPT split doesn't fix that risk, since it was never a GPT cost problem to begin with.

---

## 11 — Correction: SePay Fee Was a Placeholder, Not a Real Cost

Sections 4, 9, and 10 above list SePay at a flat "~$5/month" (10,000-user tier only, $0 below that). That doesn't match how SePay actually charges: **1.5–2% of transaction value, no monthly fee** (confirmed in the kit's own payment-gateway-integration-guide.md). A flat $5 badly understates this once there's real revenue flowing through — at 10,000 paying users it should be roughly **$599/month**, not $5. This is corrected in Section 12's combined P&L below. Nothing about the AI/infra cost figures in Sections 3–10 changes — this only affects the SePay line and, therefore, every "Total/month" figure in those sections was actually overcounting margin by omitting this properly. Same conclusion, but the real number belongs in the model.

---

## 12 — Platform Distribution Costs (macOS + Windows) — Not Previously Modeled

Everything above prices the *server-side* pipeline. Getting the Tauri app onto a user's Mac or Windows machine at all — without the OS itself scaring the user away before they ever reach the paywall — has its own cost, not covered anywhere above.

### macOS

- **Apple Developer Program: $99/year.** Mandatory for code signing + notarization. Without it, Gatekeeper shows "Apple could not verify... is free of malware" / "unidentified developer," and on current macOS versions an unsigned/unnotarized `.dmg` can outright fail to launch rather than just warn. For a paid consumer app aimed at students — not developers who know to right-click-and-open past the warning — this is not optional; it's the single highest-leverage $99 in this entire cost model, because it's the difference between a checkout page anyone reaches and one most non-technical users bounce off before they ever see it.
- Notarization itself has no separate fee — it's `xcrun notarytool` (or `tauri-action`'s built-in support) using that same paid account.

### Windows

Two real paths, not one:

| Path | Cost | Trade-off |
|---|---|---|
| **OV certificate** | ~$200–300/year + a required hardware token/HSM (physical USB dongle or cloud HSM, CA/Browser Forum has mandated hardware-backed key custody since June 2023) | Cheaper on paper, but SmartScreen reputation starts at zero — early downloaders still see a "Windows protected your PC" interstitial until enough clean installs accumulate. Token juggling also complicates signing from GitHub Actions. |
| **EV certificate** | ~$400+/year | Immediate SmartScreen reputation, same hardware-token requirement and CI friction as OV. |
| **Azure Trusted Signing** (recommended) | $9.99/month Basic tier (5,000 signatures/month — releases won't come close) ≈ **~$120/year** | Cloud-native, no physical token, built for exactly this CI/CD signing use case — fits directly into the existing `.github/workflows/build.yml` tag-triggered build. **Caveat: verify current eligibility requirements before committing** (historically gated by business age/verification — not independently confirmed here for this specific account). |

**Recommended combined platform cost: $99 (Apple) + ~$120/year (Azure Trusted Signing) ≈ $219/year ≈ $18.25/month amortized.** Cheapest OV-cert Windows path would trade ~$100–180/year of savings for a worse first-run experience and more CI complexity — not worth it for the difference in play here.

### Note also affecting cost, separate from signing

This repo (`FelixNguyen142016/smart-translation`) is confirmed **private**. GitHub Actions' free tier gives private repos 2,000 minutes/month, but **macOS runners count at 10x** against that quota (Windows at 2x) — a single tagged release building both `build-mac` and `build-win` (per the existing workflow) can burn several hundred minutes in one run. Overage beyond the free quota is billed per-minute (macOS ≈ $0.062/min as of the Jan 2026 GitHub price cut). This doesn't block anything, but tag releases accordingly — it's worth checking Settings → Billing → Actions on the actual account rather than assuming free-tier headroom, especially if release cadence goes weekly.

---

## 13 — Combined P&L: Revenue vs. Total Cost

**Assumptions (all explicitly modeled, not measured):**
- FX: 25,400₫ = $1 (approximate — re-check current rate before treating these USD figures as exact)
- Revenue mix: 50% of paying users on Monthly (99,000₫), 50% on Annual (899,000₫ ÷ 12 = 74,917₫/mo effective) → blended **86,959₫ (~$3.42) per paying user per month**. 100%-Monthly would be 99,000₫ (~$3.90)/user/mo — use that as the upper bound if annual adoption undershoots.
- SePay fee: 1.75% of gross revenue (midpoint of the confirmed 1.5–2% range), not the earlier flat placeholder.
- Platform distribution: $18.25/month amortized (Section 12), constant regardless of scale.
- The "100 / 1,000 / 10,000" columns are **paying subscribers**, matching Sections 4/7's own assumption (20 lookups/day/paying-user) — not total registered users. Free-tier users cost effectively $0 in this model since Cloud AI is Pro-gated (Section 1) and they use the local free dictionary instead.
- These are unit-economics scale points for stress-testing the pricing model, **not adoption forecasts** — nothing here predicts how many subscribers this app will actually get.

| | 100 paying users | 1,000 paying users | 10,000 paying users |
|---|---|---|---|
| Gross revenue/mo (blended mix) | $342 (8,695,850₫) | $3,424 (86,958,500₫) | $34,236 (869,585,000₫) |
| SePay fee (1.75%) | −$6 | −$60 | −$599 |
| AI/infra cost — immature cache (7-day TTL, Section 4) | −$202 | −$1,199 | −$6,052 |
| AI/infra cost — mature + pre-seeded (1yr TTL, Section 9) | −$33 | −$122 | −$1,204 |
| Platform distribution (amortized) | −$18 | −$18 | −$18 |
| **Net profit/mo — cold start (immature cache)** | **~$116 (34% margin)** | **~$2,146 (63% margin)** | **~$27,566 (81% margin)** |
| **Net profit/mo — mature, post-TTL-fix + pre-seed** | **~$285 (83% margin)** | **~$3,223 (94% margin)** | **~$32,414 (95% margin)** |

Margin gets *better* with scale in both scenarios (SePay's % fee and the flat platform cost both shrink as a share of revenue), and the immature→mature gap (Sections 4 vs 9's TTL/pre-seeding work) is worth roughly **2.5x the net profit at every scale** — the single highest-leverage engineering change in this entire model, bigger than the platform-signing decision.

### Break-even on the platform distribution cost specifically

Using the *worst-case* immature-cache marginal cost per user (~$2.01/user/month, Section 7) against blended revenue net of the SePay fee (~$3.36/user/month): net contribution ≈ **$1.35/user/month** → the $18.25/month Apple+Windows signing cost pays for itself at **~14 paying subscribers**, even before the TTL/cache work ships. Once the cache matures (marginal cost drops to ~$0.24/user/month, Section 7), that drops to **~6 subscribers**. Either way, platform distribution cost is not a meaningful barrier — it just has to be paid *before* subscriber #1, since Gatekeeper/SmartScreen block the checkout flow entirely otherwise, not because the dollar amount itself is large.

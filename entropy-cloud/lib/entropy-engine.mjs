var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// source/scoring.cjs
var require_scoring = __commonJS({
  "source/scoring.cjs"(exports, module) {
    "use strict";
    (function(root, factory) {
      const api = factory();
      if (typeof module === "object" && module.exports) module.exports = api;
      root.EntropyScoring = api;
    })(typeof globalThis !== "undefined" ? globalThis : exports, function() {
      "use strict";
      const ALGORITHM_VERSION = "entropy-zama-adapted-v0.1";
      const NUMERIC_INPUTS = [
        "impressions",
        "likes",
        "reposts",
        "quotes",
        "followers",
        "smartFollowers",
        "smartEngagement",
        "posts"
      ];
      function finiteNonnegative(value) {
        return typeof value === "number" && Number.isFinite(value) && value >= 0;
      }
      function canonicalId(value) {
        return value === null || value === void 0 ? "" : String(value).trim();
      }
      function unique(values) {
        return Array.from(new Set(values));
      }
      function scoreAuthor(rawInput) {
        const input = rawInput && typeof rawInput === "object" ? rawInput : {};
        const invalid2 = [];
        const missing = [];
        const reasonCodes = [];
        const values = {};
        for (const key of NUMERIC_INPUTS) {
          const value = input[key];
          if (value === null || value === void 0) values[key] = null;
          else if (!finiteNonnegative(value) || key === "posts" && !Number.isInteger(value)) {
            values[key] = null;
            invalid2.push(key);
          } else values[key] = value;
        }
        const components = {
          er: null,
          ERpercent: null,
          SRM: null,
          SF: null,
          IMP: null,
          qW: null,
          ENG: null,
          ENG_raw: null,
          EngObs: null,
          ERcap: null,
          EffEng: null,
          Clamp: null,
          SENG: null,
          QE: null,
          postMult: null,
          erMult: null,
          engageBlock: null,
          audienceBlock: null,
          reachBlock: null,
          efficiencyBlock: null,
          baseScore: null,
          penaltyMult: null,
          finalScore: null,
          smartFollowersExact: false,
          smartEngagementExact: false,
          smartFollowersCapReached: false,
          smartEngagementCapReached: false
        };
        const I = values.impressions;
        const P = values.posts;
        const coreKeys = ["impressions", "likes", "reposts", "quotes", "followers", "posts"];
        for (const key of coreKeys) if (values[key] === null) missing.push(key);
        for (const key of invalid2) reasonCodes.push("INVALID_" + key.replace(/[A-Z]/g, (m) => "_" + m).toUpperCase());
        if (I !== null) {
          components.SRM = Math.min(1, I / 1e5);
          components.IMP = Math.sqrt(I);
          components.reachBlock = components.IMP * 10;
          components.qW = 4 + 2 * components.SRM;
          components.ERcap = 0.01 + 0.04 * components.SRM;
        }
        if (P !== null) components.postMult = 1 + 0.02 * Math.min(P, 20);
        if (values.smartFollowers !== null) {
          components.SF = Math.min(Math.log10(values.smartFollowers + 1), 3);
          components.audienceBlock = components.SF * 500;
          components.smartFollowersCapReached = values.smartFollowers >= 999;
          components.smartFollowersExact = input.smartFollowersComplete === true || components.smartFollowersCapReached;
          if (!components.smartFollowersExact) {
            missing.push("smartFollowersComplete");
            reasonCodes.push("SMART_FOLLOWERS_PARTIAL");
          }
        } else missing.push("smartFollowers");
        const reactionsKnown = ["likes", "reposts", "quotes"].every((k) => values[k] !== null);
        if (I !== null && components.qW !== null && reactionsKnown) {
          const unweighted = values.likes + values.reposts + values.quotes;
          components.ENG = values.likes + 3 * values.reposts + components.qW * values.quotes;
          components.ENG_raw = components.ENG;
          if (I > 0) {
            components.er = unweighted / I;
            components.ERpercent = 100 * components.er;
            components.EngObs = Math.max(components.ENG_raw, components.er * I);
            components.EffEng = Math.min(components.EngObs, I * components.ERcap);
            components.Clamp = components.EngObs === 0 ? 1 : components.EffEng / components.EngObs;
            components.erMult = 0.9 + 2 * Math.min(components.er, 0.05);
            components.penaltyMult = components.er > 0.1 && I < 5e4 ? 0.3 : 1;
            if (components.er > 0.2) reasonCodes.push("ER_ABOVE_20_REVIEW");
            if (components.penaltyMult === 0.3) reasonCodes.push("ER_ABOVE_10_LOW_REACH_PENALTY");
          }
        }
        if (I !== null && values.followers !== null) {
          components.QE = Math.min(Math.log1p(I / Math.max(values.followers, 1)), 2) * components.SRM;
          components.efficiencyBlock = components.QE * 120;
        }
        if (components.EffEng !== null) {
          const smartCap = 0.5 * components.EffEng;
          if (smartCap === 0) {
            components.SENG = 0;
            components.smartEngagementCapReached = true;
            components.smartEngagementExact = true;
          } else if (values.smartEngagement !== null) {
            components.SENG = Math.min(values.smartEngagement, smartCap);
            components.smartEngagementCapReached = values.smartEngagement >= smartCap;
            components.smartEngagementExact = input.smartEngagementComplete === true || components.smartEngagementCapReached;
          }
        }
        if (!components.smartEngagementExact) {
          if (values.smartEngagement === null) missing.push("smartEngagement");
          else {
            missing.push("smartEngagementComplete");
            reasonCodes.push("SMART_ENGAGEMENT_PARTIAL");
          }
        }
        const engagementKnown = ["ENG", "Clamp", "SENG", "SRM"].every((k) => components[k] !== null);
        if (engagementKnown) {
          components.engageBlock = (0.7 * components.ENG * components.Clamp + 150 * components.SENG) * Math.pow(components.SRM, 1.5);
        }
        if (["audienceBlock", "reachBlock", "engageBlock", "efficiencyBlock"].every((k) => components[k] !== null)) {
          components.baseScore = components.audienceBlock + components.reachBlock + components.engageBlock + components.efficiencyBlock;
          if (components.erMult !== null && components.postMult !== null && components.penaltyMult !== null) {
            components.finalScore = components.baseScore * components.erMult * components.postMult * components.penaltyMult;
          }
        }
        let arithmeticOverflow = false;
        for (const key of Object.keys(components)) {
          if (typeof components[key] === "number" && !Number.isFinite(components[key])) {
            components[key] = null;
            arithmeticOverflow = true;
          }
        }
        if (arithmeticOverflow) {
          reasonCodes.push("NUMERIC_OVERFLOW");
          components.finalScore = null;
        }
        const requiresReview = components.er !== null && components.er > 0.2;
        const ineligible = P !== null && P < 2 || I === 0;
        if (P !== null && P < 2) reasonCodes.push("POSTS_LT_2");
        if (I === 0) reasonCodes.push("NO_IMPRESSIONS");
        let status;
        let score = null;
        if (ineligible && invalid2.length === 0) status = "ineligible";
        else if (missing.length || invalid2.length || arithmeticOverflow || components.finalScore === null) {
          status = "incomplete";
          reasonCodes.push("INCOMPLETE_INPUTS");
        } else {
          status = requiresReview ? "review" : "eligible";
          score = components.finalScore;
        }
        if (status === "incomplete" || status === "ineligible") components.finalScore = null;
        return {
          algorithmVersion: ALGORITHM_VERSION,
          status,
          score,
          provisional: status === "review" || status === "incomplete",
          requiresReview,
          reasonCodes: unique(reasonCodes),
          components,
          missing: unique(missing.concat(invalid2)),
          invalid: unique(invalid2)
        };
      }
      function usableEvidence(evidence) {
        if (!Array.isArray(evidence)) return [];
        return evidence.filter((item) => {
          if (!item || typeof item.url !== "string") return false;
          try {
            const parsed = new URL(item.url);
            return parsed.protocol === "https:" || parsed.protocol === "http:";
          } catch (_) {
            return false;
          }
        }).map((item) => ({ url: item.url.trim(), note: typeof item.note === "string" ? item.note.trim() : "" }));
      }
      function assessAccount(account) {
        const record = account && typeof account === "object" ? account : {};
        const id = canonicalId(record.id);
        const evidence = usableEvidence(record.evidence);
        const reason = typeof record.reason === "string" ? record.reason.trim() : "";
        const reasonCodes = [];
        if (!id) reasonCodes.push("MISSING_ACCOUNT_ID");
        if (record.trust === null || record.trust === void 0) {
          return {
            id,
            status: id ? "unassessed" : "invalid",
            trust: null,
            reason,
            evidence,
            reviewedAt: record.reviewedAt || null,
            reasonCodes: reasonCodes.concat("TRUST_UNASSESSED")
          };
        }
        if (![0, 0.5, 1].includes(record.trust)) reasonCodes.push("INVALID_TRUST");
        if (!reason) reasonCodes.push("MISSING_ASSESSMENT_REASON");
        if (!evidence.length) reasonCodes.push("MISSING_ASSESSMENT_EVIDENCE");
        return {
          id,
          status: reasonCodes.length ? "invalid" : "assessed",
          trust: reasonCodes.length ? null : record.trust,
          reason,
          evidence,
          reviewedAt: record.reviewedAt || null,
          reasonCodes: reasonCodes.length ? reasonCodes : ["TRUST_ASSESSED"]
        };
      }
      function computeSmartMetrics(authorId, accounts, followRelations, interactions, includedPostIds, period) {
        const author = canonicalId(authorId);
        const assessments = /* @__PURE__ */ new Map();
        const duplicateAccountIds = /* @__PURE__ */ new Set();
        for (const record of Array.isArray(accounts) ? accounts : []) {
          const assessment = assessAccount(record);
          if (!assessment.id) continue;
          const prior = assessments.get(assessment.id);
          if (prior && (prior.status !== assessment.status || prior.trust !== assessment.trust)) {
            duplicateAccountIds.add(assessment.id);
            assessments.set(assessment.id, { ...assessment, status: "invalid", trust: null, reasonCodes: ["CONFLICTING_ACCOUNT_ASSESSMENTS"] });
          } else if (!duplicateAccountIds.has(assessment.id)) assessments.set(assessment.id, assessment);
        }
        const included = new Set(Array.from(includedPostIds || []).map(canonicalId));
        const followerIds = /* @__PURE__ */ new Set();
        for (const rel of Array.isArray(followRelations) ? followRelations : []) {
          if (rel && rel.confirmed === true && canonicalId(rel.authorId) === author) {
            const id = canonicalId(rel.accountId);
            if (id && id !== author) followerIds.add(id);
          }
        }
        const periodProvided = !!(period && (period.start !== void 0 || period.endExclusive !== void 0));
        const start = periodProvided && period.start !== void 0 ? Date.parse(period.start) : -Infinity;
        const end = periodProvided && period.endExclusive !== void 0 ? Date.parse(period.endExclusive) : Infinity;
        const invalidPeriod = periodProvided && (Number.isNaN(start) || Number.isNaN(end) || end <= start);
        const qualifiedIds = /* @__PURE__ */ new Set();
        const undatedIds = /* @__PURE__ */ new Set();
        const unclassifiedIds = /* @__PURE__ */ new Set();
        let ignoredInteractions = 0;
        let outOfPeriodInteractions = 0;
        for (const event of Array.isArray(interactions) ? interactions : []) {
          if (!event || canonicalId(event.authorId) !== author || !included.has(canonicalId(event.postId)) || !["quote", "reply"].includes(event.type)) {
            ignoredInteractions++;
            continue;
          }
          const id = canonicalId(event.accountId);
          if (!id || id === author) {
            ignoredInteractions++;
            continue;
          }
          if (event.meaningful === false) {
            ignoredInteractions++;
            continue;
          }
          if (periodProvided) {
            const timestamp2 = event.occurredAt ? Date.parse(event.occurredAt) : NaN;
            if (invalidPeriod || Number.isNaN(timestamp2)) {
              undatedIds.add(id);
              if (event.meaningful !== true) unclassifiedIds.add(id);
              continue;
            }
            if (timestamp2 < start || timestamp2 >= end) {
              outOfPeriodInteractions++;
              continue;
            }
          }
          if (event.meaningful !== true) {
            unclassifiedIds.add(id);
            continue;
          }
          qualifiedIds.add(id);
        }
        function totalFor(ids) {
          let total = 0;
          let assessedCount = 0;
          const contributors = [];
          const unknownAccountIds = [];
          for (const id of ids) {
            const assessment = assessments.get(id);
            if (!assessment || assessment.status !== "assessed") unknownAccountIds.push(id);
            else {
              total += assessment.trust;
              assessedCount++;
              contributors.push({ accountId: id, trust: assessment.trust, contribution: assessment.trust });
            }
          }
          return { total, assessedCount, unknownAccountIds, contributors };
        }
        const followers = totalFor(followerIds);
        const engagement = totalFor(qualifiedIds);
        const undatedUnresolved = Array.from(undatedIds).filter((id) => !qualifiedIds.has(id));
        const unclassifiedUnresolved = Array.from(unclassifiedIds).filter((id) => !qualifiedIds.has(id));
        const followerMissing = [];
        const engagementMissing = [];
        if (followers.unknownAccountIds.length) followerMissing.push("FOLLOWER_ASSESSMENTS_MISSING");
        if (engagement.unknownAccountIds.length) engagementMissing.push("ENGAGEMENT_ASSESSMENTS_MISSING");
        if (undatedUnresolved.length) engagementMissing.push("INTERACTION_DATES_UNVERIFIED");
        if (unclassifiedUnresolved.length) engagementMissing.push("INTERACTION_MEANINGFULNESS_UNVERIFIED");
        if (invalidPeriod) engagementMissing.push("INVALID_PERIOD");
        const missing = unique(followerMissing.concat(engagementMissing));
        return {
          algorithmVersion: ALGORITHM_VERSION,
          smartFollowers: followers.total,
          smartEngagement: engagement.total,
          smartFollowersComplete: false,
          smartEngagementComplete: false,
          followers: { ...followers, confirmedCount: followerIds.size, missing: followerMissing },
          engagement: {
            ...engagement,
            qualifiedAccountCount: qualifiedIds.size,
            undatedAccountIds: undatedUnresolved,
            unclassifiedAccountIds: unclassifiedUnresolved,
            missing: engagementMissing
          },
          missing,
          diagnostics: { ignoredInteractions, outOfPeriodInteractions, invalidPeriod, duplicateAccountIds: Array.from(duplicateAccountIds) }
        };
      }
      return { ALGORITHM_VERSION, scoreAuthor, assessAccount, computeSmartMetrics };
    });
  }
});

// source/model.cjs
var require_model = __commonJS({
  "source/model.cjs"(exports, module) {
    "use strict";
    (function(root, factory) {
      const api = factory(root.EntropyScoring || (typeof __require === "function" ? require_scoring() : null));
      if (typeof module === "object" && module.exports) module.exports = api;
      root.EntropyModel = api;
    })(typeof globalThis !== "undefined" ? globalThis : exports, function(Scoring) {
      "use strict";
      const METRICS2 = ["impressions", "likes", "reposts", "uiReposts", "quotes", "replies", "bookmarks"];
      const isNumber = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
      const safeId = (v) => typeof v === "string" && v.trim() === v && v.length > 0 && !["__proto__", "prototype", "constructor"].includes(v);
      const plain3 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
      function confirmedRelevance(r) {
        if (!plain3(r) || r.version !== "entropy-context-v1" || !Array.isArray(r.reasonCodes) || !Array.isArray(r.signals)) return false;
        return ["DIRECT_MENTION", "OFFICIAL_DOMAIN", "OFFICIAL_POST_LINK", "OFFICIAL_QUOTE"].some((code) => r.reasonCodes.includes(code) && r.signals.includes(code.toLowerCase())) || r.reasonCodes.includes("PROJECT_CONTEXT") && ["brand_name", "product_context"].every((code) => r.signals.includes(code)) && ["hyperliquid_context", "hip3_context"].some((code) => r.signals.includes(code));
      }
      function isoDate(v) {
        if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
        const n = /* @__PURE__ */ new Date(v + "T00:00:00Z");
        return Number.isFinite(n.getTime()) && n.toISOString().slice(0, 10) === v;
      }
      function validateDataset(raw) {
        if (!raw || !Array.isArray(raw.authors) || !Array.isArray(raw.posts)) throw new Error("\u041F\u043E\u0442\u0440\u0456\u0431\u043D\u0456 \u0441\u043F\u0438\u0441\u043A\u0438 authors \u0456 posts.");
        if (raw.authors.length > 2e4 || raw.posts.length > 1e5) throw new Error("\u041D\u0430\u0431\u0456\u0440 \u0437\u0430\u0432\u0435\u043B\u0438\u043A\u0438\u0439 \u0434\u043B\u044F \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u043E\u0433\u043E \u043F\u0440\u043E\u0442\u043E\u0442\u0438\u043F\u0443.");
        const ids = /* @__PURE__ */ new Set();
        const authors = raw.authors.map((a) => {
          if (!a || !safeId(a.id) || typeof a.handle !== "string" || !a.handle.trim()) throw new Error("\u0423 \u0430\u0432\u0442\u043E\u0440\u0430 \u043F\u043E\u0442\u0440\u0456\u0431\u043D\u0456 \u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0456 \u0442\u0435\u043A\u0441\u0442\u043E\u0432\u0456 id \u0456 handle.");
          if (ids.has(a.id)) throw new Error("\u041F\u043E\u0432\u0442\u043E\u0440\u043D\u0438\u0439 ID \u0430\u0432\u0442\u043E\u0440\u0430: " + a.id);
          ids.add(a.id);
          if (a.followers !== null && a.followers !== void 0 && !isNumber(a.followers)) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0430 \u043A\u0456\u043B\u044C\u043A\u0456\u0441\u0442\u044C \u043F\u0456\u0434\u043F\u0438\u0441\u043D\u0438\u043A\u0456\u0432.");
          return { ...a, followers: a.followers ?? null, smartFollowersComplete: a.smartFollowersComplete === true, smartEngagementComplete: a.smartEngagementComplete === true };
        });
        const postIds = /* @__PURE__ */ new Set();
        const posts = raw.posts.map((p) => {
          if (!p || !safeId(p.id) || postIds.has(p.id)) throw new Error("ID \u043F\u043E\u0441\u0442\u0430 \u0432\u0456\u0434\u0441\u0443\u0442\u043D\u0456\u0439, \u043D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0430\u0431\u043E \u043F\u043E\u0432\u0442\u043E\u0440\u044E\u0454\u0442\u044C\u0441\u044F.");
          postIds.add(p.id);
          if (p.workId !== null && p.workId !== void 0 && !safeId(p.workId)) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 workId \u0443 \u043F\u043E\u0441\u0442\u0456.");
          if (!ids.has(p.authorId)) throw new Error("\u0414\u043B\u044F \u043F\u043E\u0441\u0442\u0430 \u043D\u0435\u043C\u0430\u0454 \u0430\u0432\u0442\u043E\u0440\u0430: " + p.id);
          const day2 = p.date || (typeof p.publishedAt === "string" ? p.publishedAt.slice(0, 10) : null);
          if (!isoDate(day2)) throw new Error("\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0430 \u0430\u0431\u043E \u043D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0430 \u0434\u0430\u0442\u0430 \u043F\u043E\u0441\u0442\u0430: " + p.id);
          let url2;
          try {
            url2 = new URL(p.url);
          } catch (_) {
            throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0435 \u043F\u043E\u0441\u0438\u043B\u0430\u043D\u043D\u044F \u043F\u043E\u0441\u0442\u0430.");
          }
          if (url2.protocol !== "https:" || !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url2.hostname)) throw new Error("\u0414\u043B\u044F \u043F\u043E\u0441\u0442\u0430 \u043F\u043E\u0442\u0440\u0456\u0431\u043D\u0435 HTTPS-\u043F\u043E\u0441\u0438\u043B\u0430\u043D\u043D\u044F X.");
          const metrics = {};
          for (const k of METRICS2) {
            const v = p.metrics?.[k];
            if (v !== null && v !== void 0 && !isNumber(v)) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0430 \u043C\u0435\u0442\u0440\u0438\u043A\u0430 " + k + " \u0443 \u043F\u043E\u0441\u0442\u0456 " + p.id);
            metrics[k] = v ?? null;
          }
          let relevance;
          if (p.relevance !== void 0 && p.relevance !== null) {
            const r = p.relevance;
            const codes = (values) => Array.isArray(values) && values.length <= 32 && values.every((v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v));
            const acceptedProof = confirmedRelevance(r);
            if (!plain3(r) || r.version !== "entropy-context-v1" || !["accepted", "review", "rejected"].includes(r.status) || !codes(r.reasonCodes || []) || !codes(r.signals || []) || r.status === "accepted" && !acceptedProof) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0432\u0438\u0441\u043D\u043E\u0432\u043E\u043A \u043F\u0440\u043E \u043D\u0430\u043B\u0435\u0436\u043D\u0456\u0441\u0442\u044C \u043F\u043E\u0441\u0442\u0430 \u0434\u043E Entropy.");
            relevance = { ...r, reasonCodes: [...r.reasonCodes || []], signals: [...r.signals || []] };
          }
          return { ...p, ...relevance ? { relevance } : {}, date: day2, metrics, summary: typeof p.summary === "string" ? p.summary : "", body: typeof p.body === "string" ? p.body : null };
        });
        const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
        const accountIds = /* @__PURE__ */ new Set();
        accounts.forEach((a) => {
          if (!a || !safeId(a.id) || accountIds.has(a.id)) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0430\u0431\u043E \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u0438\u0439 ID \u0430\u043A\u0430\u0443\u043D\u0442\u0430 \u0430\u0443\u0434\u0438\u0442\u043E\u0440\u0456\u0457.");
          accountIds.add(a.id);
        });
        const meta = plain3(raw.meta) ? raw.meta : { coverage: "unknown", asOf: null };
        for (const k of ["periodStart", "periodEndExclusive"]) if (meta[k] !== void 0 && !isoDate(meta[k])) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0430 \u043C\u0435\u0436\u0430 \u043F\u0435\u0440\u0456\u043E\u0434\u0443 \u0434\u0436\u0435\u0440\u0435\u043B\u0430.");
        return {
          meta,
          authors,
          posts,
          accounts,
          followRelations: Array.isArray(raw.followRelations) ? raw.followRelations : [],
          interactions: Array.isArray(raw.interactions) ? raw.interactions : []
        };
      }
      function periodFor(key, dataset) {
        if (/^\d{4}-\d{2}$/.test(key)) {
          const [y, m] = key.split("-").map(Number);
          if (m < 1 || m > 12) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u043C\u0456\u0441\u044F\u0446\u044C.");
          return { key, start: key + "-01", endExclusive: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10), monthly: true };
        }
        return { key: "sample", start: dataset.meta.periodStart || "2026-10-17", endExclusive: dataset.meta.periodEndExclusive || "2026-11-17", monthly: false };
      }
      function sumKnown(posts, key) {
        if (!posts.length) return 0;
        if (posts.some((p) => !isNumber(p.metrics[key]))) return null;
        return posts.reduce((n, p) => n + p.metrics[key], 0);
      }
      function reviewAccounts(dataset, reviews) {
        const byId = new Map(dataset.accounts.map((a) => [a.id, a]));
        Object.values(reviews || {}).forEach((a) => byId.set(a.id, { ...byId.get(a.id) || {}, ...a }));
        return [...byId.values()];
      }
      function postEligibility(post) {
        const reference = (value) => typeof value === "string" ? value.trim().length > 0 : typeof value === "number" && Number.isFinite(value);
        if (post.isReply === true || reference(post.inReplyToId)) return { eligible: false, reason: "reply" };
        if (post.isRetweet === true || post.isRepost === true || plain3(post.retweeted_tweet) || reference(post.retweeted_tweet) || reference(post.retweetedTweetId) || reference(post.repostedTweetId)) return { eligible: false, reason: "repost" };
        return { eligible: true, reason: null };
      }
      function relevanceEligibility(post, state = {}) {
        const decision2 = state.postRelevance?.[post.id];
        if (decision2?.action === "reject") return { eligible: false, reason: "relevance-rejected", manual: true };
        if (decision2?.action === "approve") return { eligible: true, reason: "relevance-approved", manual: true };
        if (!post.relevance) return { eligible: true, reason: "legacy", manual: false };
        if (post.relevance.status === "accepted") return confirmedRelevance(post.relevance) ? { eligible: true, reason: "relevance-confirmed", manual: false } : { eligible: false, reason: "relevance-review", manual: false };
        return { eligible: false, reason: post.relevance.status === "review" ? "relevance-review" : "relevance-rejected", manual: false };
      }
      function countablePost(post, state = {}) {
        const kind = postEligibility(post);
        return kind.eligible ? relevanceEligibility(post, state) : kind;
      }
      function relevanceQueue(dataset, state, query = "") {
        const search = String(query).trim().toLowerCase();
        const authors = new Map(dataset.authors.map((author) => [author.id, author]));
        return dataset.posts.filter((post) => postEligibility(post).eligible && relevanceEligibility(post, state).reason === "relevance-review").filter((post) => !search || [post.body, post.summary, authors.get(post.authorId)?.handle, authors.get(post.authorId)?.displayName].join(" ").toLowerCase().includes(search)).sort((a, b) => String(b.publishedAt || b.date).localeCompare(String(a.publishedAt || a.date)) || b.id.localeCompare(a.id));
      }
      function aggregateAuthor(dataset, state, author, period) {
        const allPosts = dataset.posts.filter((p) => p.authorId === author.id && p.date >= period.start && p.date < period.endExclusive);
        const eligiblePosts = allPosts.filter((p) => countablePost(p, state).eligible);
        const ignoredPosts = allPosts.filter((p) => !countablePost(p, state).eligible);
        const pendingPosts = allPosts.filter((p) => postEligibility(p).eligible && relevanceEligibility(p, state).reason === "relevance-review");
        const posts = eligiblePosts.filter((p) => !state.postExclusions[p.id]);
        const works = [...new Set(posts.map((p) => p.workId || p.id))];
        const periodDecision = state.periodDecisions[period.key + "|" + author.id];
        const ban = state.bans[author.id];
        const manual = ban ? { ...ban, type: "ban" } : periodDecision ? { ...periodDecision, type: "exclude-period" } : null;
        const metrics = Object.fromEntries(METRICS2.map((k) => [k, sumKnown(posts, k)]));
        const accounts = reviewAccounts(dataset, state.accountReviews);
        const smart = Scoring.computeSmartMetrics(author.id, accounts, dataset.followRelations, dataset.interactions, posts.map((p) => p.id), {
          start: period.start + "T00:00:00Z",
          endExclusive: period.endExclusive + "T00:00:00Z"
        });
        const smartFollowersComplete = author.smartFollowersComplete === true && smart.followers.unknownAccountIds.length === 0 && author.followers !== null && smart.followers.confirmedCount === author.followers;
        const smartEngagementComplete = author.smartEngagementComplete === true && smart.engagement.unknownAccountIds.length === 0 && (smart.engagement.missing || smart.missing).length === 0;
        const score = Scoring.scoreAuthor({
          impressions: metrics.impressions,
          likes: metrics.likes,
          reposts: metrics.reposts,
          quotes: metrics.quotes,
          followers: author.followers,
          smartFollowers: smart.smartFollowers,
          smartEngagement: smart.smartEngagement,
          posts: works.length,
          smartFollowersComplete,
          smartEngagementComplete
        });
        const status = ban ? "banned" : periodDecision || eligiblePosts.length > 0 && posts.length === 0 ? "excluded" : eligiblePosts.length === 0 ? pendingPosts.length ? "review" : "no-posts" : score.requiresReview ? "review" : "active";
        return { author, allPosts, eligiblePosts, ignoredPosts, pendingPosts, posts, works, metrics, smart, smartFollowersComplete, smartEngagementComplete, score, manual, status, participates: !manual && posts.length > 0 };
      }
      function decision(state, payload, now) {
        const next = JSON.parse(JSON.stringify(state));
        const { type, authorId, postId, periodKey, reason, internalNote = "" } = payload;
        const restoring = type.startsWith("restore-");
        if (!restoring && (typeof reason !== "string" || reason.trim().length < 3)) throw new Error("\u041F\u043E\u0442\u0440\u0456\u0431\u043D\u0430 \u043F\u0440\u0438\u0447\u0438\u043D\u0430 \u0434\u043B\u044F \u0430\u0432\u0442\u043E\u0440\u0430.");
        const record = { reason: restoring ? "\u0420\u0456\u0448\u0435\u043D\u043D\u044F \u0441\u043A\u0430\u0441\u043E\u0432\u0430\u043D\u043E \u043C\u043E\u0434\u0435\u0440\u0430\u0442\u043E\u0440\u043E\u043C." : reason.trim(), internalNote: String(internalNote).trim(), at: now };
        if (type === "ban") next.bans[authorId] = record;
        else if (type === "exclude-period") next.periodDecisions[periodKey + "|" + authorId] = record;
        else if (type === "exclude-post") next.postExclusions[postId] = { ...record, authorId };
        else if (type === "restore-ban") delete next.bans[authorId];
        else if (type === "restore-period") delete next.periodDecisions[periodKey + "|" + authorId];
        else if (type === "restore-post") delete next.postExclusions[postId];
        else if (type === "approve-relevance" || type === "reject-relevance") {
          if (!safeId(postId) || !safeId(authorId)) throw new Error("\u041F\u043E\u0442\u0440\u0456\u0431\u043D\u0456 ID \u043F\u043E\u0441\u0442\u0430 \u0439 \u0430\u0432\u0442\u043E\u0440\u0430.");
          next.postRelevance ||= {};
          next.postRelevance[postId] = { ...record, authorId, action: type === "approve-relevance" ? "approve" : "reject" };
        } else if (type === "restore-relevance") delete (next.postRelevance ||= {})[postId];
        else throw new Error("\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0438\u0439 \u0442\u0438\u043F \u0440\u0456\u0448\u0435\u043D\u043D\u044F.");
        next.audit.unshift({ id: "event:" + now + ":" + next.audit.length, type, authorId, postId: postId || null, periodKey, ...record });
        next.audit = next.audit.slice(0, 1e3);
        return next;
      }
      function creatorView(dataset, state, authorId, period) {
        const author = dataset.authors.find((a2) => a2.id === authorId);
        if (!author) throw new Error("\u0410\u0432\u0442\u043E\u0440\u0430 \u043D\u0435 \u0437\u043D\u0430\u0439\u0434\u0435\u043D\u043E.");
        const a = aggregateAuthor(dataset, state, author, period);
        const publicDecision = (d) => d ? { reason: d.reason, at: d.at } : null;
        return {
          author: { id: author.id, handle: author.handle },
          period: { start: period.start, endExclusive: period.endExclusive },
          status: a.status,
          decision: publicDecision(a.manual),
          includedPosts: a.manual ? 0 : a.posts.length,
          excludedPosts: a.eligiblePosts.filter((p) => state.postExclusions[p.id]).map((p) => ({ id: p.id, url: p.url, date: p.date, ...publicDecision(state.postExclusions[p.id]) }))
        };
      }
      function initialState() {
        return { version: 1, bans: {}, periodDecisions: {}, postExclusions: {}, postRelevance: {}, accountReviews: {}, identityEvidence: {}, audit: [], snapshots: [], ui: { view: "leaderboard", period: "2026-11", sort: "impressions", status: "active", search: "" } };
      }
      function validateState(raw) {
        if (!plain3(raw) || raw.version !== 1) throw new Error("\u041D\u0435\u043F\u0456\u0434\u0442\u0440\u0438\u043C\u0443\u0432\u0430\u043D\u0430 \u0432\u0435\u0440\u0441\u0456\u044F \u0437\u0431\u0435\u0440\u0435\u0436\u0435\u043D\u043E\u0433\u043E \u0441\u0442\u0430\u043D\u0443.");
        const result = initialState();
        for (const k of ["bans", "periodDecisions", "postExclusions"]) {
          if (!plain3(raw[k])) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0441\u043F\u0438\u0441\u043E\u043A \u0440\u0456\u0448\u0435\u043D\u044C: " + k);
          for (const [id, record] of Object.entries(raw[k])) {
            if (!safeId(id) || !plain3(record) || typeof record.reason !== "string" || record.reason.trim().length < 3 || typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at)) || record.internalNote !== void 0 && typeof record.internalNote !== "string") throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0437\u0430\u043F\u0438\u0441 \u0440\u0456\u0448\u0435\u043D\u043D\u044F.");
            result[k][id] = { ...record, internalNote: record.internalNote || "" };
          }
        }
        if (raw.postRelevance !== void 0) {
          if (!plain3(raw.postRelevance) || Object.keys(raw.postRelevance).length > 1e5) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0441\u043F\u0438\u0441\u043E\u043A \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u043E\u043A \u0437\u0433\u0430\u0434\u043E\u043A.");
          for (const [id, record] of Object.entries(raw.postRelevance)) {
            if (!safeId(id) || !plain3(record) || !safeId(record.authorId) || !["approve", "reject"].includes(record.action) || typeof record.reason !== "string" || record.reason.trim().length < 3 || typeof record.at !== "string" || !Number.isFinite(Date.parse(record.at)) || record.internalNote !== void 0 && typeof record.internalNote !== "string") throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0435 \u0440\u0456\u0448\u0435\u043D\u043D\u044F \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u043A\u0438 \u0437\u0433\u0430\u0434\u043A\u0438.");
            result.postRelevance[id] = { ...record, internalNote: record.internalNote || "" };
          }
        }
        if (!plain3(raw.accountReviews)) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0441\u043F\u0438\u0441\u043E\u043A \u043E\u0446\u0456\u043D\u043E\u043A \u0430\u043A\u0430\u0443\u043D\u0442\u0456\u0432.");
        for (const [id, record] of Object.entries(raw.accountReviews)) {
          if (!safeId(id) || !plain3(record) || record.id !== id || Scoring.assessAccount(record).status === "invalid") throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0430 \u043E\u0446\u0456\u043D\u043A\u0430 \u0430\u043A\u0430\u0443\u043D\u0442\u0430.");
          result.accountReviews[id] = record;
        }
        if (raw.identityEvidence !== void 0) {
          if (!plain3(raw.identityEvidence) || Object.keys(raw.identityEvidence).length > 2e4) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0440\u0435\u0454\u0441\u0442\u0440 \u0456\u0434\u0435\u043D\u0442\u0438\u0447\u043D\u043E\u0441\u0442\u0435\u0439.");
          const postOwners = /* @__PURE__ */ new Map();
          let postCount = 0;
          for (const [id, record] of Object.entries(raw.identityEvidence)) {
            if (!safeId(id) || !plain3(record) || record.id !== id || typeof record.handle !== "string" || !record.handle.trim() || !Array.isArray(record.postIds) || record.postIds.some((postId) => !safeId(postId)) || new Set(record.postIds).size !== record.postIds.length) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0434\u043E\u043A\u0430\u0437 \u0456\u0434\u0435\u043D\u0442\u0438\u0447\u043D\u043E\u0441\u0442\u0456 \u0430\u0432\u0442\u043E\u0440\u0430.");
            postCount += record.postIds.length;
            if (postCount > 1e5) throw new Error("\u0420\u0435\u0454\u0441\u0442\u0440 \u0456\u0434\u0435\u043D\u0442\u0438\u0447\u043D\u043E\u0441\u0442\u0435\u0439 \u0437\u0430\u0432\u0435\u043B\u0438\u043A\u0438\u0439 \u0434\u043B\u044F \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u043E\u0433\u043E \u043F\u0440\u043E\u0442\u043E\u0442\u0438\u043F\u0443.");
            for (const postId of record.postIds) {
              if (postOwners.has(postId) && postOwners.get(postId) !== id) throw new Error("\u0423 \u0440\u0435\u0454\u0441\u0442\u0440\u0456 \u043E\u0434\u0438\u043D \u043F\u043E\u0441\u0442 \u043C\u0430\u0454 \u043A\u0456\u043B\u044C\u043A\u043E\u0445 \u0430\u0432\u0442\u043E\u0440\u0456\u0432.");
              postOwners.set(postId, id);
            }
            result.identityEvidence[id] = { id, handle: record.handle, postIds: [...record.postIds] };
          }
        }
        const eventTypes = ["ban", "exclude-period", "exclude-post", "restore-ban", "restore-period", "restore-post", "approve-relevance", "reject-relevance", "restore-relevance", "account-review"];
        if (!Array.isArray(raw.audit) || raw.audit.length > 1e3 || raw.audit.some((e) => !plain3(e) || !eventTypes.includes(e.type) || typeof e.at !== "string" || !Number.isFinite(Date.parse(e.at)) || typeof e.reason !== "string" || e.internalNote !== void 0 && typeof e.internalNote !== "string")) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0436\u0443\u0440\u043D\u0430\u043B \u0440\u0456\u0448\u0435\u043D\u044C.");
        result.audit = raw.audit;
        const ui = raw.ui;
        if (!plain3(ui) || !["leaderboard", "review", "audience", "method", "settings"].includes(ui.view) || !["impressions", "score", "likes", "replies"].includes(ui.sort) || !["active", "review", "excluded", "banned", "all"].includes(ui.status) || typeof ui.search !== "string" || !(ui.period === "sample" || /^\d{4}-(0[1-9]|1[0-2])$/.test(ui.period))) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0456 \u043D\u0430\u043B\u0430\u0448\u0442\u0443\u0432\u0430\u043D\u043D\u044F \u043F\u0435\u0440\u0435\u0433\u043B\u044F\u0434\u0443.");
        result.ui = { ...ui };
        return result;
      }
      function reconcileImport(previousDataset, nextDataset, state) {
        const previous = validateDataset(previousDataset);
        const next = validateDataset(nextDataset);
        const migrated = JSON.parse(JSON.stringify(validateState(state)));
        const previousPosts = new Map(previous.posts.map((p) => [p.id, p]));
        const previousAuthors = new Map(previous.authors.map((a) => [a.id, a]));
        const nextAuthorIds = new Set(next.authors.map((a) => a.id));
        const mappings = /* @__PURE__ */ new Map();
        const targets = /* @__PURE__ */ new Map();
        const identityError = (detail) => {
          throw new Error("\u0406\u043C\u043F\u043E\u0440\u0442 \u0437\u0443\u043F\u0438\u043D\u0435\u043D\u043E: \u043A\u043E\u043D\u0444\u043B\u0456\u043A\u0442 \u0456\u0434\u0435\u043D\u0442\u0438\u0447\u043D\u043E\u0441\u0442\u0456 \u0430\u0432\u0442\u043E\u0440\u0430. " + detail);
        };
        for (const evidence2 of Object.values(migrated.identityEvidence)) {
          if (!previousAuthors.has(evidence2.id)) previousAuthors.set(evidence2.id, evidence2);
          for (const postId of evidence2.postIds) {
            const existing = previousPosts.get(postId);
            if (existing && existing.authorId !== evidence2.id) identityError("\u041F\u043E\u0442\u043E\u0447\u043D\u0438\u0439 \u043D\u0430\u0431\u0456\u0440 \u0441\u0443\u043F\u0435\u0440\u0435\u0447\u0438\u0442\u044C \u0437\u0431\u0435\u0440\u0435\u0436\u0435\u043D\u043E\u043C\u0443 \u0430\u0432\u0442\u043E\u0440\u0441\u0442\u0432\u0443 \u043F\u043E\u0441\u0442\u0430: " + postId);
            previousPosts.set(postId, existing || { id: postId, authorId: evidence2.id });
          }
        }
        for (const post of next.posts) {
          const oldPost = previousPosts.get(post.id);
          if (!oldPost || oldPost.authorId === post.authorId) continue;
          if (!oldPost.authorId.startsWith("sample:") || !/^\d+$/.test(post.authorId)) identityError("\u041E\u0434\u0438\u043D \u043F\u043E\u0441\u0442 \u043F\u043E\u0432\u2019\u044F\u0437\u0430\u043D\u0438\u0439 \u0456\u0437 \u0440\u0456\u0437\u043D\u0438\u043C\u0438 \u0430\u0432\u0442\u043E\u0440\u0430\u043C\u0438: " + post.id);
          if (mappings.has(oldPost.authorId) && mappings.get(oldPost.authorId) !== post.authorId) identityError("\u0422\u0438\u043C\u0447\u0430\u0441\u043E\u0432\u043E\u0433\u043E \u0430\u0432\u0442\u043E\u0440\u0430 \u043F\u043E\u0432\u2019\u044F\u0437\u0430\u043D\u043E \u0437 \u043A\u0456\u043B\u044C\u043A\u043E\u043C\u0430 X User ID.");
          if (targets.has(post.authorId) && targets.get(post.authorId) !== oldPost.authorId) identityError("\u041A\u0456\u043B\u044C\u043A\u0430 \u0442\u0438\u043C\u0447\u0430\u0441\u043E\u0432\u0438\u0445 \u0430\u0432\u0442\u043E\u0440\u0456\u0432 \u043F\u0440\u0435\u0442\u0435\u043D\u0434\u0443\u044E\u0442\u044C \u043D\u0430 \u043E\u0434\u0438\u043D X User ID.");
          mappings.set(oldPost.authorId, post.authorId);
          targets.set(post.authorId, oldPost.authorId);
        }
        const authorReferenced = (id) => Object.hasOwn(migrated.bans, id) || Object.keys(migrated.periodDecisions).some((k) => k.endsWith("|" + id)) || Object.entries(migrated.postExclusions).some(([postId, d]) => d.authorId === id || previousPosts.get(postId)?.authorId === id) || Object.entries(migrated.postRelevance).some(([postId, d]) => d.authorId === id || previousPosts.get(postId)?.authorId === id) || migrated.audit.some((e) => e.authorId === id || e.accountId === id) || Object.hasOwn(migrated.accountReviews, id);
        for (const [oldId, newId] of mappings) {
          if (nextAuthorIds.has(oldId)) identityError("\u0423 \u043D\u043E\u0432\u043E\u043C\u0443 \u043D\u0430\u0431\u043E\u0440\u0456 \u0437\u0430\u043B\u0438\u0448\u0438\u0432\u0441\u044F \u0456 \u0442\u0438\u043C\u0447\u0430\u0441\u043E\u0432\u0438\u0439, \u0456 \u0441\u043F\u0440\u0430\u0432\u0436\u043D\u0456\u0439 ID \u043E\u0434\u043D\u043E\u0433\u043E \u0430\u0432\u0442\u043E\u0440\u0430.");
          if (previousAuthors.has(newId) || authorReferenced(newId)) identityError("\u0426\u0456\u043B\u044C\u043E\u0432\u0438\u0439 X User ID \u0443\u0436\u0435 \u043C\u0430\u0454 \u043E\u043A\u0440\u0435\u043C\u0443 \u0456\u0441\u0442\u043E\u0440\u0456\u044E \u0430\u0431\u043E \u0440\u0456\u0448\u0435\u043D\u043D\u044F.");
        }
        const normalizedHandle = (handle) => handle.replace(/^@/, "").toLowerCase();
        for (const author of previousAuthors.values()) {
          if (!author.id.startsWith("sample:") || mappings.has(author.id) || !authorReferenced(author.id)) continue;
          if (next.authors.some((a) => a.id !== author.id && normalizedHandle(a.handle) === normalizedHandle(author.handle))) {
            throw new Error("\u0406\u043C\u043F\u043E\u0440\u0442 \u0437\u0443\u043F\u0438\u043D\u0435\u043D\u043E: \u0434\u043B\u044F @" + normalizedHandle(author.handle) + " \u0454 \u0437\u0431\u0435\u0440\u0435\u0436\u0435\u043D\u0456 \u0440\u0456\u0448\u0435\u043D\u043D\u044F, \u0430\u043B\u0435 \u043D\u043E\u0432\u0438\u0439 ID \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u043E \u0441\u043F\u0456\u043B\u044C\u043D\u0438\u043C ID \u043F\u043E\u0441\u0442\u0430. \u0417\u0431\u0456\u0433\u0443 \u0456\u043C\u0435\u043D\u0456 \u043D\u0435\u0434\u043E\u0441\u0442\u0430\u0442\u043D\u044C\u043E; \u0434\u043E\u0434\u0430\u0439 \u043F\u043E\u043F\u0435\u0440\u0435\u0434\u043D\u0456\u0439 \u043F\u043E\u0441\u0442 \u0456\u0437 \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u0435\u043D\u0438\u043C \u0430\u0432\u0442\u043E\u0440\u043E\u043C.");
          }
        }
        const remap = (id) => mappings.get(id) || id;
        const remapKeys = (records, keyFor, recordFor = (record) => record) => {
          const result = {};
          for (const [key, record] of Object.entries(records)) {
            const mappedKey = keyFor(key);
            if (Object.hasOwn(result, mappedKey)) identityError("\u041F\u0456\u0434 \u0447\u0430\u0441 \u043F\u0435\u0440\u0435\u043D\u0435\u0441\u0435\u043D\u043D\u044F \u0437\u0456\u0442\u043A\u043D\u0443\u043B\u0438\u0441\u044F \u0437\u0431\u0435\u0440\u0435\u0436\u0435\u043D\u0456 \u0440\u0456\u0448\u0435\u043D\u043D\u044F.");
            result[mappedKey] = recordFor(record);
          }
          return result;
        };
        const evidence = {};
        for (const record of Object.values(migrated.identityEvidence)) {
          const id = remap(record.id);
          evidence[id] = { id, handle: record.handle, postIds: [...record.postIds] };
        }
        for (const author of [...previousAuthors.values(), ...next.authors]) {
          if (!authorReferenced(author.id) && !Object.hasOwn(evidence, remap(author.id))) continue;
          const id = remap(author.id);
          if (!Object.hasOwn(evidence, id)) evidence[id] = { id, handle: author.handle, postIds: [] };
        }
        const retainedPostIds = new Map(Object.values(evidence).map((record) => [record.id, new Set(record.postIds)]));
        for (const post of [...previousPosts.values(), ...next.posts]) {
          const record = evidence[remap(post.authorId)];
          if (record && !retainedPostIds.get(record.id).has(post.id)) {
            record.postIds.push(post.id);
            retainedPostIds.get(record.id).add(post.id);
          }
        }
        migrated.identityEvidence = evidence;
        migrated.bans = remapKeys(migrated.bans, remap);
        migrated.periodDecisions = remapKeys(migrated.periodDecisions, (key) => {
          for (const [oldId, newId] of mappings) if (key.endsWith("|" + oldId)) return key.slice(0, -oldId.length) + newId;
          return key;
        });
        migrated.postExclusions = remapKeys(migrated.postExclusions, (id) => id, (record) => ({ ...record, ...record.authorId ? { authorId: remap(record.authorId) } : {} }));
        migrated.postRelevance = remapKeys(migrated.postRelevance, (id) => id, (record) => ({ ...record, authorId: remap(record.authorId) }));
        migrated.accountReviews = remapKeys(migrated.accountReviews, remap, (record) => ({ ...record, id: remap(record.id) }));
        migrated.audit = migrated.audit.map((event) => ({
          ...event,
          ...event.authorId ? { authorId: remap(event.authorId) } : {},
          ...event.accountId ? { accountId: remap(event.accountId) } : {}
        }));
        return validateState(migrated);
      }
      return { validateDataset, validateState, reconcileImport, periodFor, sumKnown, reviewAccounts, postEligibility, relevanceEligibility, countablePost, relevanceQueue, aggregateAuthor, decision, creatorView, initialState, safeId };
    });
  }
});

// source/entry.mjs
var import_model3 = __toESM(require_model(), 1);

// source/relevance.mjs
var RELEVANCE_POLICY = "entropy-context-v1";
var RELEVANCE_SIGNALS = Object.freeze([
  "direct_mention",
  "official_domain",
  "official_post_link",
  "official_quote",
  "brand_name",
  "hyperliquid_context",
  "hip3_context",
  "product_context",
  "generic_trading_context",
  "community_context",
  "science_context",
  "other_project_context"
]);
var RELEVANCE_REASON_CODES = Object.freeze([
  "DIRECT_MENTION",
  "OFFICIAL_DOMAIN",
  "OFFICIAL_POST_LINK",
  "OFFICIAL_QUOTE",
  "PROJECT_CONTEXT",
  "AMBIGUOUS_ENTROPY",
  "CONFLICTING_CONTEXT",
  "UNRELATED_SCIENCE",
  "OTHER_PROJECT",
  "NO_PROJECT_EVIDENCE"
]);
var plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var array = (value) => Array.isArray(value) ? value : [];
var text = (value) => typeof value === "string" ? value : "";
var numericId = (value) => typeof value === "string" && /^[1-9]\d{0,24}$/.test(value);
var exactHandle = (value) => typeof value === "string" && value.toLowerCase() === "entropyio";
var brand = /(^|[^\p{L}\p{N}_])entropy(?:io)?(?=$|[^\p{L}\p{N}_])/iu;
var mention = /(^|[^A-Za-z0-9_])@entropyIO(?![A-Za-z0-9_])/i;
var urlsInText = /https?:\/\/[^\s<>"']+/giu;
var product = /\b(?:markets?|trad(?:e|es|ing)|perps?|perpetuals?|pre[\s-]?ipo|private\s+(?:equities|equity|markets?|assets?|companies)|equities|order[\s-]?books?)\b/i;
var genericTrading = /\b(?:crypto|defi|trading|trade|trader|perps?|perpetuals?|tokens?|airdrop|funding|staking|leverage|markets?)\b/i;
var community = /\b(?:creators?|community|discord|voices|council|genesis|contributors?|ambassadors?)\b/i;
var scientific = /\b(?:thermodynamics?|thermochemistr(?:y|ical)|shannon|boltzmann|gibbs|physics|electromagnet(?:ic|ism)|information\s+theory|cross[\s-]?entropy|entropy\s+loss|randomness|random\s+(?:numbers?|bits?|seeds?)|rng|heat\s+death|black\s+holes?|dry\s+reforming|synthesis\s+gas|syngas|(?:ni|nickel)\s+catalysts?|applied\s+catalysis|metallurg(?:y|ical)|high[\s-]?entropy\s+alloys?)\b/i;
var cryptographic = /\b(?:ecdsa|cryptograph(?:ic|ically|y)|prngs?|rngs?|nonces?|signing|signatures?|signers?|random\s+(?:bits?|seeds?))\b/i;
var technicalEntropy = /\b(?:arbitrary|cryptographic|insufficient|weak|low|fresh|random|shannon)\s+entropy\b|\bentropy\s+(?:sources?|pools?|bits?|in\s+signing|for\s+(?:nonces?|signing)|is\s+randomness)\b/gi;
var otherDomains = ["entropy.xyz", "entropynetwork.io", "entropy.international"];
function contextualProduct(prose) {
  let technical = false;
  const projectNames = prose.replace(technicalEntropy, (value, offset) => {
    if (!cryptographic.test(prose.slice(Math.max(0, offset - 100), offset + value.length + 100))) return value;
    technical = true;
    return " ".repeat(value.length);
  });
  if (!technical) return { product: product.test(prose), technical };
  const localProject = [...projectNames.matchAll(new RegExp(brand.source, "giu"))].some((match) => {
    const nearby = prose.slice(Math.max(0, match.index - 240), match.index + match[0].length + 240);
    return product.test(nearby) && /\b(?:hyperliquid|hip[\s-]?3)\b/i.test(nearby);
  });
  return { product: localProject && product.test(prose), technical };
}
function url(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const result = new URL(value.replace(/[),.;!?\]}]+$/u, ""));
    if (result.protocol !== "https:" || result.username || result.password || result.port) return null;
    return result;
  } catch {
    return null;
  }
}
function host(value) {
  return value.hostname.toLowerCase().replace(/\.$/, "");
}
var under = (hostname, domain) => hostname === domain || hostname.endsWith("." + domain);
function ownUrls(tweet) {
  const values = array(tweet.entities?.urls).map((value) => plain(value) ? value.expanded_url : null);
  values.push(...text(tweet.text).match(urlsInText) || []);
  return values.map(url).filter(Boolean);
}
function resultFor(signals) {
  const values = RELEVANCE_SIGNALS.filter((value) => signals.has(value));
  const anchors = [
    ["direct_mention", "DIRECT_MENTION"],
    ["official_domain", "OFFICIAL_DOMAIN"],
    ["official_post_link", "OFFICIAL_POST_LINK"],
    ["official_quote", "OFFICIAL_QUOTE"]
  ].filter(([signal]) => signals.has(signal)).map(([, code]) => code);
  const specificProject = signals.has("brand_name") && signals.has("product_context") && (signals.has("hyperliquid_context") || signals.has("hip3_context"));
  let status, reasonCodes;
  if (anchors.length) {
    status = "accepted";
    reasonCodes = anchors;
  } else if (specificProject && signals.has("other_project_context")) {
    status = "review";
    reasonCodes = ["CONFLICTING_CONTEXT"];
  } else if (specificProject) {
    status = "accepted";
    reasonCodes = ["PROJECT_CONTEXT"];
  } else if (signals.has("other_project_context")) {
    status = "rejected";
    reasonCodes = ["OTHER_PROJECT"];
  } else if (signals.has("brand_name") && signals.has("science_context") && !signals.has("generic_trading_context") && !signals.has("community_context")) {
    status = "rejected";
    reasonCodes = ["UNRELATED_SCIENCE"];
  } else if (signals.has("brand_name")) {
    status = "review";
    reasonCodes = ["AMBIGUOUS_ENTROPY"];
  } else {
    status = "rejected";
    reasonCodes = ["NO_PROJECT_EVIDENCE"];
  }
  return { version: RELEVANCE_POLICY, status, reasonCodes, signals: values };
}
function classifyTweet(raw) {
  const tweet = plain(raw) ? raw : {}, ownText = text(tweet.text), signals = /* @__PURE__ */ new Set();
  const prose = ownText.replace(urlsInText, " ");
  if (mention.test(prose) || array(tweet.entities?.user_mentions).some((value) => plain(value) && exactHandle(value.screen_name))) signals.add("direct_mention");
  for (const destination of ownUrls(tweet)) {
    const hostname = host(destination);
    if (under(hostname, "entropy.io")) signals.add("official_domain");
    if (["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(hostname) && /^\/entropyio\/status\/[1-9]\d{0,24}(?:\/(?:photo|video)\/\d+)?\/?$/i.test(destination.pathname)) signals.add("official_post_link");
    if (otherDomains.some((domain) => under(hostname, domain)) || under(hostname, "pyth.network") && /^\/entropy(?:\/|$)/i.test(destination.pathname)) signals.add("other_project_context");
    if (hostname === "discord.gg" && /^\/entropyio\/?$/i.test(destination.pathname)) signals.add("community_context");
  }
  const quote = plain(tweet.quoted_tweet) ? tweet.quoted_tweet : null;
  if (quote && numericId(quote.id) && plain(quote.author) && exactHandle(quote.author.userName)) signals.add("official_quote");
  const context = contextualProduct(prose);
  if (brand.test(ownText)) signals.add("brand_name");
  if (/\bhyperliquid\b/i.test(prose)) signals.add("hyperliquid_context");
  if (/\bhip[\s-]?3\b/i.test(prose)) signals.add("hip3_context");
  if (context.product) signals.add("product_context");
  if (genericTrading.test(prose)) signals.add("generic_trading_context");
  if (community.test(prose)) signals.add("community_context");
  if (scientific.test(prose) || context.technical) signals.add("science_context");
  if (/\bpyth\s+entropy\b/i.test(prose) || /(^|[^A-Za-z0-9_])@entropydotxyz(?![A-Za-z0-9_])/i.test(prose) || array(tweet.entities?.user_mentions).some((value) => plain(value) && typeof value.screen_name === "string" && value.screen_name.toLowerCase() === "entropydotxyz")) signals.add("other_project_context");
  return resultFor(signals);
}
function validatedRelevance(value) {
  if (!plain(value) || value.version !== RELEVANCE_POLICY || !["accepted", "review", "rejected"].includes(value.status) || !Array.isArray(value.reasonCodes) || !value.reasonCodes.length || value.reasonCodes.length > 4 || !Array.isArray(value.signals) || value.signals.length > RELEVANCE_SIGNALS.length || value.reasonCodes.some((code) => !RELEVANCE_REASON_CODES.includes(code)) || value.signals.some((signal) => !RELEVANCE_SIGNALS.includes(signal)) || new Set(value.reasonCodes).size !== value.reasonCodes.length || new Set(value.signals).size !== value.signals.length) return null;
  const result = resultFor(new Set(value.signals));
  if (result.status !== value.status || result.reasonCodes.length !== value.reasonCodes.length || result.reasonCodes.some((code) => !value.reasonCodes.includes(code))) return null;
  return result;
}

// source/twitterapi.mjs
var ORIGIN = "https://api.twitterapi.io";
var numericId2 = (value) => typeof value === "string" && /^[1-9]\d*$/.test(value);
var plain2 = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var TwitterApiError = class extends Error {
  constructor(code, message, status = null) {
    super(message);
    this.name = "TwitterApiError";
    this.code = code;
    this.status = status;
  }
};
function invalid(message) {
  throw new TwitterApiError("INVALID_INPUT", message);
}
function responseError(message) {
  throw new TwitterApiError("INVALID_RESPONSE", message);
}
function createClient({ apiKey, fetchImpl, timeoutMs = 3e4 } = {}) {
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/.test(apiKey)) invalid("\u041F\u043E\u0442\u0440\u0456\u0431\u0435\u043D \u0441\u0435\u0440\u0432\u0435\u0440\u043D\u0438\u0439 \u043A\u043B\u044E\u0447 twitterapi.io.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 65e3) invalid("\u0422\u0430\u0439\u043C\u0430\u0443\u0442 \u0437\u0430\u043F\u0438\u0442\u0443 \u043C\u0430\u0454 \u0431\u0443\u0442\u0438 \u0432\u0456\u0434 1 \u0434\u043E 65000 \u043C\u0441.");
  const request = fetchImpl === void 0 ? (url2, init) => globalThis.fetch(url2, init) : fetchImpl;
  if (typeof request !== "function") invalid("\u041D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0438\u0439 HTTP-\u043A\u043B\u0456\u0454\u043D\u0442.");
  const secret = apiKey.trim();
  async function get(route, params) {
    const url2 = new URL(route, ORIGIN);
    for (const [key, value] of Object.entries(params)) url2.searchParams.set(key, value);
    let response;
    try {
      response = await request(url2, {
        method: "GET",
        headers: { "x-api-key": secret, Accept: "application/json" },
        // Workers supports manual/follow only. Manual also keeps the key from
        // being forwarded to an unexpected redirect destination.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const code = ["TimeoutError", "AbortError"].includes(error?.name) ? "REQUEST_TIMEOUT" : "NETWORK_ERROR";
      throw new TwitterApiError(code, "\u0417\u0430\u043F\u0438\u0442 twitterapi.io \u043D\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0432\u0441\u044F. \u0414\u0430\u043D\u0456 \u043D\u0435 \u043E\u043D\u043E\u0432\u043B\u0435\u043D\u043E.");
    }
    if (!response || typeof response.ok !== "boolean") responseError("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0430 HTTP-\u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u044C twitterapi.io.");
    if (response.status >= 300 && response.status < 400) throw new TwitterApiError("HTTP_ERROR", "\u041F\u0435\u0440\u0435\u043D\u0430\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043D\u044F twitterapi.io \u0432\u0456\u0434\u0445\u0438\u043B\u0435\u043D\u043E.", response.status);
    if (!response.ok) {
      const status = Number.isInteger(response.status) ? response.status : null;
      const code = status === 429 ? "RATE_LIMITED" : status === 402 ? "CREDITS_EXHAUSTED" : "HTTP_ERROR";
      throw new TwitterApiError(code, "twitterapi.io \u043F\u043E\u0432\u0435\u0440\u043D\u0443\u0432 HTTP " + (status ?? "\u043F\u043E\u043C\u0438\u043B\u043A\u0443") + ". \u0410\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u0438\u0445 \u043F\u043E\u0432\u0442\u043E\u0440\u0456\u0432 \u043D\u0435\u043C\u0430\u0454.", status);
    }
    let body;
    try {
      body = await response.json();
    } catch (error) {
      if (["TimeoutError", "AbortError"].includes(error?.name)) throw new TwitterApiError("REQUEST_TIMEOUT", "\u0417\u0430\u043F\u0438\u0442 twitterapi.io \u043D\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0432\u0441\u044F. \u0414\u0430\u043D\u0456 \u043D\u0435 \u043E\u043D\u043E\u0432\u043B\u0435\u043D\u043E.");
      responseError("twitterapi.io \u043F\u043E\u0432\u0435\u0440\u043D\u0443\u0432 \u043D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 JSON.");
    }
    if (!plain2(body)) responseError("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0444\u043E\u0440\u043C\u0430\u0442 \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u0456 twitterapi.io.");
    if (body.status === "error" || body.error || body.status && body.status !== "success") {
      throw new TwitterApiError("PROVIDER_ERROR", "twitterapi.io \u043F\u043E\u0432\u0456\u0434\u043E\u043C\u0438\u0432 \u043F\u0440\u043E \u043F\u043E\u043C\u0438\u043B\u043A\u0443. \u0414\u0430\u043D\u0456 \u043D\u0435 \u043E\u043D\u043E\u0432\u043B\u0435\u043D\u043E.");
    }
    if (!Array.isArray(body.tweets)) responseError("\u0423 \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u0456 twitterapi.io \u0432\u0456\u0434\u0441\u0443\u0442\u043D\u0456\u0439 \u0441\u043F\u0438\u0441\u043E\u043A tweets.");
    return body;
  }
  return Object.freeze({
    async searchPage({ query, cursor = "" } = {}) {
      if (typeof query !== "string" || !query.trim() || [...query].length > 512) invalid("\u041F\u043E\u0448\u0443\u043A\u043E\u0432\u0438\u0439 \u0437\u0430\u043F\u0438\u0442 \u043C\u0430\u0454 \u043C\u0456\u0441\u0442\u0438\u0442\u0438 1\u2013512 \u0441\u0438\u043C\u0432\u043E\u043B\u0456\u0432.");
      if (typeof cursor !== "string" || cursor.length > 2e4) invalid("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u043A\u0443\u0440\u0441\u043E\u0440 \u043F\u043E\u0448\u0443\u043A\u0443.");
      const body = await get("/twitter/tweet/advanced_search", { query, queryType: "Latest", cursor });
      if (typeof body.has_next_page !== "boolean") responseError("\u0423 \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u0456 \u043F\u043E\u0448\u0443\u043A\u0443 \u0432\u0456\u0434\u0441\u0443\u0442\u043D\u044F \u043E\u0437\u043D\u0430\u043A\u0430 \u043D\u0430\u0441\u0442\u0443\u043F\u043D\u043E\u0457 \u0441\u0442\u043E\u0440\u0456\u043D\u043A\u0438.");
      if (body.has_next_page && (typeof body.next_cursor !== "string" || !body.next_cursor || body.next_cursor === cursor)) responseError("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u043A\u0443\u0440\u0441\u043E\u0440 \u043D\u0430\u0441\u0442\u0443\u043F\u043D\u043E\u0457 \u0441\u0442\u043E\u0440\u0456\u043D\u043A\u0438.");
      return { tweets: body.tweets, hasNextPage: body.has_next_page, nextCursor: body.has_next_page ? body.next_cursor : null };
    },
    async mentionsPage({ userName, sinceTime, untilTime, cursor = "" } = {}) {
      if (typeof userName !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(userName)) invalid("\u041F\u043E\u0442\u0440\u0456\u0431\u043D\u0435 \u0442\u043E\u0447\u043D\u0435 \u0456\u043C\u2019\u044F X-\u0430\u043A\u0430\u0443\u043D\u0442\u0430 \u0431\u0435\u0437 @.");
      if (![sinceTime, untilTime].every((value) => Number.isInteger(value) && value >= 1e8 && value <= 9999999999) || untilTime <= sinceTime) invalid("\u041F\u043E\u0442\u0440\u0456\u0431\u043D\u0456 \u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0456 \u0432\u043F\u043E\u0440\u044F\u0434\u043A\u043E\u0432\u0430\u043D\u0456 \u043C\u0435\u0436\u0456 Unix \u0443 \u0441\u0435\u043A\u0443\u043D\u0434\u0430\u0445.");
      if (typeof cursor !== "string" || cursor.length > 2e4) invalid("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u043A\u0443\u0440\u0441\u043E\u0440 \u043F\u043E\u0448\u0443\u043A\u0443.");
      const body = await get("/twitter/user/mentions", { userName, sinceTime, untilTime, cursor });
      if (typeof body.has_next_page !== "boolean") responseError("\u0423 \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u0456 \u0437\u0433\u0430\u0434\u043E\u043A \u0432\u0456\u0434\u0441\u0443\u0442\u043D\u044F \u043E\u0437\u043D\u0430\u043A\u0430 \u043D\u0430\u0441\u0442\u0443\u043F\u043D\u043E\u0457 \u0441\u0442\u043E\u0440\u0456\u043D\u043A\u0438.");
      if (body.has_next_page && (typeof body.next_cursor !== "string" || !body.next_cursor || body.next_cursor === cursor)) responseError("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u043A\u0443\u0440\u0441\u043E\u0440 \u043D\u0430\u0441\u0442\u0443\u043F\u043D\u043E\u0457 \u0441\u0442\u043E\u0440\u0456\u043D\u043A\u0438.");
      return { tweets: body.tweets, hasNextPage: body.has_next_page, nextCursor: body.has_next_page ? body.next_cursor : null };
    },
    async tweetsByIds(ids) {
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || ids.some((id) => !numericId2(id))) invalid("\u041F\u043E\u0442\u0440\u0456\u0431\u043D\u0456 1\u201350 \u0442\u043E\u0447\u043D\u0438\u0445 \u0442\u0435\u043A\u0441\u0442\u043E\u0432\u0438\u0445 X Post ID.");
      const wanted = [...new Set(ids)];
      const body = await get("/twitter/tweets", { tweet_ids: wanted.join(",") });
      const seen = /* @__PURE__ */ new Set(), tweets = [];
      let unavailableEntries = 0;
      for (const tweet of body.tweets) {
        if (plain2(tweet) && (tweet.id === "" || tweet.id === null)) {
          unavailableEntries++;
          continue;
        }
        if (!plain2(tweet) || !numericId2(tweet.id) || !wanted.includes(tweet.id) || seen.has(tweet.id)) responseError("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0430\u0431\u043E \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u0438\u0439 ID \u0443 \u0432\u0456\u0434\u043F\u043E\u0432\u0456\u0434\u0456 twitterapi.io.");
        seen.add(tweet.id);
        tweets.push(tweet);
      }
      return { tweets, missingIds: wanted.filter((id) => !seen.has(id)), unavailableEntries };
    }
  });
}
function count(value, field) {
  if (value === void 0 || value === null) return null;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u043B\u0456\u0447\u0438\u043B\u044C\u043D\u0438\u043A " + field + ".");
  return parsed;
}
function day(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0430 \u0434\u0430\u0442\u0430 " + label + ".");
  const timestamp2 = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(timestamp2) || new Date(timestamp2).toISOString().slice(0, 10) !== value) invalid("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0430 \u0434\u0430\u0442\u0430 " + label + ".");
  return value;
}
function instant(value, label) {
  if (typeof value !== "string" || !value.trim()) invalid("\u0412\u0456\u0434\u0441\u0443\u0442\u043D\u0456\u0439 \u0447\u0430\u0441 " + label + ".");
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) day(value.slice(0, 10), label);
  if (!/(?:Z|[+-]\d{2}:?\d{2}| GMT| UTC)$/i.test(value.trim()) && !/[+-]\d{4}\s\d{4}$/.test(value.trim())) invalid("\u0414\u043B\u044F \u0447\u0430\u0441\u0443 " + label + " \u043F\u043E\u0442\u0440\u0456\u0431\u0435\u043D \u0447\u0430\u0441\u043E\u0432\u0438\u0439 \u043F\u043E\u044F\u0441.");
  const timestamp2 = Date.parse(value);
  if (!Number.isFinite(timestamp2)) invalid("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0447\u0430\u0441 " + label + ".");
  return new Date(timestamp2).toISOString();
}
function isRepost(tweet) {
  return tweet.isRetweet === true || plain2(tweet.retweeted_tweet) || typeof tweet.retweeted_tweet === "string" && tweet.retweeted_tweet.length > 0;
}
function normalizeTweets(tweets, { observedAt, query = "", periodStart, periodEndExclusive } = {}) {
  if (!Array.isArray(tweets) || tweets.length > 1e5) invalid("\u041F\u043E\u0442\u0440\u0456\u0431\u0435\u043D \u043E\u0431\u043C\u0435\u0436\u0435\u043D\u0438\u0439 \u0441\u043F\u0438\u0441\u043E\u043A tweets.");
  const checkedAt = instant(observedAt, "\u0441\u043F\u043E\u0441\u0442\u0435\u0440\u0435\u0436\u0435\u043D\u043D\u044F");
  if (typeof query !== "string") invalid("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u043E\u043F\u0438\u0441 \u043F\u043E\u0448\u0443\u043A\u043E\u0432\u043E\u0433\u043E \u0437\u0430\u043F\u0438\u0442\u0443.");
  if (periodStart === void 0 !== (periodEndExclusive === void 0)) invalid("\u041F\u043E\u0442\u0440\u0456\u0431\u043D\u0456 \u043E\u0431\u0438\u0434\u0432\u0456 \u043C\u0435\u0436\u0456 \u043F\u0435\u0440\u0456\u043E\u0434\u0443.");
  if (periodStart !== void 0) {
    day(periodStart, "\u043F\u043E\u0447\u0430\u0442\u043A\u0443");
    day(periodEndExclusive, "\u043A\u0456\u043D\u0446\u044F");
    if (periodStart >= periodEndExclusive) invalid("\u041A\u0456\u043D\u0435\u0446\u044C \u043F\u0435\u0440\u0456\u043E\u0434\u0443 \u043C\u0430\u0454 \u0431\u0443\u0442\u0438 \u043F\u0456\u0437\u043D\u0456\u0448\u0435 \u043F\u043E\u0447\u0430\u0442\u043A\u0443.");
  }
  const authors = /* @__PURE__ */ new Map(), posts = /* @__PURE__ */ new Map();
  const diagnostics = { inputRows: tweets.length, excludedReposts: 0, duplicates: 0, outsidePeriod: 0 };
  for (let index = 0; index < tweets.length; index++) {
    const tweet = tweets[index];
    if (!plain2(tweet)) invalid("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0437\u0430\u043F\u0438\u0441 tweets \u0437\u0430 \u0456\u043D\u0434\u0435\u043A\u0441\u043E\u043C " + index + ".");
    if (isRepost(tweet)) {
      diagnostics.excludedReposts++;
      continue;
    }
    if (!numericId2(tweet.id)) invalid("\u0423 tweets \u0437\u0430 \u0456\u043D\u0434\u0435\u043A\u0441\u043E\u043C " + index + " \u043F\u043E\u0442\u0440\u0456\u0431\u0435\u043D \u0442\u043E\u0447\u043D\u0438\u0439 \u0442\u0435\u043A\u0441\u0442\u043E\u0432\u0438\u0439 ID.");
    const author = tweet.author;
    if (!plain2(author) || !numericId2(author.id) || typeof author.userName !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(author.userName)) invalid("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0430\u0432\u0442\u043E\u0440 \u0443 tweets \u0437\u0430 \u0456\u043D\u0434\u0435\u043A\u0441\u043E\u043C " + index + ".");
    const publishedAt = instant(tweet.createdAt, "\u043F\u0443\u0431\u043B\u0456\u043A\u0430\u0446\u0456\u0457");
    const date = publishedAt.slice(0, 10);
    if (periodStart !== void 0 && (date < periodStart || date >= periodEndExclusive)) {
      diagnostics.outsidePeriod++;
      continue;
    }
    if (posts.has(tweet.id)) {
      const old = posts.get(tweet.id);
      if (old.authorId !== author.id || old.publishedAt !== publishedAt) invalid("\u0421\u0443\u043F\u0435\u0440\u0435\u0447\u043B\u0438\u0432\u0456 \u0434\u0443\u0431\u043B\u0456\u043A\u0430\u0442\u0438 X Post ID.");
      diagnostics.duplicates++;
      continue;
    }
    if (tweet.text !== void 0 && tweet.text !== null && typeof tweet.text !== "string") invalid("\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0442\u0435\u043A\u0441\u0442 \u043F\u043E\u0441\u0442\u0430.");
    const previousAuthor = authors.get(author.id);
    if (previousAuthor && previousAuthor.handle.toLowerCase() !== author.userName.toLowerCase()) invalid("\u0421\u0443\u043F\u0435\u0440\u0435\u0447\u043B\u0438\u0432\u0456 \u0456\u043C\u0435\u043D\u0430 \u043E\u0434\u043D\u043E\u0433\u043E \u0430\u0432\u0442\u043E\u0440\u0430 \u0443 \u0437\u043D\u0456\u043C\u043A\u0443.");
    const followers = count(author.followers, "followers");
    authors.set(author.id, {
      id: author.id,
      handle: author.userName,
      displayName: typeof author.name === "string" ? author.name : author.userName,
      followers: followers ?? previousAuthor?.followers ?? null,
      smartFollowersComplete: false,
      smartEngagementComplete: false
    });
    posts.set(tweet.id, {
      id: tweet.id,
      authorId: author.id,
      authorHandle: author.userName,
      date,
      publishedAt,
      url: "https://x.com/" + author.userName + "/status/" + tweet.id,
      summary: "",
      body: typeof tweet.text === "string" ? tweet.text : null,
      metrics: {
        impressions: count(tweet.viewCount, "viewCount"),
        likes: count(tweet.likeCount, "likeCount"),
        reposts: count(tweet.retweetCount, "retweetCount"),
        uiReposts: null,
        quotes: count(tweet.quoteCount, "quoteCount"),
        replies: count(tweet.replyCount, "replyCount"),
        bookmarks: count(tweet.bookmarkCount, "bookmarkCount")
      },
      metricsAsOf: checkedAt,
      metricsWindow: "cumulative",
      source: "twitterapi.io",
      // conversationId is retained as evidence, never used to group other authors' work.
      conversationId: numericId2(tweet.conversationId) ? tweet.conversationId : null,
      inReplyToId: numericId2(tweet.inReplyToId) ? tweet.inReplyToId : null,
      isReply: typeof tweet.isReply === "boolean" ? tweet.isReply : null,
      isQuote: !!tweet.quoted_tweet,
      relevance: classifyTweet(tweet)
    });
  }
  const dates = [...posts.values()].map((post) => post.date).sort();
  const derivedStart = dates[0] || checkedAt.slice(0, 10);
  const derivedEnd = new Date(Date.parse((dates.at(-1) || checkedAt.slice(0, 10)) + "T00:00:00Z") + 864e5).toISOString().slice(0, 10);
  return {
    meta: {
      source: "twitterapi.io",
      asOf: checkedAt,
      coverage: "partial",
      query,
      periodStart: periodStart ?? derivedStart,
      periodEndExclusive: periodEndExclusive ?? derivedEnd,
      sourceNote: "\u041B\u0456\u0447\u0438\u043B\u044C\u043D\u0438\u043A\u0438 twitterapi.io \u043D\u0430 \u0447\u0430\u0441 \u0441\u043F\u043E\u0441\u0442\u0435\u0440\u0435\u0436\u0435\u043D\u043D\u044F; \u0437\u043D\u0456\u043C\u043E\u043A \u0456\u0437 \u0440\u0443\u0447\u043D\u043E\u0433\u043E \u0437\u0431\u043E\u0440\u0443, \u0431\u0435\u0437 \u0444\u043E\u043D\u043E\u0432\u043E\u0433\u043E \u043E\u043D\u043E\u0432\u043B\u0435\u043D\u043D\u044F.",
      limitations: [
        "viewCount \u2014 \u043D\u0430\u043A\u043E\u043F\u0438\u0447\u0435\u043D\u0456 \u043F\u0435\u0440\u0435\u0433\u043B\u044F\u0434\u0438 \u043F\u043E\u0441\u0442\u0430, \u043D\u0435 \u0443\u043D\u0456\u043A\u0430\u043B\u044C\u043D\u0456 \u043B\u044E\u0434\u0438 \u0439 \u043D\u0435 \u043F\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043D\u0456 \u043E\u0440\u0433\u0430\u043D\u0456\u0447\u043D\u0456 \u043F\u043E\u043A\u0430\u0437\u0438.",
        "\u041F\u043E\u0448\u0443\u043A \u043D\u0435 \u0433\u0430\u0440\u0430\u043D\u0442\u0443\u0454 \u043F\u043E\u0432\u043D\u043E\u0433\u043E \u043E\u0445\u043E\u043F\u043B\u0435\u043D\u043D\u044F \u0432\u0441\u0456\u0445 \u043F\u0443\u0431\u043B\u0456\u043A\u0430\u0446\u0456\u0439; \u0437\u043D\u0456\u043C\u043E\u043A \u0437\u0430\u043B\u0438\u0448\u0430\u0454\u0442\u044C\u0441\u044F \u0447\u0430\u0441\u0442\u043A\u043E\u0432\u0438\u043C.",
        "Smart-\u0434\u0430\u043D\u0456 \u0442\u0430 \u043E\u0446\u0456\u043D\u043A\u0438 \u0434\u043E\u0432\u0456\u0440\u0438 \u043D\u0435 \u043E\u0442\u0440\u0438\u043C\u0430\u043D\u0456; \u0432\u0435\u0440\u0438\u0444\u0456\u043A\u0430\u0446\u0456\u044F \u0430\u043A\u0430\u0443\u043D\u0442\u0430 \u043D\u0435 \u043F\u0456\u0434\u0441\u0442\u0430\u0432\u043B\u044F\u0454\u0442\u044C\u0441\u044F \u044F\u043A \u0434\u043E\u0432\u0456\u0440\u0430.",
        "\u0427\u0430\u0441\u0442\u0438\u043D\u0438 \u0442\u0440\u0435\u0434\u0456\u0432 \u043F\u043E\u0442\u0440\u0435\u0431\u0443\u044E\u0442\u044C \u043F\u0435\u0440\u0435\u0432\u0456\u0440\u043A\u0438 \u0433\u0440\u0443\u043F\u0443\u0432\u0430\u043D\u043D\u044F; conversationId \u043D\u0435 \u0454 workId."
      ],
      diagnostics
    },
    authors: [...authors.values()],
    posts: [...posts.values()],
    accounts: [],
    followRelations: [],
    interactions: []
  };
}

// source/live-engine.mjs
var import_model = __toESM(require_model(), 1);
var TARGET = "entropyIO";
var DAY = 864e5;
var INTERVAL = 3e5;
var METRICS = ["impressions", "likes", "reposts", "uiReposts", "quotes", "replies", "bookmarks"];
var copy = (value) => JSON.parse(JSON.stringify(value));
var numericId3 = (value) => typeof value === "string" && /^[1-9]\d*$/.test(value);
var known = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
var timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
var DISCOVERY_QUERY_POLICY = "entropy-context-v1";
var DISCOVERY_LANES = Object.freeze(["direct", "evidence", "context"]);
function discoveryTerms(lane = "direct", policy = DISCOVERY_QUERY_POLICY) {
  if (!DISCOVERY_LANES.includes(lane)) throw new Error("Invalid discovery lane.");
  if (policy !== DISCOVERY_QUERY_POLICY || lane === "direct") return "@" + TARGET;
  return lane === "evidence" ? '(url:entropy.io OR "entropy.io" OR url:x.com/entropyIO OR url:twitter.com/entropyIO)' : "Entropy";
}
function discoveryQuery(start, endExclusive, policy = DISCOVERY_QUERY_POLICY, lane = "direct") {
  const filters = [DISCOVERY_QUERY_POLICY, "original-tweets-v1"].includes(policy) ? " -filter:replies -filter:nativeretweets" : "";
  return discoveryTerms(lane, policy) + filters + " since_time:" + Math.floor(Date.parse(start) / 1e3) + " until_time:" + Math.floor(Date.parse(endExclusive) / 1e3);
}
function mergedRelevance(previous, incoming, body) {
  const before = validatedRelevance(previous), after = validatedRelevance(incoming);
  if (before?.status === "accepted" && after?.status !== "accepted") return before;
  if (before?.status === "review" && (!after || after.status === "rejected")) return before;
  if ((!body || !body.trim()) && after?.status === "rejected") return before;
  return after || before;
}
function mergeDefined(oldValue, newValue) {
  const result = { ...oldValue || {} };
  for (const [key, value] of Object.entries(newValue || {})) if (value !== null && value !== void 0) result[key] = value;
  return result;
}
function observation(post, field, fallback) {
  return timestamp(post.metricsObservedAt?.[field]) || timestamp(post.metricsAsOf) || timestamp(fallback);
}
function mergePost(previous, incoming, oldAsOf, newAsOf) {
  if (!previous) {
    const metricsObservedAt2 = {};
    for (const key of METRICS) if (known(incoming.metrics[key])) metricsObservedAt2[key] = observation(incoming, key, newAsOf);
    return { ...incoming, metricsObservedAt: metricsObservedAt2, lastCheckedAt: timestamp(newAsOf), availability: { status: "available", lastSeenAt: timestamp(newAsOf) } };
  }
  if (previous.authorId !== incoming.authorId) throw new Error("Post ownership conflict.");
  if (previous.publishedAt && incoming.publishedAt && Date.parse(previous.publishedAt) !== Date.parse(incoming.publishedAt)) throw new Error("Post publication time conflict.");
  const metrics = {}, metricsObservedAt = {}, corrections = [...previous.metricCorrections || []];
  const missingInLatest = [];
  for (const key of METRICS) {
    const before = previous.metrics[key], after = incoming.metrics[key];
    const beforeAt = observation(previous, key, oldAsOf), afterAt = observation(incoming, key, newAsOf);
    const isNewer = !beforeAt || !afterAt || Date.parse(afterAt) >= Date.parse(beforeAt);
    if (known(after) && isNewer) {
      metrics[key] = after;
      metricsObservedAt[key] = afterAt;
      if (known(before) && after < before) corrections.push({ field: key, previous: before, current: after, observedAt: afterAt });
    } else {
      metrics[key] = before ?? null;
      metricsObservedAt[key] = known(before) ? beforeAt : null;
      if (!known(after)) missingInLatest.push(key);
    }
  }
  const times = Object.values(metricsObservedAt).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    ...mergeDefined(previous, incoming),
    authorId: incoming.authorId,
    relevance: mergedRelevance(previous.relevance, incoming.relevance, incoming.body),
    discoveryLanes: [.../* @__PURE__ */ new Set([...previous.discoveryLanes || [], ...incoming.discoveryLanes || []])].filter((lane) => DISCOVERY_LANES.includes(lane)),
    // A partial provider observation cannot erase positive reply evidence.
    isReply: previous.isReply === true || incoming.isReply === true ? true : incoming.isReply ?? previous.isReply ?? null,
    inReplyToId: previous.inReplyToId || incoming.inReplyToId || null,
    isRepost: import_model.default.postEligibility({ ...previous, isReply: false, inReplyToId: null }).reason === "repost" || import_model.default.postEligibility({ ...incoming, isReply: false, inReplyToId: null }).reason === "repost" ? true : incoming.isRepost ?? previous.isRepost ?? null,
    workId: previous.workId || incoming.workId || null,
    metrics,
    metricsObservedAt,
    // The oldest field timestamp prevents a partial refresh from relabelling old counts as fresh.
    metricsAsOf: times[0] || null,
    lastCheckedAt: timestamp(newAsOf),
    missingInLatest,
    metricCorrections: corrections.slice(-20),
    availability: { status: "available", lastSeenAt: timestamp(newAsOf) }
  };
}
function mergeDataset(previousRaw, incomingRaw) {
  const previous = import_model.default.validateDataset(previousRaw), incoming = import_model.default.validateDataset(incomingRaw);
  const oldPosts = new Map(previous.posts.map((p) => [p.id, p]));
  const aliases = /* @__PURE__ */ new Map(), targets = /* @__PURE__ */ new Map();
  for (const post of incoming.posts) {
    const old = oldPosts.get(post.id);
    if (!old || old.authorId === post.authorId) continue;
    if (!old.authorId.startsWith("sample:") || !numericId3(post.authorId)) throw new Error("Post ownership conflict.");
    if (aliases.has(old.authorId) && aliases.get(old.authorId) !== post.authorId) throw new Error("Ambiguous sample identity.");
    if (targets.has(post.authorId) && targets.get(post.authorId) !== old.authorId) throw new Error("Merged sample identities.");
    if (previous.authors.some((a) => a.id === post.authorId)) throw new Error("Target identity already exists.");
    aliases.set(old.authorId, post.authorId);
    targets.set(post.authorId, old.authorId);
  }
  const remap = (id) => aliases.get(id) || id;
  const authors = new Map(previous.authors.map((a) => [remap(a.id), { ...a, id: remap(a.id) }]));
  for (const author of incoming.authors) {
    const old = authors.get(author.id);
    const merged = mergeDefined(old, author);
    if (old && incoming.meta.source === "twitterapi.io") {
      merged.smartFollowersComplete = old.smartFollowersComplete;
      merged.smartEngagementComplete = old.smartEngagementComplete;
    }
    authors.set(author.id, merged);
  }
  const posts = new Map(previous.posts.map((p) => [p.id, { ...p, authorId: remap(p.authorId) }]));
  for (const post of incoming.posts) posts.set(post.id, mergePost(posts.get(post.id), post, previous.meta.asOf, incoming.meta.asOf));
  const accounts = new Map(previous.accounts.map((a) => [remap(a.id), { ...a, id: remap(a.id) }]));
  for (const account of incoming.accounts) {
    const id = remap(account.id), old = accounts.get(id);
    accounts.set(id, old?.trust !== null && old?.trust !== void 0 ? { ...account, ...old } : mergeDefined(old, { ...account, id }));
  }
  const relations = /* @__PURE__ */ new Map();
  for (const value of [...previous.followRelations, ...incoming.followRelations]) {
    const record = { ...value, authorId: remap(value.authorId), accountId: remap(value.accountId) };
    relations.set(record.authorId + "|" + record.accountId, mergeDefined(relations.get(record.authorId + "|" + record.accountId), record));
  }
  const interactions = /* @__PURE__ */ new Map();
  for (const value of [...previous.interactions, ...incoming.interactions]) {
    const record = { ...value, authorId: remap(value.authorId), accountId: remap(value.accountId) };
    const key = record.id || [record.authorId, record.accountId, record.postId, record.type, record.occurredAt].join("|");
    interactions.set(key, mergeDefined(interactions.get(key), record));
  }
  const starts = [previous.meta.periodStart, incoming.meta.periodStart].filter(Boolean).sort();
  const ends = [previous.meta.periodEndExclusive, incoming.meta.periodEndExclusive].filter(Boolean).sort();
  return import_model.default.validateDataset({
    meta: {
      ...previous.meta,
      ...incoming.meta,
      coverage: "partial",
      periodStart: starts[0],
      periodEndExclusive: ends.at(-1),
      metricsAreMixedAge: true,
      sourceNote: "Incremental twitterapi.io observations. Counts are cumulative, of mixed age, and not verified organic reach.",
      limitations: [.../* @__PURE__ */ new Set([...previous.meta.limitations || [], ...incoming.meta.limitations || []])]
    },
    authors: [...authors.values()],
    posts: [...posts.values()],
    accounts: [...accounts.values()],
    followRelations: [...relations.values()],
    interactions: [...interactions.values()]
  });
}
function instant2(input) {
  const value = typeof input === "function" ? input() : input ?? /* @__PURE__ */ new Date();
  const time2 = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(time2)) throw new Error("Invalid sync time.");
  return time2;
}
function windowsBetween(start, end) {
  const windows = [];
  const chunkEnd = Math.min(end, start + 32 * DAY);
  for (let current = start; current < chunkEnd; ) {
    const nextMidnight = Date.parse(new Date(current).toISOString().slice(0, 10) + "T00:00:00Z") + DAY;
    const until = Math.min(nextMidnight, chunkEnd);
    windows.push({ start: new Date(current).toISOString(), endExclusive: new Date(until).toISOString(), cursor: "", previousOldest: null, seenCursors: [] });
    current = until;
  }
  return windows;
}
function initialSync(raw, nowMs) {
  const sync = copy(raw || {});
  sync.version = 1;
  sync.source = "twitterapi.io";
  sync.target = TARGET;
  sync.enabled = sync.enabled === true;
  sync.paused = sync.paused === true;
  sync.intervalMs = Number.isInteger(sync.intervalMs) && sync.intervalMs >= INTERVAL ? sync.intervalMs : INTERVAL;
  sync.requestCount = Number.isInteger(sync.requestCount) && sync.requestCount >= 0 ? sync.requestCount : 0;
  sync.consecutiveFailures = Number.isInteger(sync.consecutiveFailures) && sync.consecutiveFailures >= 0 ? sync.consecutiveFailures : 0;
  sync.phase = sync.phase === "refresh" ? "refresh" : "discovery";
  sync.gaps = Array.isArray(sync.gaps) ? sync.gaps.slice(-50) : [];
  sync.discovery ||= { pendingWindows: [], coveredThrough: null };
  sync.discovery.pendingWindows = Array.isArray(sync.discovery.pendingWindows) ? sync.discovery.pendingWindows : [];
  sync.discovery.recentWindow ||= null;
  sync.discovery.recentFrom = timestamp(sync.discovery.recentFrom);
  sync.discovery.recentThrough = timestamp(sync.discovery.recentThrough);
  sync.discovery.nextLane = ["recent", "backfill"].includes(sync.discovery.nextLane) ? sync.discovery.nextLane : sync.discovery.pendingWindows[0]?.cursor ? "backfill" : "recent";
  sync.refresh ||= { pendingIds: [], cycleStartedAt: null };
  sync.refresh.pendingIds = Array.isArray(sync.refresh.pendingIds) ? sync.refresh.pendingIds.filter(numericId3) : [];
  sync.lastAttemptAt ||= null;
  sync.lastSuccessAt ||= null;
  sync.lastDataAt ||= null;
  sync.lastError ||= null;
  sync.nextRunAt ||= new Date(nowMs).toISOString();
  return sync;
}
function addGap(sync, gap) {
  sync.gaps = [...sync.gaps, gap].slice(-50);
}
function promoteRecentCoverage(discovery) {
  const covered = timestamp(discovery.coveredThrough);
  if (covered && discovery.recentFrom && discovery.recentThrough && Date.parse(discovery.recentFrom) <= Date.parse(covered) && Date.parse(discovery.recentThrough) > Date.parse(covered)) {
    discovery.coveredThrough = discovery.recentThrough;
  }
}
function prepareDiscovery(sync, nowMs, nowIso) {
  const discovery = sync.discovery;
  const checkpoint = timestamp(discovery.coveredThrough);
  if (!discovery.pendingWindows.length && (!checkpoint || nowMs - Date.parse(checkpoint) > DAY)) {
    const monthStart = Date.parse(nowIso.slice(0, 7) + "-01T00:00:00Z");
    const from = checkpoint ? Math.min(nowMs, Date.parse(checkpoint) - INTERVAL) : monthStart;
    discovery.pendingWindows = windowsBetween(from, nowMs);
  }
  if (!discovery.recentWindow) {
    const recent = timestamp(discovery.recentThrough);
    const nearCheckpoint = checkpoint && nowMs - Date.parse(checkpoint) <= DAY ? checkpoint : null;
    const from = recent || nearCheckpoint;
    const monthStart = Date.parse(nowIso.slice(0, 7) + "-01T00:00:00Z");
    const since = from ? Math.min(nowMs, Date.parse(from) - INTERVAL) : Math.max(monthStart, nowMs - 6 * INTERVAL);
    if (since < nowMs) discovery.recentWindow = {
      start: new Date(since).toISOString(),
      endExclusive: nowIso,
      cursor: "",
      previousOldest: null,
      seenCursors: []
    };
  }
  return discovery.nextLane === "backfill" && discovery.pendingWindows.length ? "backfill" : discovery.recentWindow ? "recent" : discovery.pendingWindows.length ? "backfill" : null;
}
function directlyMentioned(tweet) {
  return /(^|[^A-Za-z0-9_])@entropyIO(?![A-Za-z0-9_])/i.test(typeof tweet.text === "string" ? tweet.text : "") || Array.isArray(tweet.entities?.user_mentions) && tweet.entities.user_mentions.some((m) => typeof m?.screen_name === "string" && m.screen_name.toLowerCase() === TARGET.toLowerCase());
}
function formatEligible(post) {
  return !["reply", "repost"].includes(import_model.default.postEligibility(post).reason);
}
function matchesDiscoveryLane(post, lane = "direct") {
  if (!DISCOVERY_LANES.includes(lane)) return false;
  if (Array.isArray(post.discoveryLanes) && post.discoveryLanes.includes(lane)) return true;
  if (lane === "direct") return directlyMentioned({ text: post.body }) || validatedRelevance(post.relevance)?.signals.includes("direct_mention") === true;
  const relevance = validatedRelevance(post.relevance);
  if (lane === "evidence") return relevance?.signals.some((value) => ["official_domain", "official_post_link"].includes(value)) === true;
  return /\bentropy\b/i.test(post.body || "");
}
function normalizedPage(tweets, nowIso, window2 = null) {
  const data = normalizeTweets(tweets, { observedAt: nowIso, query: window2?.query || "@" + TARGET });
  if (window2) {
    const from = Date.parse(window2.start), until = Date.parse(window2.endExclusive);
    data.posts = data.posts.filter((p) => formatEligible(p) && ["accepted", "review"].includes(p.relevance?.status) && p.authorHandle.toLowerCase() !== TARGET.toLowerCase() && Date.parse(p.publishedAt) >= from && Date.parse(p.publishedAt) < until).map((post) => ({ ...post, discoveryLanes: [window2.discoveryLane || "direct"] }));
    const authors = new Set(data.posts.map((p) => p.authorId));
    data.authors = data.authors.filter((a) => authors.has(a.id));
    data.meta.periodStart = window2.start.slice(0, 10);
    data.meta.periodEndExclusive = new Date(Math.ceil(until / DAY) * DAY).toISOString().slice(0, 10);
  }
  return data;
}
function normalizeDiscoveryPage(tweets, observedAt, window2 = null) {
  const data = normalizedPage(tweets, observedAt, window2);
  data.posts = data.posts.filter((post) => formatEligible(post) && ["accepted", "review"].includes(post.relevance?.status) && post.authorHandle.toLowerCase() !== TARGET.toLowerCase());
  const authors = new Set(data.posts.map((post) => post.authorId));
  data.authors = data.authors.filter((author) => authors.has(author.id));
  return data;
}
function classifySyncError(error) {
  if (["TimeoutError", "AbortError"].includes(error?.name)) return { diagnosticCode: "REQUEST_TIMEOUT" };
  const message = typeof error?.message === "string" ? error.message : "";
  const exact = {
    "Post ownership conflict.": "POST_OWNERSHIP_CONFLICT",
    "Post publication time conflict.": "PUBLICATION_TIME_CONFLICT",
    "Ambiguous sample identity.": "SAMPLE_IDENTITY_CONFLICT",
    "Merged sample identities.": "SAMPLE_IDENTITY_CONFLICT",
    "Target identity already exists.": "SAMPLE_IDENTITY_CONFLICT",
    "\u0421\u0443\u043F\u0435\u0440\u0435\u0447\u043B\u0438\u0432\u0456 \u0434\u0443\u0431\u043B\u0456\u043A\u0430\u0442\u0438 X Post ID.": "DUPLICATE_POST",
    "\u0421\u0443\u043F\u0435\u0440\u0435\u0447\u043B\u0438\u0432\u0456 \u0456\u043C\u0435\u043D\u0430 \u043E\u0434\u043D\u043E\u0433\u043E \u0430\u0432\u0442\u043E\u0440\u0430 \u0443 \u0437\u043D\u0456\u043C\u043A\u0443.": "AUTHOR_HANDLE_CONFLICT",
    "\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u0442\u0435\u043A\u0441\u0442 \u043F\u043E\u0441\u0442\u0430.": "INVALID_TWEET_TEXT",
    "Invalid checkpoint.": "INVALID_CHECKPOINT",
    "Invalid discovery response.": "INVALID_DISCOVERY_RESPONSE",
    "Invalid metrics response.": "INVALID_METRICS_RESPONSE",
    "Unrequested post in refresh.": "UNREQUESTED_POST"
  };
  if (Object.hasOwn(exact, message)) return { diagnosticCode: exact[message] };
  for (const field of ["viewCount", "likeCount", "retweetCount", "quoteCount", "replyCount", "bookmarkCount", "followers"]) {
    if (message === "\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u043B\u0456\u0447\u0438\u043B\u044C\u043D\u0438\u043A " + field + ".") return { diagnosticCode: "INVALID_COUNT", diagnosticField: field };
  }
  if (/^У tweets за індексом \d+ потрібен точний текстовий ID\.$/u.test(message)) return { diagnosticCode: "INVALID_TWEET_ID" };
  if (/^Некоректний автор у tweets за індексом \d+\.$/u.test(message)) return { diagnosticCode: "INVALID_AUTHOR" };
  if (/^Для часу (публікації|спостереження) потрібен часовий пояс\.$/u.test(message)) return { diagnosticCode: "MISSING_TIMEZONE" };
  if (/^(Відсутній час|Некоректний час|Некоректна дата) (публікації|спостереження)\.$/u.test(message)) return { diagnosticCode: "INVALID_TIMESTAMP" };
  if (message.startsWith("\u0406\u043C\u043F\u043E\u0440\u0442 \u0437\u0443\u043F\u0438\u043D\u0435\u043D\u043E: \u043A\u043E\u043D\u0444\u043B\u0456\u043A\u0442 \u0456\u0434\u0435\u043D\u0442\u0438\u0447\u043D\u043E\u0441\u0442\u0456 \u0430\u0432\u0442\u043E\u0440\u0430.") || /^Імпорт зупинено: для @/.test(message)) return { diagnosticCode: "MODEL_IDENTITY_CONFLICT" };
  for (const code of ["NETWORK_ERROR", "REQUEST_TIMEOUT", "INVALID_RESPONSE", "PROVIDER_ERROR", "INVALID_INPUT", "HTTP_ERROR", "RATE_LIMITED", "CREDITS_EXHAUSTED"]) {
    if (error?.code === code) return { diagnosticCode: code };
  }
  if (Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) return { diagnosticCode: "HTTP_ERROR" };
  return { diagnosticCode: "UNCLASSIFIED_ERROR" };
}
function recordError(sync, error, nowMs) {
  const at = new Date(nowMs).toISOString();
  const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null;
  const code = [401, 403].includes(status) ? "AUTH_REQUIRED" : status === 402 ? "CREDITS_EXHAUSTED" : status === 429 ? "RATE_LIMITED" : "SYNC_FAILED";
  sync.consecutiveFailures++;
  sync.lastError = {
    code,
    message: code === "AUTH_REQUIRED" ? "The provider key needs attention." : code === "CREDITS_EXHAUSTED" ? "Provider credits are exhausted." : code === "RATE_LIMITED" ? "Provider rate limit reached; a later retry is scheduled." : "Sync did not complete. Existing data was retained.",
    at,
    httpStatus: status,
    ...classifySyncError(error)
  };
  sync.status = "error";
  const delay = Math.max(sync.intervalMs, Math.min(36e5, 6e4 * 2 ** Math.min(sync.consecutiveFailures - 1, 6)));
  sync.nextRunAt = new Date(nowMs + delay).toISOString();
  if ([401, 402, 403].includes(status)) {
    sync.paused = true;
    sync.status = "paused";
  }
  addGap(sync, { code, at });
}
async function advanceSync(workbench, { client, now, maxRequests = 1 } = {}) {
  let dataset = import_model.default.validateDataset(copy(workbench.dataset));
  let state = import_model.default.validateState(copy(workbench.state || import_model.default.initialState()));
  const nowMs = instant2(now), nowIso = new Date(nowMs).toISOString();
  const sync = initialSync(workbench.sync, nowMs);
  const result = () => ({ dataset, state, sync });
  if (!Number.isInteger(maxRequests) || maxRequests < 0) throw new Error("Invalid request limit.");
  if (!sync.enabled) {
    sync.status = "disabled";
    return result();
  }
  if (sync.paused || maxRequests === 0) return result();
  if (Date.parse(sync.nextRunAt) > nowMs) return result();
  if (!client || typeof client.searchPage !== "function" || typeof client.tweetsByIds !== "function") throw new Error("A read-only provider client is required.");
  const discoveryLane = prepareDiscovery(sync, nowMs, nowIso);
  const eligible = dataset.posts.filter((p) => numericId3(p.id) && (import_model.default.countablePost ? import_model.default.countablePost(p, state).eligible : import_model.default.postEligibility(p).eligible && p.relevance?.status !== "review"));
  const eligibleIds = new Set(eligible.map((p) => p.id));
  sync.refresh.pendingIds = sync.refresh.pendingIds.filter((id) => eligibleIds.has(id));
  if (sync.requestCount === 0 && eligible.some((p) => p.authorId.startsWith("sample:"))) sync.phase = "refresh";
  if (sync.phase === "refresh" && !sync.refresh.pendingIds.length) {
    sync.refresh.pendingIds = [...eligible].sort((a, b) => (Date.parse(a.lastCheckedAt || a.metricsAsOf) || 0) - (Date.parse(b.lastCheckedAt || b.metricsAsOf) || 0)).map((p) => p.id);
    sync.refresh.cycleStartedAt = nowIso;
  }
  if (sync.phase === "refresh" && !sync.refresh.pendingIds.length) sync.phase = "discovery";
  if (sync.phase === "discovery" && !discoveryLane) {
    sync.nextRunAt = new Date(nowMs + sync.intervalMs).toISOString();
    sync.status = "waiting";
    return result();
  }
  sync.lastAttemptAt = nowIso;
  sync.requestCount++;
  const attemptedPhase = sync.phase;
  try {
    if (sync.phase === "discovery") {
      const window2 = copy(discoveryLane === "recent" ? sync.discovery.recentWindow : sync.discovery.pendingWindows[0]);
      const saveWindow = (value) => {
        if (discoveryLane === "recent") sync.discovery.recentWindow = value;
        else sync.discovery.pendingWindows[0] = value;
      };
      if (!timestamp(window2.start) || !timestamp(window2.endExclusive) || Date.parse(window2.start) >= Date.parse(window2.endExclusive) || typeof window2.cursor !== "string") throw new Error("Invalid checkpoint.");
      const query = "@" + TARGET + " since_time:" + Math.floor(Date.parse(window2.start) / 1e3) + " until_time:" + Math.floor(Date.parse(window2.endExclusive) / 1e3);
      const page = await client.searchPage({ query, cursor: window2.cursor });
      if (!page || !Array.isArray(page.tweets) || typeof page.hasNextPage !== "boolean") throw new Error("Invalid discovery response.");
      const incoming = normalizedPage(page.tweets, nowIso, window2);
      const merged = mergeDataset(dataset, incoming), migrated = import_model.default.reconcileImport(dataset, merged, state);
      const times = page.tweets.map((t) => Date.parse(t.createdAt)).filter(Number.isFinite);
      const repeated = page.hasNextPage && (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor === window2.cursor || (window2.seenCursors || []).includes(page.nextCursor));
      const jumped = window2.previousOldest !== null && times.length && Math.max(...times) > window2.previousOldest;
      const stalled = page.hasNextPage && !page.tweets.length;
      dataset = merged;
      state = migrated;
      if (incoming.posts.length) sync.lastDataAt = nowIso;
      if (repeated || jumped || stalled) {
        addGap(sync, { code: repeated ? "CURSOR_CYCLE" : jumped ? "PAGINATION_ORDER" : "EMPTY_CONTINUATION", at: nowIso, windowStart: window2.start, windowEndExclusive: window2.endExclusive });
        window2.cursor = "";
        window2.previousOldest = null;
        window2.seenCursors = [];
        saveWindow(window2);
      } else if (page.hasNextPage) {
        window2.cursor = page.nextCursor;
        window2.previousOldest = times.length ? Math.min(...times) : window2.previousOldest;
        window2.seenCursors = [...window2.seenCursors || [], page.nextCursor].slice(-1e3);
        saveWindow(window2);
      } else {
        if (discoveryLane === "recent") {
          const recentThrough = timestamp(sync.discovery.recentThrough);
          if (!recentThrough || Date.parse(window2.start) > Date.parse(recentThrough)) sync.discovery.recentFrom = window2.start;
          sync.discovery.recentThrough = !recentThrough || Date.parse(window2.endExclusive) > Date.parse(recentThrough) ? window2.endExclusive : recentThrough;
          sync.discovery.recentWindow = null;
        } else {
          sync.discovery.pendingWindows.shift();
          const covered = timestamp(sync.discovery.coveredThrough);
          sync.discovery.coveredThrough = !covered || Date.parse(window2.endExclusive) > Date.parse(covered) ? window2.endExclusive : covered;
        }
        promoteRecentCoverage(sync.discovery);
      }
      sync.discovery.nextLane = discoveryLane === "recent" ? "backfill" : "recent";
      sync.phase = dataset.posts.length ? "refresh" : "discovery";
    } else {
      const batch = [...new Set(sync.refresh.pendingIds)].slice(0, 20);
      const page = await client.tweetsByIds(batch);
      if (!page || !Array.isArray(page.tweets)) throw new Error("Invalid metrics response.");
      const incoming = normalizedPage(page.tweets, nowIso);
      if (incoming.posts.some((p) => !batch.includes(p.id))) throw new Error("Unrequested post in refresh.");
      const seen = new Set(incoming.posts.map((p) => p.id)), missing = batch.filter((id) => !seen.has(id));
      const merged = mergeDataset(dataset, incoming), migrated = import_model.default.reconcileImport(dataset, merged, state);
      for (const post of merged.posts) if (missing.includes(post.id)) {
        post.lastCheckedAt = nowIso;
        post.availability = { status: "unavailable", lastAttemptAt: nowIso, lastSeenAt: post.availability?.lastSeenAt || post.metricsAsOf || null };
      }
      if (missing.length) addGap(sync, { code: "POSTS_UNAVAILABLE", at: nowIso, postIds: missing });
      dataset = merged;
      state = migrated;
      if (incoming.posts.length) sync.lastDataAt = nowIso;
      sync.refresh.pendingIds = sync.refresh.pendingIds.filter((id) => !batch.includes(id));
      sync.phase = "discovery";
    }
    sync.lastSuccessAt = nowIso;
    sync.consecutiveFailures = 0;
    sync.lastError = null;
    sync.nextRunAt = new Date(nowMs + sync.intervalMs).toISOString();
    sync.status = "running";
  } catch (error) {
    recordError(sync, error, nowMs);
    if (attemptedPhase === "refresh" && !sync.paused) {
      sync.phase = "discovery";
      sync.discovery.nextLane = "recent";
    }
  }
  return result();
}
var HOUR = 36e5;
var CATCHUP_SPACING = 5100;
var HOURLY_MIN_WINDOW = 3e5;
function hourlyWindow(start, endExclusive, kind = "latest", method = "search", discoveryLane = "direct") {
  const from = new Date(start).toISOString(), until = new Date(endExclusive).toISOString();
  return {
    id: "hourly:" + DISCOVERY_QUERY_POLICY + ":" + discoveryLane + ":" + method + ":" + from + ":" + until,
    method,
    discoveryLane,
    queryPolicy: DISCOVERY_QUERY_POLICY,
    query: discoveryQuery(from, until, DISCOVERY_QUERY_POLICY, discoveryLane),
    start: from,
    endExclusive: until,
    kind,
    cursor: "",
    previousOldest: null,
    seenCursors: [],
    observedPostIds: []
  };
}
function emptyLane() {
  return { latestPlannedThrough: null, completedRanges: [], completedThrough: null, coverageFrom: null, lastAuditDay: null };
}
function laneState(hourly, lane = "direct") {
  return hourly.lanes[lane];
}
function mirrorDirect(hourly) {
  const direct = laneState(hourly);
  for (const key of ["latestPlannedThrough", "completedRanges", "completedThrough", "coverageFrom", "lastAuditDay", "lastAuditAt", "lastAuditRange"]) hourly[key] = direct[key] ?? null;
  for (const [key, source] of Object.entries({ nextRunAt: "latestNextRunAt", lastAttemptAt: "latestAttemptAt", lastSuccessAt: "latestSuccessAt", lastDataAt: "latestDataAt", lastError: "latestError", latestWindow: "latestWindow" })) {
    if (Object.hasOwn(direct, source)) hourly[key] = direct[source] ?? null;
  }
}
function hourlyCheckpoint(sync, at) {
  const hourly = copy(sync.hourly || {});
  const changed = hourly.queryPolicy !== DISCOVERY_QUERY_POLICY;
  hourly.version = 4;
  hourly.target = TARGET;
  hourly.method = "search";
  hourly.pendingWindows = Array.isArray(hourly.pendingWindows) ? hourly.pendingWindows : [];
  hourly.completedRanges = Array.isArray(hourly.completedRanges) ? hourly.completedRanges : [];
  hourly.gaps = Array.isArray(hourly.gaps) ? hourly.gaps : [];
  if (changed) {
    const previous = hourly.pendingWindows;
    hourly.policyHistory = [...hourly.policyHistory || [], {
      at,
      queryPolicy: hourly.queryPolicy || "legacy-unfiltered",
      completedThrough: hourly.completedThrough || null,
      completedRangeCount: hourly.completedRanges.length,
      pendingWindows: previous.map((value) => ({
        start: value.start,
        endExclusive: value.endExclusive,
        discoveryLane: value.discoveryLane || "direct",
        method: value.method || "mentions",
        hadCursor: !!value.cursor
      }))
    }].slice(-3);
    hourly.pendingWindows = previous.map((value) => ({ ...hourlyWindow(Date.parse(value.start), Date.parse(value.endExclusive), value.kind || "policy-recovery"), audit: value.audit === true || value.kind === "audit" }));
    hourly.lanes = Object.fromEntries(DISCOVERY_LANES.map((lane) => [lane, emptyLane()]));
    hourly.lanes.direct.latestPlannedThrough = timestamp(hourly.latestPlannedThrough);
    hourly.catchupLaneIndex = 0;
  } else {
    hourly.lanes ||= {};
    for (const lane of DISCOVERY_LANES) {
      if (!hourly.lanes[lane]) hourly.lanes[lane] = lane === "direct" ? {
        ...emptyLane(),
        latestPlannedThrough: hourly.latestPlannedThrough,
        completedRanges: hourly.completedRanges,
        completedThrough: hourly.completedThrough,
        coverageFrom: hourly.coverageFrom,
        lastAuditDay: hourly.lastAuditDay,
        lastAuditAt: hourly.lastAuditAt,
        lastAuditRange: hourly.lastAuditRange
      } : emptyLane();
    }
    hourly.pendingWindows = hourly.pendingWindows.map((value) => ({ ...value, discoveryLane: value.discoveryLane || "direct" }));
  }
  for (const lane of DISCOVERY_LANES) {
    const value = laneState(hourly, lane);
    if (lane === "direct") {
      for (const [key, source] of Object.entries({ latestNextRunAt: "nextRunAt", latestNextAttemptAt: "nextAttemptAt", latestAttemptAt: "lastAttemptAt", latestSuccessAt: "lastSuccessAt", latestDataAt: "lastDataAt", latestError: "lastError", latestWindow: "latestWindow" })) {
        if (!Object.hasOwn(value, key)) value[key] = hourly[source] ?? (key === "latestNextRunAt" ? sync.nextRunAt : null);
      }
    }
    value.completedRanges = Array.isArray(value.completedRanges) ? value.completedRanges : [];
    for (const key of ["latestPlannedThrough", "completedThrough", "coverageFrom", "lastAttemptAt", "lastSuccessAt", "lastDataAt", "latestNextRunAt", "latestNextAttemptAt", "latestAttemptAt", "latestSuccessAt", "latestDataAt", "latestContinuationAttemptAt", "latestContinuationAt"]) value[key] = timestamp(value[key]);
    value.latestError ||= null;
    value.latestWindow ||= null;
    value.latestContinuationError ||= null;
    for (const window2 of hourly.pendingWindows.filter((window3) => window3.discoveryLane === lane)) if (!value.coverageFrom || Date.parse(window2.start) < Date.parse(value.coverageFrom)) value.coverageFrom = window2.start;
  }
  hourly.queryPolicy = DISCOVERY_QUERY_POLICY;
  if (!Object.hasOwn(hourly, "providerNextAttemptAt") && [sync.lastError, hourly.lastError, hourly.catchupLastError].some((error) => error?.code === "RATE_LIMITED" || error?.diagnosticCode === "RATE_LIMITED")) hourly.providerNextAttemptAt = timestamp(hourly.nextAttemptAt) || timestamp(sync.nextRunAt);
  for (const key of ["requestCount", "searchPages", "latestPages", "freshPages", "freshRequestCount", "catchupPages", "addedPosts", "splitWindows"]) hourly[key] = Number.isInteger(hourly[key]) && hourly[key] >= 0 ? hourly[key] : 0;
  hourly.catchupRequestCount = Number.isInteger(hourly.catchupRequestCount) && hourly.catchupRequestCount >= 0 ? hourly.catchupRequestCount : hourly.catchupPages;
  for (const key of ["lastAttemptAt", "lastSuccessAt", "lastDataAt", "nextRunAt", "nextAttemptAt", "providerNextAttemptAt", "catchupLastAttemptAt", "catchupLastSuccessAt"]) hourly[key] = timestamp(hourly[key]);
  hourly.lastError ||= null;
  hourly.catchupLastError ||= null;
  hourly.catchupNextAttemptAt = hourly.nextAttemptAt;
  mirrorDirect(hourly);
  sync.hourly = hourly;
  return hourly;
}
function appendHourlyWindow(hourly, value) {
  if (!hourly.pendingWindows.some((window2) => window2.id === value.id || window2.queryPolicy === value.queryPolicy && window2.discoveryLane === value.discoveryLane && window2.method === value.method && window2.start === value.start && window2.endExclusive === value.endExclusive)) hourly.pendingWindows.push(value);
  const state = laneState(hourly, value.discoveryLane);
  if (!state.coverageFrom || Date.parse(value.start) < Date.parse(state.coverageFrom)) state.coverageFrom = value.start;
}
function migrateHourlyRecent(sync, hourly) {
  if (hourly.migratedLegacyRecent) return;
  const old = sync.discovery.recentWindow;
  if (old && timestamp(old.start) && timestamp(old.endExclusive) && Date.parse(old.start) < Date.parse(old.endExclusive)) appendHourlyWindow(hourly, hourlyWindow(Date.parse(old.start), Date.parse(old.endExclusive), "legacy-recent"));
  hourly.migratedLegacyRecent = true;
}
function prepareHourlyAudit(hourly, nowMs) {
  const day2 = new Date(nowMs).toISOString().slice(0, 10);
  for (const lane of DISCOVERY_LANES) {
    const state = laneState(hourly, lane);
    if (state.lastAuditDay === day2 || hourly.pendingWindows.some((value) => value.discoveryLane === lane && (value.kind === "audit" || value.audit === true))) continue;
    const until = Math.floor(nowMs / 1e3) * 1e3 - HOUR, from = until - 71 * HOUR;
    for (let point = from; point < until; ) {
      const end = Math.min(until, Math.floor(point / DAY) * DAY + DAY);
      appendHourlyWindow(hourly, { ...hourlyWindow(point, end, "audit", "search", lane), audit: true });
      point = end;
    }
    state.lastAuditDay = day2;
    state.lastAuditAt = new Date(nowMs).toISOString();
    state.lastAuditRange = { start: new Date(from).toISOString(), endExclusive: new Date(until).toISOString() };
  }
}
function prepareHourlyLatest(sync, hourly, nowMs, lane = "direct") {
  const until = Math.floor(nowMs / 1e3) * 1e3;
  const state = laneState(hourly, lane);
  const previous = Date.parse(state.latestPlannedThrough) || (lane === "direct" ? Date.parse(sync.discovery.recentThrough) || Date.parse(sync.discovery.recentWindow?.endExclusive) : NaN);
  if (Number.isFinite(previous) && previous >= until) {
    return hourly.pendingWindows.find((window2) => window2.discoveryLane === lane && window2.kind === "latest" && window2.cursor === "" && window2.start === state.latestRange?.start && window2.endExclusive === state.latestRange?.endExclusive) || null;
  }
  const from = Math.floor(Math.max(until - HOUR - INTERVAL, Number.isFinite(previous) ? previous - INTERVAL : until - HOUR - INTERVAL) / 1e3) * 1e3;
  if (Number.isFinite(previous) && previous < from) {
    for (let point = previous; point < from; ) {
      const end = Math.min(from, Math.floor(point / DAY) * DAY + DAY);
      appendHourlyWindow(hourly, hourlyWindow(point, end, "outage", "search", lane));
      point = end;
    }
  }
  const value = hourlyWindow(from, until, "latest", "search", lane);
  appendHourlyWindow(hourly, value);
  state.latestPlannedThrough = value.endExclusive;
  state.latestRange = { start: value.start, endExclusive: value.endExclusive };
  state.latestContinuationError = null;
  state.latestContinuationWindow = null;
  return hourly.pendingWindows.find((window2) => window2.id === value.id);
}
function chooseHourlyFresh(hourly, lane = "direct") {
  const latest = laneState(hourly, lane).latestRange;
  if (!timestamp(latest?.start) || !timestamp(latest?.endExclusive)) return null;
  return hourly.pendingWindows.filter((window2) => window2.discoveryLane === lane && !window2.audit && window2.kind !== "audit" && Date.parse(window2.start) >= Date.parse(latest.start) && Date.parse(window2.endExclusive) <= Date.parse(latest.endExclusive)).sort((a, b) => Date.parse(b.start) - Date.parse(a.start) || Date.parse(b.endExclusive) - Date.parse(a.endExclusive))[0] || null;
}
function chooseHourlyCatchup(hourly) {
  const oldest = (values) => [...values].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id))[0];
  if ((hourly.catchupRequestCount + 1) % 6 === 0) {
    const start2 = Number.isInteger(hourly.oldLaneIndex) ? hourly.oldLaneIndex % DISCOVERY_LANES.length : 0;
    for (let offset = 0; offset < DISCOVERY_LANES.length; offset++) {
      const at = (start2 + offset) % DISCOVERY_LANES.length;
      const value = oldest(hourly.pendingWindows.filter((window2) => window2.discoveryLane === DISCOVERY_LANES[at]));
      if (value) {
        hourly.oldLaneIndex = (at + 1) % DISCOVERY_LANES.length;
        return value;
      }
    }
    return null;
  }
  const start = Number.isInteger(hourly.catchupLaneIndex) ? hourly.catchupLaneIndex % DISCOVERY_LANES.length : 0;
  for (let offset = 0; offset < DISCOVERY_LANES.length; offset++) {
    const at = (start + offset) % DISCOVERY_LANES.length, lane = DISCOVERY_LANES[at];
    const values = hourly.pendingWindows.filter((window2) => window2.discoveryLane === lane);
    if (!values.length) continue;
    hourly.catchupLaneIndex = (at + 1) % DISCOVERY_LANES.length;
    const latest = laneState(hourly, lane).latestRange;
    return latest ? [...values].filter((window2) => Date.parse(window2.start) < Date.parse(latest.endExclusive) && Date.parse(window2.endExclusive) > Date.parse(latest.start)).sort((a, b) => Date.parse(b.start) - Date.parse(a.start) || Date.parse(b.endExclusive) - Date.parse(a.endExclusive))[0] || oldest(values) : oldest(values);
  }
  return null;
}
function hourlyGap(sync, hourly, value) {
  hourly.gaps.push(value);
  addGap(sync, { ...value, source: "hourly-discovery" });
}
function replaceHourlyWithSplit(sync, hourly, index, window2, code, at, details = {}) {
  const from = Date.parse(window2.start), until = Date.parse(window2.endExclusive), lane = window2.discoveryLane || "direct";
  if (until - from >= 2 * HOURLY_MIN_WINDOW) {
    const middle = Math.floor((from + until) / 2e3) * 1e3;
    hourly.pendingWindows.splice(index, 1, { ...hourlyWindow(from, middle, "recovery", window2.method || "search", lane), audit: !!window2.audit }, { ...hourlyWindow(middle, until, "recovery", window2.method || "search", lane), audit: !!window2.audit });
    hourly.splitWindows++;
    return "split";
  }
  hourlyGap(sync, hourly, { code, at, discoveryLane: lane, start: window2.start, endExclusive: window2.endExclusive, ...details });
  hourly.pendingWindows.splice(index, 1);
  return "gap";
}
function hourlyKnownMissing(dataset, window2, state) {
  const seen = new Set(window2.observedPostIds || []), from = Date.parse(window2.start), until = Date.parse(window2.endExclusive);
  return dataset.posts.filter((post) => (import_model.default.countablePost ? import_model.default.countablePost(post, state).eligible : import_model.default.postEligibility(post).eligible && post.relevance?.status !== "review") && !seen.has(post.id) && Date.parse(post.publishedAt) >= from && Date.parse(post.publishedAt) < until && typeof post.authorHandle === "string" && post.authorHandle.toLowerCase() !== TARGET.toLowerCase() && matchesDiscoveryLane(post, window2.discoveryLane || "direct")).length;
}
function compactRanges(ranges) {
  const result = [];
  for (const range of [...ranges].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    const last = result.at(-1);
    if (last && Date.parse(range.start) <= Date.parse(last.endExclusive)) last.endExclusive = new Date(Math.max(Date.parse(last.endExclusive), Date.parse(range.endExclusive))).toISOString();
    else result.push({ start: range.start, endExclusive: range.endExclusive });
  }
  return result;
}
function promoteHourlyCoverage(hourly, lane = "direct") {
  const state = laneState(hourly, lane);
  state.completedRanges = compactRanges(state.completedRanges);
  let point = Date.parse(state.completedThrough || state.coverageFrom);
  if (!Number.isFinite(point)) return;
  const initial = point;
  for (; ; ) {
    const next = state.completedRanges.reduce((end, range) => Date.parse(range.start) <= point && Date.parse(range.endExclusive) > end ? Date.parse(range.endExclusive) : end, point);
    if (next === point) break;
    point = next;
  }
  if (point > initial || state.completedThrough) state.completedThrough = new Date(point).toISOString();
}
async function advanceHourlyDiscovery(workbench, { client, now, maxRequests = 1, lane = "latest", discoveryLane = "direct" } = {}) {
  let dataset = import_model.default.validateDataset(copy(workbench.dataset));
  let state = import_model.default.validateState(copy(workbench.state || import_model.default.initialState()));
  const nowMs = instant2(now), at = new Date(nowMs).toISOString();
  const sync = initialSync(workbench.sync, nowMs), result = () => {
    if (sync.hourly?.lanes) mirrorDirect(sync.hourly);
    return { dataset, state, sync };
  };
  if (!["latest", "fresh", "catchup"].includes(lane) || !DISCOVERY_LANES.includes(discoveryLane) || !Number.isInteger(maxRequests) || maxRequests < 0) throw new Error("Invalid hourly discovery action.");
  if (!sync.enabled) {
    sync.status = "disabled";
    return result();
  }
  if (sync.paused || maxRequests === 0) return result();
  const hourly = hourlyCheckpoint(sync, at);
  const selected = laneState(hourly, discoveryLane);
  if (hourly.providerNextAttemptAt && Date.parse(hourly.providerNextAttemptAt) > nowMs) return result();
  const due = lane === "latest" ? selected.latestNextRunAt : lane === "fresh" ? selected.latestNextAttemptAt : hourly.nextAttemptAt;
  if (due && Date.parse(due) > nowMs) return result();
  migrateHourlyRecent(sync, hourly);
  const chosen = lane === "latest" ? prepareHourlyLatest(sync, hourly, nowMs, discoveryLane) : lane === "fresh" ? chooseHourlyFresh(hourly, discoveryLane) : chooseHourlyCatchup(hourly);
  if (lane === "latest") prepareHourlyAudit(hourly, nowMs);
  if (!chosen) return result();
  const index = hourly.pendingWindows.indexOf(chosen), window2 = copy(chosen);
  if (index < 0 || !timestamp(window2.start) || !timestamp(window2.endExclusive) || Date.parse(window2.start) >= Date.parse(window2.endExclusive) || typeof window2.cursor !== "string" || !Array.isArray(window2.seenCursors)) throw new Error("Invalid checkpoint.");
  const method = window2.method || "search";
  if (!["search", "mentions"].includes(method) || !client || typeof client[method === "mentions" ? "mentionsPage" : "searchPage"] !== "function") throw new Error("A read-only collection client is required.");
  const latestDueBefore = hourly.nextRunAt || sync.nextRunAt;
  const queryLane = window2.discoveryLane || "direct", queryState = laneState(hourly, queryLane);
  const continuation = lane === "fresh";
  const nextHour = () => new Date((Math.floor(nowMs / HOUR) + 1) * HOUR).toISOString();
  const spacing = () => new Date(nowMs + CATCHUP_SPACING).toISOString();
  const preserveDirectSchedule = () => {
    mirrorDirect(hourly);
    if (!sync.paused) sync.nextRunAt = hourly.nextRunAt || latestDueBefore;
  };
  const recordWindow = () => {
    queryState.lastWindow = { ...snapshot };
    if (lane === "latest") queryState.latestWindow = { ...snapshot };
    else if (continuation) queryState.latestContinuationWindow = { ...snapshot };
  };
  sync.phase = "discovery";
  sync.activeLane = "hourly-" + lane;
  sync.lastAttemptAt = at;
  sync.requestCount++;
  hourly.requestCount++;
  queryState.lastAttemptAt = at;
  if (lane === "latest") queryState.latestAttemptAt = at;
  else if (continuation) {
    queryState.latestContinuationAttemptAt = at;
    hourly.freshRequestCount++;
  } else {
    hourly.catchupLastAttemptAt = at;
    hourly.catchupRequestCount++;
  }
  const snapshot = { start: window2.start, endExclusive: window2.endExclusive, method, lane, discoveryLane: queryLane, status: "pending" };
  hourly.lastWindow = snapshot;
  recordWindow();
  try {
    const query = window2.query || discoveryQuery(window2.start, window2.endExclusive, window2.queryPolicy || "legacy-unfiltered", queryLane);
    const page = method === "mentions" ? await client.mentionsPage({ userName: TARGET, sinceTime: Math.floor(Date.parse(window2.start) / 1e3), untilTime: Math.floor(Date.parse(window2.endExclusive) / 1e3), cursor: window2.cursor }) : await client.searchPage({ query, cursor: window2.cursor });
    if (!page || !Array.isArray(page.tweets) || typeof page.hasNextPage !== "boolean") throw new Error("Invalid discovery response.");
    const incoming = normalizedPage(page.tweets, at, window2);
    const oldIds = new Set(dataset.posts.map((post) => post.id));
    const merged = mergeDataset(dataset, incoming), migrated = import_model.default.reconcileImport(dataset, merged, state);
    const times = page.tweets.map((tweet) => Date.parse(tweet.createdAt)).filter(Number.isFinite);
    const cycle = page.hasNextPage && (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor === window2.cursor || window2.seenCursors.includes(page.nextCursor));
    const jumped = window2.previousOldest !== null && times.length && Math.max(...times) > window2.previousOldest;
    const empty = page.hasNextPage && !page.tweets.length;
    dataset = merged;
    state = migrated;
    const added = incoming.posts.filter((post) => !oldIds.has(post.id)).length;
    hourly.searchPages++;
    hourly[lane === "latest" ? "latestPages" : continuation ? "freshPages" : "catchupPages"]++;
    hourly.addedPosts += added;
    hourly.lastPageAdded = added;
    window2.observedPostIds = [.../* @__PURE__ */ new Set([...window2.observedPostIds || [], ...incoming.posts.map((post) => post.id)])];
    delete window2.consecutiveTimeouts;
    snapshot.returnedPosts = incoming.posts.length;
    snapshot.addedPosts = added;
    if (cycle || jumped || empty) snapshot.status = replaceHourlyWithSplit(sync, hourly, index, window2, cycle ? "CURSOR_CYCLE" : jumped ? "PAGINATION_ORDER" : "EMPTY_CONTINUATION", at);
    else if (page.hasNextPage) {
      window2.cursor = page.nextCursor;
      window2.previousOldest = times.length ? Math.min(...times) : window2.previousOldest;
      window2.seenCursors = [...window2.seenCursors, page.nextCursor].slice(-1e3);
      hourly.pendingWindows[index] = window2;
    } else {
      const missing = hourlyKnownMissing(dataset, window2, state);
      if (missing) {
        snapshot.status = replaceHourlyWithSplit(sync, hourly, index, window2, "KNOWN_POST_NOT_RETURNED", at, { count: missing });
      } else {
        hourly.pendingWindows.splice(index, 1);
        queryState.completedRanges.push({ start: window2.start, endExclusive: window2.endExclusive });
        snapshot.status = "complete";
        promoteHourlyCoverage(hourly, queryLane);
      }
    }
    sync.lastSuccessAt = at;
    sync.lastError = null;
    sync.consecutiveFailures = 0;
    sync.status = "running";
    queryState.lastSuccessAt = at;
    queryState.lastError = null;
    recordWindow();
    if (incoming.posts.length) queryState.lastDataAt = at;
    if (incoming.posts.length) {
      sync.lastDataAt = at;
      if (lane !== "catchup") queryState.latestDataAt = at;
    }
    if (lane === "latest") {
      queryState.latestSuccessAt = at;
      queryState.latestError = null;
      queryState.latestNextRunAt = nextHour();
    } else if (continuation) {
      queryState.latestContinuationAt = at;
      queryState.latestContinuationError = null;
    } else {
      hourly.catchupLastSuccessAt = at;
      hourly.catchupLastError = null;
    }
    hourly.nextAttemptAt = spacing();
    if (lane !== "catchup") queryState.latestNextAttemptAt = spacing();
    preserveDirectSchedule();
  } catch (error) {
    if (error?.code === "INVALID_RESPONSE" && error?.message === "\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u043A\u0443\u0440\u0441\u043E\u0440 \u043D\u0430\u0441\u0442\u0443\u043F\u043D\u043E\u0457 \u0441\u0442\u043E\u0440\u0456\u043D\u043A\u0438.") {
      snapshot.status = replaceHourlyWithSplit(sync, hourly, index, window2, "CURSOR_CYCLE", at);
      hourly.lastAnomaly = { code: "CURSOR_CYCLE", at };
      hourly.nextAttemptAt = spacing();
      if (lane === "latest") queryState.latestNextRunAt = nextHour();
      if (lane !== "catchup") queryState.latestNextAttemptAt = spacing();
      recordWindow();
      preserveDirectSchedule();
      hourly.catchupNextAttemptAt = hourly.nextAttemptAt;
      return result();
    }
    recordError(sync, error, nowMs);
    snapshot.status = "error";
    queryState.lastError = copy(sync.lastError);
    recordWindow();
    hourly.nextAttemptAt = sync.nextRunAt;
    if (sync.lastError.code === "RATE_LIMITED" || sync.lastError.diagnosticCode === "RATE_LIMITED") hourly.providerNextAttemptAt = sync.nextRunAt;
    if (lane === "latest") {
      queryState.latestError = copy(sync.lastError);
      queryState.latestNextRunAt = new Date(Math.max(Date.parse(nextHour()), Date.parse(sync.nextRunAt))).toISOString();
    } else if (continuation) queryState.latestContinuationError = copy(sync.lastError);
    else hourly.catchupLastError = copy(sync.lastError);
    if (lane !== "catchup") queryState.latestNextAttemptAt = sync.nextRunAt;
    preserveDirectSchedule();
    if (sync.lastError?.diagnosticCode === "REQUEST_TIMEOUT" && !sync.paused) {
      window2.consecutiveTimeouts = (window2.consecutiveTimeouts || 0) + 1;
      hourly.pendingWindows[index] = window2;
      if (window2.consecutiveTimeouts >= 2) {
        snapshot.status = replaceHourlyWithSplit(sync, hourly, index, window2, "REQUEST_TIMEOUT", at);
        hourly.lastAnomaly = { code: "REQUEST_TIMEOUT", at };
        sync.consecutiveFailures = 0;
        sync.lastError = null;
        sync.status = "running";
        hourly.nextAttemptAt = spacing();
        if (lane !== "catchup") queryState.latestNextAttemptAt = spacing();
        if (continuation) queryState.latestContinuationError = null;
        else if (lane === "catchup") hourly.catchupLastError = null;
        recordWindow();
      }
    } else if (window2.consecutiveTimeouts) {
      delete window2.consecutiveTimeouts;
      hourly.pendingWindows[index] = window2;
    }
  }
  hourly.catchupNextAttemptAt = hourly.nextAttemptAt;
  return result();
}

// source/backfill.mjs
var import_model2 = __toESM(require_model(), 1);
var TARGET2 = "entropyIO";
var DAY2 = 864e5;
var MIN_WINDOW = 3e5;
var SPACING = 5100;
var SNOWFLAKE_EPOCH = 1288834974657n;
var collectionMethods = /* @__PURE__ */ new Set(["search", "mentions", "id-search"]);
var copy2 = (value) => JSON.parse(JSON.stringify(value));
var activeStatuses = /* @__PURE__ */ new Set(["running", "waiting"]);
var finishedStatuses = /* @__PURE__ */ new Set(["complete", "complete-with-gaps"]);
function time(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) throw new Error("Invalid backfill " + label + ".");
  const day2 = value.slice(0, 10), midnight = Date.parse(day2 + "T00:00:00Z");
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day2) throw new Error("Invalid backfill " + label + ".");
  if (value.length > 10 && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) throw new Error("Backfill times require a timezone.");
  const result = Date.parse(value.length === 10 ? value + "T00:00:00Z" : value);
  if (!Number.isFinite(result)) throw new Error("Invalid backfill " + label + ".");
  return result;
}
function nowTime(input) {
  const value = typeof input === "function" ? input() : input ?? /* @__PURE__ */ new Date();
  const result = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(result)) throw new Error("Invalid backfill clock.");
  return result;
}
function validate(workbench) {
  return {
    dataset: import_model2.default.validateDataset(copy2(workbench.dataset)),
    state: import_model2.default.validateState(copy2(workbench.state || import_model2.default.initialState())),
    sync: copy2(workbench.sync || {})
  };
}
function window(start, endExclusive, method = "search", queryPolicy = DISCOVERY_QUERY_POLICY, discoveryLane = "direct") {
  const from = new Date(start).toISOString(), until = new Date(endExclusive).toISOString();
  const filters = [DISCOVERY_QUERY_POLICY, "original-tweets-v1"].includes(queryPolicy) ? " -filter:replies -filter:nativeretweets" : "";
  return {
    start: from,
    endExclusive: until,
    queryPolicy,
    discoveryLane,
    query: method === "id-search" ? discoveryTerms(discoveryLane, queryPolicy) + filters + " since_id:" + idBound(start) + " max_id:" + idBound(endExclusive) : discoveryQuery(from, until, queryPolicy, discoveryLane),
    cursor: "",
    previousOldest: null,
    seenCursors: []
  };
}
function dailyWindows(start, end, method, lanes) {
  const result = [];
  for (let point = start; point < end; ) {
    const next = Math.min(end, Math.floor(point / DAY2) * DAY2 + DAY2);
    for (const lane of lanes) result.push(window(point, next, method, DISCOVERY_QUERY_POLICY, lane));
    point = next;
  }
  return result;
}
function requestLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 1e3) throw new Error("Backfill requestLimit must be an integer from 1 to 1000.");
  return value;
}
function idBound(timestamp2) {
  const milliseconds = BigInt(timestamp2);
  if (milliseconds < SNOWFLAKE_EPOCH) throw new Error("ID-search bounds must be after the X Snowflake epoch.");
  return ((milliseconds - SNOWFLAKE_EPOCH << 22n) - 1n).toString();
}
function beginBackfill(workbench, { start, endExclusive, requestLimit: limit = 250, method = "search", lanes, now } = {}) {
  const result = validate(workbench), nowMs = nowTime(now);
  if (!collectionMethods.has(method)) throw new Error("Invalid backfill method.");
  const selected = lanes === void 0 ? method === "mentions" ? ["direct"] : [...DISCOVERY_LANES] : lanes;
  if (!Array.isArray(selected) || !selected.length || selected.some((lane) => !DISCOVERY_LANES.includes(lane)) || new Set(selected).size !== selected.length || method === "mentions" && selected.some((lane) => lane !== "direct")) throw new Error("Invalid backfill lanes.");
  const selectedLanes = DISCOVERY_LANES.filter((lane) => selected.includes(lane));
  const from = Math.floor(time(start, "start") / 1e3) * 1e3;
  const until = Math.floor(time(endExclusive, "end") / 1e3) * 1e3;
  limit = requestLimit(limit);
  if (until <= from || until - from > 62 * DAY2 || until > nowMs) throw new Error("Backfill range must be in the past and span at most 62 days.");
  if (method === "id-search") {
    idBound(from);
    idBound(until);
  }
  if (result.sync.enabled !== true) throw new Error("Enable the collector before starting a backfill.");
  if (result.sync.paused === true) throw new Error("Resume the collector before starting a backfill.");
  const startIso = new Date(from).toISOString(), endIso = new Date(until).toISOString();
  const id = "backfill:" + DISCOVERY_QUERY_POLICY + ":" + selectedLanes.join(",") + ":" + method + ":" + startIso + ":" + endIso;
  const existing = result.sync.backfill;
  if (existing && existing.id === id && existing.queryPolicy === DISCOVERY_QUERY_POLICY) {
    if (!Number.isInteger(existing.requestCount) || existing.requestCount < 0) throw new Error("Invalid backfill checkpoint.");
    existing.method ||= "search";
    existing.requestLimit = Math.max(requestLimit(existing.requestLimit), limit);
    if (finishedStatuses.has(existing.status)) return result;
    if (existing.requestCount >= existing.requestLimit) existing.status = "request-limit";
    else if (existing.status === "request-limit" || existing.status === "paused") {
      existing.status = "running";
      existing.pauseReason = null;
      existing.nextAttemptAt = new Date(Math.max(nowMs, Date.parse(existing.nextAttemptAt) || 0)).toISOString();
    }
    return result;
  }
  if (existing && activeStatuses.has(existing.status)) throw new Error("A different backfill is already in progress.");
  const windows = dailyWindows(from, until, method, selectedLanes), at = new Date(nowMs).toISOString();
  result.sync.backfill = {
    version: 3,
    id,
    method,
    lanes: selectedLanes,
    queryPolicy: DISCOVERY_QUERY_POLICY,
    target: TARGET2,
    start: startIso,
    endExclusive: endIso,
    status: "running",
    requestCount: 0,
    requestLimit: limit,
    successfulPages: 0,
    addedPosts: 0,
    observedPostIds: [],
    observedByLane: Object.fromEntries(selectedLanes.map((lane) => [lane, []])),
    measuredPages: 0,
    pageStatsStartedAt: null,
    lastPageStats: null,
    fetchedRawTweets: 0,
    fetchedNormalizedNonReposts: 0,
    fetchedInRangeMentions: 0,
    initialWindows: windows.length,
    completedWindows: 0,
    pendingWindows: windows,
    completedRanges: [],
    gaps: [],
    splitWindows: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    nextAttemptAt: at,
    startedAt: at,
    finishedAt: null,
    pauseReason: null
  };
  return result;
}
function normalizePage(tweets, observedAt, current) {
  const raw = normalizeTweets(tweets, { observedAt, query: current.query || "@" + TARGET2 });
  return { data: normalizeDiscoveryPage(tweets, observedAt, current), normalizedNonReposts: raw.posts.length };
}
function appendGap(sync, job, gap) {
  job.gaps.push(gap);
  sync.gaps = [...Array.isArray(sync.gaps) ? sync.gaps : [], { ...gap, source: "accelerated-backfill" }].slice(-50);
}
function missingKnownPosts(result, range, legacyOnly = false) {
  const job = result.sync.backfill, lane = range.discoveryLane || "direct", observed = new Set(job.observedByLane?.[lane] || job.observedPostIds || []);
  const from = Date.parse(range.start), until = Date.parse(range.endExclusive), startedAt = Date.parse(job.startedAt);
  return result.dataset.posts.filter((post) => {
    const published = Date.parse(post.publishedAt), measured = Date.parse(post.metricsAsOf);
    return (import_model2.default.countablePost ? import_model2.default.countablePost(post, result.state).eligible : import_model2.default.postEligibility(post).eligible && post.relevance?.status !== "review") && published >= from && published < until && !observed.has(post.id) && typeof post.authorHandle === "string" && post.authorHandle.toLowerCase() !== TARGET2.toLowerCase() && matchesDiscoveryLane(post, lane) && (!legacyOnly || !Number.isFinite(measured) || measured < startedAt);
  }).length;
}
function recordKnownGap(result, range, at, legacyOnly = false) {
  const { sync } = result, job = sync.backfill, count2 = missingKnownPosts(result, range, legacyOnly);
  if (!count2) return;
  const matches = (gap) => gap.code === "KNOWN_POST_NOT_RETURNED" && gap.start === range.start && gap.endExclusive === range.endExclusive && (gap.discoveryLane || "direct") === (range.discoveryLane || "direct");
  const existing = job.gaps.find(matches);
  if (existing) {
    existing.count = Math.max(existing.count || 0, count2);
    const mirror = (sync.gaps || []).find(matches);
    if (mirror) mirror.count = existing.count;
  } else appendGap(sync, job, { code: "KNOWN_POST_NOT_RETURNED", count: count2, at, discoveryLane: range.discoveryLane || "direct", start: range.start, endExclusive: range.endExclusive });
}
function auditCompletedKnownPosts(result, at) {
  for (const range of result.sync.backfill.completedRanges || []) recordKnownGap(result, range, at, true);
}
function splitOrGap(sync, job, current, code, at) {
  job.consecutiveTimeouts = 0;
  job.timeoutWindow = null;
  const from = Date.parse(current.start), until = Date.parse(current.endExclusive);
  if (until - from >= 2 * MIN_WINDOW) {
    const middle = Math.floor((from + until) / 2e3) * 1e3;
    job.pendingWindows.splice(0, 1, window(from, middle, job.method || "search", job.queryPolicy || "legacy-unfiltered", current.discoveryLane || "direct"), window(middle, until, job.method || "search", job.queryPolicy || "legacy-unfiltered", current.discoveryLane || "direct"));
    job.splitWindows++;
  } else {
    appendGap(sync, job, { code, at, discoveryLane: current.discoveryLane || "direct", start: current.start, endExclusive: current.endExclusive });
    job.pendingWindows.shift();
  }
}
function keepUncoveredWindow(current, from, until) {
  const a = Date.parse(current.start), b = Date.parse(current.endExclusive);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [current];
  if (b <= from || a >= until) return [current];
  const result = [];
  if (a < from) result.push(window(a, from));
  if (b > until) result.push(window(until, b));
  return result;
}
function finish(result, nowMs) {
  const { sync } = result, job = sync.backfill, at = new Date(nowMs).toISOString();
  auditCompletedKnownPosts(result, at);
  job.finishedAt = at;
  job.nextAttemptAt = null;
  job.status = job.gaps.length ? "complete-with-gaps" : "complete";
  if (job.gaps.length) return;
  if (Array.isArray(job.lanes) && !job.lanes.includes("direct")) return;
  const from = Date.parse(job.start), until = Date.parse(job.endExclusive);
  const discovery = sync.discovery ||= { pendingWindows: [], coveredThrough: null };
  const pending = Array.isArray(discovery.pendingWindows) ? discovery.pendingWindows : [];
  discovery.pendingWindows = pending.flatMap((value) => keepUncoveredWindow(value, from, until));
  const priorGap = discovery.pendingWindows.some((value) => Date.parse(value.start) < from);
  const oldCovered = Date.parse(discovery.coveredThrough) || 0;
  if (!priorGap) discovery.coveredThrough = new Date(Math.max(oldCovered, until)).toISOString();
  const previousRecent = Date.parse(discovery.recentThrough) || 0;
  if (!priorGap) {
    discovery.recentThrough = new Date(Math.max(previousRecent, until)).toISOString();
    const recentFrom = Date.parse(discovery.recentFrom);
    discovery.recentFrom = new Date(Number.isFinite(recentFrom) ? Math.min(recentFrom, from) : from).toISOString();
    if (discovery.recentWindow && Date.parse(discovery.recentWindow.endExclusive) <= until) discovery.recentWindow = null;
    else if (discovery.recentWindow && Date.parse(discovery.recentWindow.start) < until) {
      discovery.recentWindow = window(Math.max(Date.parse(discovery.recentWindow.start), until - MIN_WINDOW), Date.parse(discovery.recentWindow.endExclusive));
    }
  }
  discovery.nextLane = "recent";
  sync.phase = "discovery";
  sync.nextRunAt = at;
}
function failure(result, error, nowMs) {
  const { sync } = result, job = sync.backfill, at = new Date(nowMs).toISOString();
  const httpStatus = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null;
  const code = [401, 403].includes(httpStatus) ? "AUTH_REQUIRED" : httpStatus === 402 ? "CREDITS_EXHAUSTED" : httpStatus === 429 ? "RATE_LIMITED" : "BACKFILL_FAILED";
  job.consecutiveFailures = (job.consecutiveFailures || 0) + 1;
  const wait = Math.min(36e5, 3e4 * 2 ** Math.min(job.consecutiveFailures - 1, 7));
  job.lastError = {
    code,
    httpStatus,
    ...classifySyncError(error),
    at,
    message: "The history page was not committed. Existing data and its checkpoint were retained."
  };
  job.status = [401, 402, 403].includes(httpStatus) ? "paused" : "waiting";
  job.nextAttemptAt = new Date(nowMs + wait).toISOString();
  sync.lastError = job.lastError;
  sync.status = job.status === "paused" ? "paused" : "error";
  if (job.status === "paused") sync.paused = true;
  const current = job.pendingWindows[0];
  if (job.lastError.diagnosticCode === "REQUEST_TIMEOUT" && current) {
    const key = (current.discoveryLane || "direct") + "/" + current.start + "/" + current.endExclusive + "/" + current.cursor;
    job.consecutiveTimeouts = job.timeoutWindow === key ? (job.consecutiveTimeouts || 0) + 1 : 1;
    job.timeoutWindow = key;
    if (job.consecutiveTimeouts >= 2) {
      splitOrGap(sync, job, current, "REQUEST_TIMEOUT", at);
      job.consecutiveFailures = 0;
      job.status = "running";
      sync.status = "running";
      job.nextAttemptAt = new Date(nowMs + SPACING).toISOString();
      if (!job.pendingWindows.length) finish(result, nowMs);
      else if (job.requestCount >= job.requestLimit) {
        job.status = "request-limit";
        job.nextAttemptAt = null;
      }
    }
  } else {
    job.consecutiveTimeouts = 0;
    job.timeoutWindow = null;
  }
}
async function advanceBackfill(workbench, { client, now } = {}) {
  const result = validate(workbench), { sync } = result, job = sync.backfill;
  const nowMs = nowTime(now), at = new Date(nowMs).toISOString();
  if (!job || !activeStatuses.has(job.status)) return result;
  if (sync.enabled !== true || sync.paused === true) {
    job.pauseReason = sync.paused ? "COLLECTOR_PAUSED" : "COLLECTOR_DISABLED";
    return result;
  }
  job.pauseReason = null;
  if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > nowMs) return result;
  if (!Number.isInteger(job.requestCount) || job.requestCount < 0 || !Array.isArray(job.pendingWindows)) throw new Error("Invalid backfill checkpoint.");
  requestLimit(job.requestLimit);
  if (!job.pendingWindows.length) {
    finish(result, nowMs);
    return result;
  }
  if (job.requestCount >= job.requestLimit) {
    job.status = "request-limit";
    job.nextAttemptAt = null;
    return result;
  }
  auditCompletedKnownPosts(result, at);
  const current = copy2(job.pendingWindows[0]);
  const method = job.method || "search";
  if (!collectionMethods.has(method)) throw new Error("Invalid backfill method checkpoint.");
  if (!client || typeof client[method === "mentions" ? "mentionsPage" : "searchPage"] !== "function") throw new Error("A read-only collection client is required.");
  const from = time(current.start, "checkpoint start"), until = time(current.endExclusive, "checkpoint end");
  if (until <= from || typeof current.cursor !== "string" || !Array.isArray(current.seenCursors)) throw new Error("Invalid backfill checkpoint.");
  if (method === "id-search") {
    idBound(from);
    idBound(until);
  }
  job.lastAttemptAt = at;
  job.requestCount++;
  sync.lastAttemptAt = at;
  sync.requestCount = (Number.isInteger(sync.requestCount) ? sync.requestCount : 0) + 1;
  try {
    const query = current.query || window(from, until, method, job.queryPolicy || "legacy-unfiltered", current.discoveryLane || "direct").query;
    const page = method === "mentions" ? await client.mentionsPage({ userName: TARGET2, sinceTime: Math.floor(from / 1e3), untilTime: Math.floor(until / 1e3), cursor: current.cursor }) : await client.searchPage({ query, cursor: current.cursor });
    if (!page || !Array.isArray(page.tweets) || typeof page.hasNextPage !== "boolean") throw new Error("Invalid discovery response.");
    const times = page.tweets.map((tweet) => Date.parse(tweet?.createdAt)).filter(Number.isFinite);
    job.lastPageStats = {
      discoveryLane: current.discoveryLane || "direct",
      rawTweets: page.tweets.length,
      normalizedNonReposts: null,
      inRangeMentions: null,
      oldest: times.length ? new Date(Math.min(...times)).toISOString() : null,
      newest: times.length ? new Date(Math.max(...times)).toISOString() : null
    };
    job.measuredPages = (job.measuredPages || 0) + 1;
    job.pageStatsStartedAt ||= at;
    job.fetchedRawTweets = (job.fetchedRawTweets || 0) + page.tweets.length;
    const normalized = normalizePage(page.tweets, at, current), incoming = normalized.data;
    job.lastPageStats.normalizedNonReposts = normalized.normalizedNonReposts;
    job.lastPageStats.inRangeMentions = incoming.posts.length;
    job.fetchedNormalizedNonReposts = (job.fetchedNormalizedNonReposts || 0) + normalized.normalizedNonReposts;
    job.fetchedInRangeMentions = (job.fetchedInRangeMentions || 0) + incoming.posts.length;
    const merged = mergeDataset(result.dataset, incoming), migrated = import_model2.default.reconcileImport(result.dataset, merged, result.state);
    const oldIds = new Set(result.dataset.posts.map((post) => post.id));
    const added = incoming.posts.filter((post) => !oldIds.has(post.id)).length;
    const cycle = page.hasNextPage && (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor === current.cursor || current.seenCursors.includes(page.nextCursor));
    const jump = current.previousOldest !== null && times.length && Math.max(...times) > current.previousOldest;
    const empty = page.hasNextPage && !page.tweets.length;
    result.dataset = merged;
    result.state = migrated;
    job.observedPostIds = [.../* @__PURE__ */ new Set([...job.observedPostIds || [], ...incoming.posts.map((post) => post.id)])];
    if (job.queryPolicy === DISCOVERY_QUERY_POLICY) {
      job.observedByLane ||= {};
      const lane = current.discoveryLane || "direct";
      job.observedByLane[lane] = [.../* @__PURE__ */ new Set([...job.observedByLane[lane] || [], ...incoming.posts.map((post) => post.id)])];
    }
    job.successfulPages++;
    job.addedPosts += added;
    job.lastPageAdded = added;
    job.lastSuccessAt = at;
    job.lastError = null;
    job.consecutiveFailures = 0;
    job.consecutiveTimeouts = 0;
    job.timeoutWindow = null;
    job.status = "running";
    job.nextAttemptAt = new Date(nowMs + SPACING).toISOString();
    sync.lastSuccessAt = at;
    sync.lastError = null;
    sync.consecutiveFailures = 0;
    sync.status = "running";
    if (incoming.posts.length) sync.lastDataAt = at;
    if (cycle || jump || empty) splitOrGap(sync, job, current, cycle ? "CURSOR_CYCLE" : jump ? "PAGINATION_ORDER" : "EMPTY_CONTINUATION", at);
    else if (page.hasNextPage) {
      current.cursor = page.nextCursor;
      current.previousOldest = times.length ? Math.min(...times) : current.previousOldest;
      current.seenCursors = [...current.seenCursors, page.nextCursor].slice(-1e3);
      if ((job.lanes || []).length > 1) {
        job.pendingWindows.shift();
        job.pendingWindows.push(current);
      } else job.pendingWindows[0] = current;
    } else {
      recordKnownGap(result, current, at);
      job.pendingWindows.shift();
      job.completedWindows++;
      job.completedRanges.push({ start: current.start, endExclusive: current.endExclusive, discoveryLane: current.discoveryLane || "direct" });
    }
    if (!job.pendingWindows.length) finish(result, nowMs);
    else if (job.requestCount >= job.requestLimit) {
      job.status = "request-limit";
      job.nextAttemptAt = null;
    }
  } catch (error) {
    if (error?.code === "INVALID_RESPONSE" && error?.message === "\u041D\u0435\u043A\u043E\u0440\u0435\u043A\u0442\u043D\u0438\u0439 \u043A\u0443\u0440\u0441\u043E\u0440 \u043D\u0430\u0441\u0442\u0443\u043F\u043D\u043E\u0457 \u0441\u0442\u043E\u0440\u0456\u043D\u043A\u0438.") {
      splitOrGap(sync, job, current, "CURSOR_CYCLE", at);
      job.paginationRetries = (job.paginationRetries || 0) + 1;
      job.status = "running";
      job.nextAttemptAt = new Date(nowMs + SPACING).toISOString();
      job.lastError = null;
      sync.lastError = null;
      sync.status = "running";
      if (!job.pendingWindows.length) finish(result, nowMs);
      else if (job.requestCount >= job.requestLimit) {
        job.status = "request-limit";
        job.nextAttemptAt = null;
      }
    } else failure(result, error, nowMs);
  }
  return result;
}

// source/seed.json
var seed_default = {
  meta: {
    source: "historical-sample",
    asOf: "2026-11-17",
    coverage: "partial",
    periodStart: "2026-10-17",
    periodEndExclusive: "2026-11-17",
    sourceNote: "\u041C\u0435\u0442\u0440\u0438\u043A\u0438 \u0432\u0440\u0443\u0447\u043D\u0443 \u0437\u0432\u0456\u0440\u0435\u043D\u0456 \u043D\u0430 \u0441\u0442\u043E\u0440\u0456\u043D\u043A\u0430\u0445 X 17.11.2026; \u0446\u0435 \u043D\u0430\u043A\u043E\u043F\u0438\u0447\u0435\u043D\u0456 \u043B\u0456\u0447\u0438\u043B\u044C\u043D\u0438\u043A\u0438, \u043D\u0435 \u0437\u0440\u0456\u0437\u0438 \u0447\u0435\u0440\u0435\u0437 72 \u0433\u043E\u0434\u0438\u043D\u0438.",
    identityNote: "sample:<handle> \u2014 \u043B\u043E\u043A\u0430\u043B\u044C\u043D\u0456 \u0456\u0434\u0435\u043D\u0442\u0438\u0444\u0456\u043A\u0430\u0442\u043E\u0440\u0438 \u0432\u0438\u0431\u0456\u0440\u043A\u0438, \u043D\u0435 \u0441\u043F\u0440\u0430\u0432\u0436\u043D\u0456 X User ID.",
    limitations: [
      "24 \u043F\u043E\u0441\u0442\u0438 \u0434\u0435\u0432\u2019\u044F\u0442\u0438 \u0430\u0432\u0442\u043E\u0440\u0456\u0432; \u043F\u043E\u0432\u043D\u043E\u0442\u0430 \u043C\u0456\u0441\u044F\u0447\u043D\u043E\u0433\u043E \u0432\u043D\u0435\u0441\u043A\u0443 \u043D\u0435 \u0432\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0430.",
      "\u0422\u043E\u0447\u043D\u0438\u0439 \u0447\u0430\u0441 \u043F\u0443\u0431\u043B\u0456\u043A\u0430\u0446\u0456\u0439 \u043D\u0435 \u0437\u0431\u0435\u0440\u0435\u0436\u0435\u043D\u0438\u0439. date \u043C\u0456\u0441\u0442\u0438\u0442\u044C \u0432\u0456\u0434\u043E\u043C\u0443 \u0434\u0430\u0442\u0443; publishedAt \u0434\u043E\u0440\u0456\u0432\u043D\u044E\u0454 null.",
      "\u0412\u0456\u0434\u0441\u0443\u0442\u043D\u0456 API retweet_count \u0456 quote_count. uiReposts \u0437\u0431\u0435\u0440\u0456\u0433\u0430\u0454 \u043E\u043A\u0440\u0435\u043C\u0438\u0439 \u0432\u0438\u0434\u0438\u043C\u0438\u0439 \u043B\u0456\u0447\u0438\u043B\u044C\u043D\u0438\u043A X \u0442\u0430 \u043D\u0435 \u043F\u0456\u0434\u0441\u0442\u0430\u0432\u043B\u044F\u0454\u0442\u044C\u0441\u044F \u0437\u0430\u043C\u0456\u0441\u0442\u044C reposts.",
      "\u041D\u0435\u0432\u0456\u0434\u043E\u043C\u0456 followers, smart followers \u0442\u0430 smart engagement. \u041E\u0446\u0456\u043D\u043A\u0443 \u043E\u0440\u0433\u0430\u043D\u0456\u0447\u043D\u043E\u0441\u0442\u0456 \u043D\u0435 \u043F\u0440\u043E\u0432\u0435\u0434\u0435\u043D\u043E.",
      "\u0423 seed \u0437\u0431\u0435\u0440\u0435\u0436\u0435\u043D\u0456 \u043A\u043E\u0440\u043E\u0442\u043A\u0456 \u043E\u043F\u0438\u0441\u0438; body \u0434\u043E\u0440\u0456\u0432\u043D\u044E\u0454 null, \u043E\u0441\u043A\u0456\u043B\u044C\u043A\u0438 \u043F\u043E\u0432\u043D\u0438\u0439 \u0442\u0435\u043A\u0441\u0442 \u043D\u0435 \u0432\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0439 \u0434\u043E \u0446\u0456\u0454\u0457 \u0432\u0438\u0431\u0456\u0440\u043A\u0438."
    ]
  },
  authors: [
    {
      id: "sample:linie_oo",
      handle: "linie_oo",
      displayName: "linie_oo",
      followers: null,
      smartFollowersComplete: false,
      smartEngagementComplete: false
    },
    {
      id: "sample:louisdives",
      handle: "louisdives",
      displayName: "louisdives",
      followers: null,
      smartFollowersComplete: false,
      smartEngagementComplete: false
    },
    {
      id: "sample:nftmufettisi",
      handle: "nftmufettisi",
      displayName: "nftmufettisi",
      followers: null,
      smartFollowersComplete: false,
      smartEngagementComplete: false
    },
    {
      id: "sample:said116dao",
      handle: "said116dao",
      displayName: "said116dao",
      followers: null,
      smartFollowersComplete: false,
      smartEngagementComplete: false
    },
    {
      id: "sample:magsimich",
      handle: "magsimich",
      displayName: "magsimich",
      followers: null,
      smartFollowersComplete: false,
      smartEngagementComplete: false
    },
    {
      id: "sample:whimsioracle",
      handle: "whimsioracle",
      displayName: "whimsioracle",
      followers: null,
      smartFollowersComplete: false,
      smartEngagementComplete: false
    },
    {
      id: "sample:lordyonx",
      handle: "lordyonx",
      displayName: "lordyonx",
      followers: null,
      smartFollowersComplete: false,
      smartEngagementComplete: false
    },
    {
      id: "sample:gyanxbt",
      handle: "gyanxbt",
      displayName: "gyanxbt",
      followers: null,
      smartFollowersComplete: false,
      smartEngagementComplete: false
    },
    {
      id: "sample:ebash_creator",
      handle: "ebash_creator",
      displayName: "ebash_creator",
      followers: null,
      smartFollowersComplete: false,
      smartEngagementComplete: false
    }
  ],
  posts: [
    {
      id: "2113234760927494175",
      authorId: "sample:linie_oo",
      authorHandle: "linie_oo",
      date: "2026-10-22",
      publishedAt: null,
      url: "https://x.com/linie_oo/status/2113234760927494175",
      summary: "\u041F\u0435\u0440\u0435\u043A\u0430\u0437 \u043F\u0440\u043E \u0432\u0435\u043B\u0438\u043A\u043E\u0433\u043E \u0442\u0440\u0435\u0439\u0434\u0435\u0440\u0430 HYPE, \u044F\u043A\u0438\u0439 \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u043E\u0432\u0443\u0454 Entropy.",
      body: null,
      metrics: {
        impressions: 2085,
        likes: 42,
        uiReposts: 2,
        reposts: null,
        quotes: null,
        replies: 16,
        bookmarks: 12
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2115461407051231374",
      authorId: "sample:linie_oo",
      authorHandle: "linie_oo",
      date: "2026-10-28",
      publishedAt: null,
      url: "https://x.com/linie_oo/status/2115461407051231374",
      summary: "NVDA \u043D\u0430 Entropy: 25\xD7 \u0456 \u0442\u043E\u0440\u0433\u043E\u0432\u0456 \u043A\u0430\u0442\u0430\u043B\u0456\u0437\u0430\u0442\u043E\u0440\u0438; \u0446\u0438\u0442\u0430\u0442\u0430 \u043E\u0444\u0456\u0446\u0456\u0439\u043D\u043E\u0433\u043E \u0430\u043D\u043E\u043D\u0441\u0443.",
      body: null,
      metrics: {
        impressions: 519,
        likes: 33,
        uiReposts: 0,
        reposts: null,
        quotes: null,
        replies: 18,
        bookmarks: 16
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2117274045234200608",
      authorId: "sample:linie_oo",
      authorHandle: "linie_oo",
      date: "2026-11-02",
      publishedAt: null,
      url: "https://x.com/linie_oo/status/2117274045234200608",
      summary: "\u0417\u0440\u043E\u0441\u0442\u0430\u043D\u043D\u044F Entropy \u0434\u043E \u043F\u043E\u043D\u0430\u0434 $100M OI; \u0446\u0438\u0442\u0443\u0454 \u043E\u0444\u0456\u0446\u0456\u0439\u043D\u0438\u0439 \u0430\u043D\u043E\u043D\u0441.",
      body: null,
      metrics: {
        impressions: 518,
        likes: 41,
        uiReposts: 0,
        reposts: null,
        quotes: null,
        replies: 15,
        bookmarks: 11
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2118714431047651657",
      authorId: "sample:linie_oo",
      authorHandle: "linie_oo",
      date: "2026-11-06",
      publishedAt: null,
      url: "https://x.com/linie_oo/status/2118714431047651657",
      summary: "\u041F\u043E\u0440\u0456\u0432\u043D\u044F\u043D\u043D\u044F OI \u0440\u0438\u043D\u043A\u0443 Anthropic \u043C\u0456\u0436 Entropy \u0442\u0430 \u0456\u043D\u0448\u0438\u043C\u0438 \u043C\u0430\u0439\u0434\u0430\u043D\u0447\u0438\u043A\u0430\u043C\u0438.",
      body: null,
      metrics: {
        impressions: 1594,
        likes: 44,
        uiReposts: 1,
        reposts: null,
        quotes: null,
        replies: 13,
        bookmarks: 12
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2119820561496813926",
      authorId: "sample:linie_oo",
      authorHandle: "linie_oo",
      date: "2026-11-09",
      publishedAt: null,
      url: "https://x.com/linie_oo/status/2119820561496813926",
      summary: "OI \u0442\u0430 \u043E\u0431\u0441\u044F\u0433\u0438 Entropy, \u0437\u0432\u2019\u044F\u0437\u043E\u043A \u0437 \u043E\u0447\u0456\u043A\u0443\u0432\u0430\u043D\u043D\u044F\u043C IPO Anthropic.",
      body: null,
      metrics: {
        impressions: 1746,
        likes: 56,
        uiReposts: 1,
        reposts: null,
        quotes: null,
        replies: 21,
        bookmarks: 15
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2120542192213033467",
      authorId: "sample:linie_oo",
      authorHandle: "linie_oo",
      date: "2026-11-11",
      publishedAt: null,
      url: "https://x.com/linie_oo/status/2120542192213033467",
      summary: "\u041F\u043E\u0437\u0438\u0446\u0456\u044F Entropy \u0441\u0435\u0440\u0435\u0434 perp DEX \u0437\u0430 OI \u0442\u0430 \u0440\u043E\u0437\u0448\u0438\u0440\u0435\u043D\u043D\u044F \u0440\u0438\u043D\u043A\u0456\u0432.",
      body: null,
      metrics: {
        impressions: 1483,
        likes: 54,
        uiReposts: 1,
        reposts: null,
        quotes: null,
        replies: 17,
        bookmarks: 17
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2121254988097712224",
      authorId: "sample:linie_oo",
      authorHandle: "linie_oo",
      date: "2026-11-13",
      publishedAt: null,
      url: "https://x.com/linie_oo/status/2121254988097712224",
      summary: "NVDA: \u0442\u043E\u0440\u0433\u043E\u0432\u0438\u0439 \u043E\u0431\u0441\u044F\u0433 \u043D\u0430 Entropy \u0442\u0430 \u043A\u043E\u0440\u043F\u043E\u0440\u0430\u0442\u0438\u0432\u043D\u0456 \u043D\u043E\u0432\u0438\u043D\u0438.",
      body: null,
      metrics: {
        impressions: 1182,
        likes: 39,
        uiReposts: 0,
        reposts: null,
        quotes: null,
        replies: 19,
        bookmarks: 10
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2121974990157312027",
      authorId: "sample:linie_oo",
      authorHandle: "linie_oo",
      date: "2026-11-15",
      publishedAt: null,
      url: "https://x.com/linie_oo/status/2121974990157312027",
      summary: "\u0420\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442\u0438 \u0442\u0440\u0435\u0439\u0434\u0435\u0440\u0430 \u0432 \u043B\u0456\u0434\u0435\u0440\u0431\u043E\u0440\u0434\u0456 Entropy; \u043F\u043E\u0441\u0438\u043B\u0430\u043D\u043D\u044F \u043D\u0430 \u043F\u0440\u043E\u0444\u0456\u043B\u044C.",
      body: null,
      metrics: {
        impressions: 496,
        likes: 31,
        uiReposts: 0,
        reposts: null,
        quotes: null,
        replies: 15,
        bookmarks: 12
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2117153879939068344",
      authorId: "sample:louisdives",
      authorHandle: "louisdives",
      date: "2026-11-02",
      publishedAt: null,
      url: "https://x.com/louisdives/status/2117153879939068344",
      summary: "\u0412\u043B\u0430\u0441\u043D\u0438\u0439 MM-\u0431\u043E\u0442 \u043D\u0430 Entropy: \u043A\u0430\u043F\u0456\u0442\u0430\u043B, \u043E\u0431\u0441\u044F\u0433, PnL \u0456 cashback.",
      body: null,
      metrics: {
        impressions: 15797,
        likes: 177,
        uiReposts: 1,
        reposts: null,
        quotes: null,
        replies: 34,
        bookmarks: 124
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2117289924085096628",
      authorId: "sample:louisdives",
      authorHandle: "louisdives",
      date: "2026-11-02",
      publishedAt: null,
      url: "https://x.com/louisdives/status/2117289924085096628",
      summary: "\u041E\u043D\u043E\u0432\u043B\u0435\u043D\u043D\u044F MM-\u0435\u043A\u0441\u043F\u0435\u0440\u0438\u043C\u0435\u043D\u0442\u0443 \u0437 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442\u0430\u043C\u0438 \u0439 \u0442\u043E\u0440\u0433\u043E\u0432\u0438\u043C\u0438 \u043F\u0430\u0440\u0430\u043C\u0438.",
      body: null,
      metrics: {
        impressions: 4328,
        likes: 60,
        uiReposts: 2,
        reposts: null,
        quotes: null,
        replies: 20,
        bookmarks: 17
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2118258320083697751",
      authorId: "sample:louisdives",
      authorHandle: "louisdives",
      date: "2026-11-05",
      publishedAt: null,
      url: "https://x.com/louisdives/status/2118258320083697751",
      summary: "\u0420\u043E\u0437\u0431\u0456\u0440 CPM \u0431\u043E\u0442\u0430 \u0437\u0430\u043B\u0435\u0436\u043D\u043E \u0432\u0456\u0434 \u0447\u0430\u0441\u0443, \u043B\u0456\u043A\u0432\u0456\u0434\u043D\u043E\u0441\u0442\u0456 \u0439 \u0432\u043E\u043B\u0430\u0442\u0438\u043B\u044C\u043D\u043E\u0441\u0442\u0456.",
      body: null,
      metrics: {
        impressions: 1144,
        likes: 26,
        uiReposts: 0,
        reposts: null,
        quotes: null,
        replies: 7,
        bookmarks: 9
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2119467622605717639",
      authorId: "sample:louisdives",
      authorHandle: "louisdives",
      date: "2026-11-08",
      publishedAt: null,
      url: "https://x.com/louisdives/status/2119467622605717639",
      summary: "\u0421\u0430\u0439\u0442 \u0456 \u043F\u043E\u0440\u0442\u0444\u0435\u043B\u044C \u0434\u043B\u044F \u0442\u0435\u0441\u0442\u0443\u0432\u0430\u043D\u043D\u044F MM-\u0431\u043E\u0442\u0430 \u043D\u0430 Entropy \u0442\u0430 Arcus.",
      body: null,
      metrics: {
        impressions: 11437,
        likes: 84,
        uiReposts: 4,
        reposts: null,
        quotes: null,
        replies: 15,
        bookmarks: 46
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2120149395870236993",
      authorId: "sample:louisdives",
      authorHandle: "louisdives",
      date: "2026-11-10",
      publishedAt: null,
      url: "https://x.com/louisdives/status/2120149395870236993",
      summary: "\u0420\u0456\u0437\u043D\u0438\u0446\u044F CPM SNDK \u0437\u0430 \u0433\u043E\u0434\u0438\u043D\u0430\u043C\u0438 \u0442\u0430 \u0437\u043C\u0456\u043D\u0430 \u0430\u0433\u0440\u0435\u0441\u0438\u0432\u043D\u043E\u0441\u0442\u0456 \u0431\u043E\u0442\u0430.",
      body: null,
      metrics: {
        impressions: 1854,
        likes: 32,
        uiReposts: 0,
        reposts: null,
        quotes: null,
        replies: 4,
        bookmarks: 10
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2116561681283170702",
      authorId: "sample:nftmufettisi",
      authorHandle: "nftmufettisi",
      date: "2026-10-31",
      publishedAt: null,
      url: "https://x.com/nftmufettisi/status/2116561681283170702",
      summary: "\u041E\u0433\u043B\u044F\u0434 \u0434\u0432\u043E\u0445 \u0440\u0430\u043D\u043D\u0456\u0445 \u043F\u043B\u0430\u0442\u0444\u043E\u0440\u043C: QFEX \u0456 Entropy.",
      body: null,
      metrics: {
        impressions: 15489,
        likes: 114,
        uiReposts: 6,
        reposts: null,
        quotes: null,
        replies: 70,
        bookmarks: 17
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2116802429497025020",
      authorId: "sample:nftmufettisi",
      authorHandle: "nftmufettisi",
      date: "2026-11-01",
      publishedAt: null,
      url: "https://x.com/nftmufettisi/status/2116802429497025020",
      summary: "Watchlist \u0434\u0435\u0432\u2019\u044F\u0442\u0438 perp DEX, \u0437\u043E\u043A\u0440\u0435\u043C\u0430 Entropy.",
      body: null,
      metrics: {
        impressions: 14999,
        likes: 105,
        uiReposts: 9,
        reposts: null,
        quotes: null,
        replies: 62,
        bookmarks: 8
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2117276093119947032",
      authorId: "sample:said116dao",
      authorHandle: "said116dao",
      date: "2026-11-02",
      publishedAt: null,
      url: "https://x.com/said116dao/status/2117276093119947032",
      summary: "OI Entropy \u0437\u0430 \u0434\u0432\u0430 \u043C\u0456\u0441\u044F\u0446\u0456 \u0442\u0430 \u043F\u043E\u0440\u0456\u0432\u043D\u044F\u043D\u043D\u044F \u0437 \u0456\u043D\u0448\u0438\u043C\u0438 \u043F\u043B\u0430\u0442\u0444\u043E\u0440\u043C\u0430\u043C\u0438.",
      body: null,
      metrics: {
        impressions: 628,
        likes: 25,
        uiReposts: 0,
        reposts: null,
        quotes: null,
        replies: 1,
        bookmarks: 6
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2119390250061435052",
      authorId: "sample:said116dao",
      authorHandle: "said116dao",
      date: "2026-11-08",
      publishedAt: null,
      url: "https://x.com/said116dao/status/2119390250061435052",
      summary: "\u0417\u0430\u043F\u0438\u0442\u0430\u043D\u043D\u044F \u043F\u0440\u043E \u0443\u043B\u044E\u0431\u043B\u0435\u043D\u0438\u0439 perp DEX \u0437 \u0432\u0438\u0431\u043E\u0440\u043E\u043C Entropy.",
      body: null,
      metrics: {
        impressions: 3751,
        likes: 42,
        uiReposts: 3,
        reposts: null,
        quotes: null,
        replies: 14,
        bookmarks: 5
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2116222007872507935",
      authorId: "sample:magsimich",
      authorHandle: "magsimich",
      date: "2026-10-30",
      publishedAt: null,
      url: "https://x.com/magsimich/status/2116222007872507935",
      summary: "\u041F\u0430\u0434\u0456\u043D\u043D\u044F RDDT \u0456 \u043F\u043E\u0441\u0438\u043B\u0430\u043D\u043D\u044F \u043D\u0430 \u0440\u0438\u043D\u043E\u043A Reddit \u0437 leverage \u043D\u0430 Entropy.",
      body: null,
      metrics: {
        impressions: 239,
        likes: 4,
        uiReposts: 0,
        reposts: null,
        quotes: null,
        replies: null,
        bookmarks: 0
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2116797386635071835",
      authorId: "sample:magsimich",
      authorHandle: "magsimich",
      date: "2026-11-01",
      publishedAt: null,
      url: "https://x.com/magsimich/status/2116797386635071835",
      summary: "\u0420\u043E\u0437\u0431\u0456\u0440 \u0436\u043E\u0432\u0442\u043D\u0435\u0432\u0438\u0445 fees, cost of revenue \u0442\u0430 gross profit Entropy.",
      body: null,
      metrics: {
        impressions: 152,
        likes: 9,
        uiReposts: 1,
        reposts: null,
        quotes: null,
        replies: 6,
        bookmarks: 1
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2114759512775147963",
      authorId: "sample:whimsioracle",
      authorHandle: "whimsioracle",
      date: "2026-10-26",
      publishedAt: null,
      url: "https://x.com/whimsioracle/status/2114759512775147963",
      summary: "\u0421\u0430\u043C\u043E\u0437\u0430\u044F\u0432\u0430 \u043F\u0440\u043E \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 ANTH Short \u0456 \u043A\u043E\u0440\u043E\u0442\u043A\u0430 \u043A\u0440\u0438\u0442\u0438\u0447\u043D\u0430 \u0434\u0443\u043C\u043A\u0430.",
      body: null,
      metrics: {
        impressions: 59,
        likes: 2,
        uiReposts: 0,
        reposts: null,
        quotes: null,
        replies: null,
        bookmarks: 0
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2117600625978396877",
      authorId: "sample:whimsioracle",
      authorHandle: "whimsioracle",
      date: "2026-11-03",
      publishedAt: null,
      url: "https://x.com/whimsioracle/status/2117600625978396877",
      summary: "\u0421\u0430\u043C\u043E\u0437\u0430\u044F\u0432\u0430 \u043F\u0440\u043E \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442 ANTH Long \u0456 \u0440\u0435\u0444\u0435\u0440\u0430\u043B\u044C\u043D\u0435 \u043F\u043E\u0441\u0438\u043B\u0430\u043D\u043D\u044F.",
      body: null,
      metrics: {
        impressions: 46,
        likes: 0,
        uiReposts: 0,
        reposts: null,
        quotes: null,
        replies: null,
        bookmarks: 0
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2113268729303769488",
      authorId: "sample:lordyonx",
      authorHandle: "lordyonx",
      date: "2026-10-22",
      publishedAt: null,
      url: "https://x.com/lordyonx/status/2113268729303769488",
      summary: "\u0412\u0441\u0442\u0443\u043F \u0434\u043E Entropy \u0442\u0430 \u043F\u0440\u0438\u043A\u043B\u0430\u0434 \u0432\u0435\u043B\u0438\u043A\u043E\u0433\u043E \u0442\u0440\u0435\u0439\u0434\u0435\u0440\u0430.",
      body: null,
      metrics: {
        impressions: 1088,
        likes: 16,
        uiReposts: 0,
        reposts: null,
        quotes: null,
        replies: 1,
        bookmarks: 0
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2117288202155479089",
      authorId: "sample:gyanxbt",
      authorHandle: "gyanxbt",
      date: "2026-11-02",
      publishedAt: null,
      url: "https://x.com/gyanxbt/status/2117288202155479089",
      summary: "$100M OI Entropy \u0442\u0430 \u043A\u043E\u0440\u043E\u0442\u043A\u0430 \u0437\u0433\u0430\u0434\u043A\u0430 DN/MM-\u0441\u0442\u0440\u0430\u0442\u0435\u0433\u0456\u0439.",
      body: null,
      metrics: {
        impressions: 50,
        likes: 0,
        uiReposts: 0,
        reposts: null,
        quotes: null,
        replies: null,
        bookmarks: 0
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    },
    {
      id: "2120557340415967424",
      authorId: "sample:ebash_creator",
      authorHandle: "ebash_creator",
      date: "2026-11-11",
      publishedAt: null,
      url: "https://x.com/ebash_creator/status/2120557340415967424",
      summary: "\u0417\u0430\u0433\u0430\u043B\u044C\u043D\u0456 \u043C\u0456\u0440\u043A\u0443\u0432\u0430\u043D\u043D\u044F \u043F\u0440\u043E AI/perps \u0437 \u043A\u043E\u0440\u043E\u0442\u043A\u043E\u044E \u0437\u0433\u0430\u0434\u043A\u043E\u044E Entropy \u0442\u0430 Arcus.",
      body: null,
      metrics: {
        impressions: 102,
        likes: 4,
        uiReposts: 0,
        reposts: null,
        quotes: null,
        replies: null,
        bookmarks: 0
      },
      metricsAsOf: "2026-11-17",
      metricsWindow: "cumulative",
      source: "primary-ui-snapshot"
    }
  ],
  accounts: [],
  followRelations: [],
  interactions: []
};
var export_Model = import_model3.default;
export {
  export_Model as Model,
  advanceBackfill,
  advanceHourlyDiscovery,
  advanceSync,
  beginBackfill,
  createClient,
  mergeDataset,
  normalizeDiscoveryPage,
  seed_default as seed
};
